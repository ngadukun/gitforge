// app.ts — the HTTP server: one process serving git smart HTTP, REST v3,
// GraphQL and MCP from the in-memory store. Every reply is JSON (or a git
// content type) — never HTML. Malformed input answers 400 and the server
// stays up.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { Store } from './store.ts';
import { handleRest, isAuthorized } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleUploadPack, handleReceivePack, infoRefsBody } from './gitproto.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

// Git smart-HTTP replies are pure functions of (repo state, request): the
// handlers are deterministic and carry no per-request data (no request ids,
// no clocks). Identical requests against an unchanged repo — the clone
// workload's 50 concurrent clones above all — are therefore served from
// this small cache, keyed by the repo's instance + mutation version, which
// the store bumps on every git-visible change. Cleared wholesale when full.
const GIT_CACHE_LIMIT = 256;
const gitResponseCache = new Map();

function gitCacheGet(key) {
  return gitResponseCache.get(key);
}

function gitCacheSet(key, body) {
  if (gitResponseCache.size >= GIT_CACHE_LIMIT) gitResponseCache.clear();
  gitResponseCache.set(key, body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversize = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering but keep draining the socket so the client gets a
        // clean 413 instead of a torn connection.
        oversize = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversize) {
        const err = new Error('request body too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function lowerHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

function send(res, status, headers, body) {
  const payload = typeof body === 'string' ? body : Buffer.from(body ?? '');
  res.writeHead(status, { ...headers, 'content-length': String(payload.length) });
  res.end(payload);
}

function jsonNotFound(store) {
  return {
    status: 404,
    headers: { 'content-type': 'application/json', 'x-github-request-id': store.nextRequestId() },
    body: JSON.stringify({ message: 'Not Found' }),
  };
}

export function createApp() {
  const store = new Store();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      const headers = lowerHeaders(req);

      // GET /healthz — the boot probe.
      if (method === 'GET' && pathname === '/healthz') {
        send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/graphql
      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          const notFound = jsonNotFound(store);
          send(res, notFound.status, notFound.headers, notFound.body);
          return;
        }
        if (!isAuthorized(headers)) {
          send(res, 401, { 'content-type': 'application/json', 'x-github-request-id': store.nextRequestId() }, JSON.stringify({ message: 'Bad credentials' }));
          return;
        }
        const raw = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          send(res, 400, { 'content-type': 'application/json' }, JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }));
          return;
        }
        const operations = Array.isArray(parsed) ? parsed : [parsed];
        const results = operations.map((operation) => {
          if (operation === null || typeof operation !== 'object' || typeof operation.query !== 'string') {
            return { data: null, errors: [{ message: 'GraphQL operation needs a query string' }] };
          }
          return executeGraphQL(store, operation);
        });
        send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(Array.isArray(parsed) ? results : results[0]));
        return;
      }

      // POST /mcp
      if (pathname === '/mcp') {
        if (method !== 'POST') {
          const notFound = jsonNotFound(store);
          send(res, notFound.status, notFound.headers, notFound.body);
          return;
        }
        const raw = await readBody(req);
        const result = handleMcp(store, { headers, body: raw });
        send(res, result.status, result.headers, result.body);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const suffix = gitMatch[3] ?? '';
        const repo = store.getRepo(owner, repoName);
        if (repo === null) {
          send(res, 404, { 'content-type': 'text/plain' }, 'Not Found');
          return;
        }
        if (method === 'GET' && suffix === '/info/refs') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            send(res, 400, { 'content-type': 'text/plain' }, 'unknown service');
            return;
          }
          const version2 = headers['git-protocol'] === 'version=2';
          const cacheKey = `info|${repo.instance}|${repo.version}|${service}|${version2 ? 2 : 0}`;
          let body = gitCacheGet(cacheKey);
          if (body === undefined) {
            body = infoRefsBody(store, repo, service, version2);
            gitCacheSet(cacheKey, body);
          }
          send(res, 200, { 'content-type': `application/x-${service}-advertisement` }, body);
          return;
        }
        if (method === 'POST' && suffix === '/git-upload-pack') {
          const raw = await readBody(req);
          try {
            const version2 = headers['git-protocol'] === 'version=2';
            const bodyHash = createHash('sha1').update(raw).digest('hex');
            const cacheKey = `up|${repo.instance}|${repo.version}|${version2 ? 2 : 0}|${bodyHash}`;
            let body = gitCacheGet(cacheKey);
            if (body === undefined) {
              body = handleUploadPack(store, repo, raw, version2);
              gitCacheSet(cacheKey, body);
            }
            send(res, 200, { 'content-type': 'application/x-git-upload-pack-result' }, body);
          } catch (err) {
            send(res, 400, { 'content-type': 'text/plain' }, err instanceof Error ? err.message : String(err));
          }
          return;
        }
        if (method === 'POST' && suffix === '/git-receive-pack') {
          const raw = await readBody(req);
          try {
            const body = handleReceivePack(store, repo, raw);
            // A receive-pack may have stored objects even where every ref
            // update was refused (setRef/deleteRef bump on their own when
            // they change something); invalidate cached git replies either
            // way so a later fetch can never miss what the pack brought in.
            repo.version += 1;
            send(res, 200, { 'content-type': 'application/x-git-receive-pack-result' }, body);
          } catch (err) {
            send(res, 400, { 'content-type': 'text/plain' }, err instanceof Error ? err.message : String(err));
          }
          return;
        }
        const notFound = jsonNotFound(store);
        send(res, notFound.status, notFound.headers, notFound.body);
        return;
      }

      // REST v3: /api/v3/...
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const raw = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? await readBody(req) : Buffer.alloc(0);
        const query = url.searchParams;
        const result = handleRest(store, {
          method,
          pathname,
          query,
          headers,
          body: raw,
          host: req.headers.host ?? '127.0.0.1',
        });
        send(res, result.status, result.headers, result.body);
        return;
      }

      const notFound = jsonNotFound(store);
      send(res, notFound.status, notFound.headers, notFound.body);
    } catch (err) {
      // A request must never take the server down: answer and keep serving.
      // An oversize body is a 413; anything else is a 400.
      const status = err instanceof Error && err.statusCode === 413 ? 413 : 400;
      try {
        send(res, status, { 'content-type': 'text/plain' }, err instanceof Error ? err.message : String(err));
      } catch {
        // The socket is already gone; nothing more to do.
      }
    }
  });

  return server;
}
