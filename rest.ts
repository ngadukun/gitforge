// rest.ts — the GitHub REST v3 surface under /api/v3.
// The endpoint contract is checks-rest.ts's header comment: exact statuses,
// JSON everywhere, X-GitHub-Request-Id on every reply, 401 without a token,
// 404 (never 403) for another owner's repositories.

import { Store, VIEWER, hashObject, parseCommit, globalId, ZERO_OID } from './store.ts';

const FIXED_DATE = '2025-01-01T00:00:00Z';

export function isAuthorized(headers) {
  const auth = headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true; // local practice
  return token === expected;
}

function jsonResponse(store, status, value, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-github-request-id': store.nextRequestId(),
    ...extraHeaders,
  };
  return { status, headers, body: value === null ? '' : JSON.stringify(value) };
}

function errorResponse(store, status, message) {
  return jsonResponse(store, status, { message });
}

function repoJson(repo) {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `https://github.com/${repo.full_name}`,
    url: `/api/v3/repos/${repo.full_name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function issueJson(issue) {
  return {
    id: issue.id,
    node_id: globalId('issue', `${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    user: issue.user,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    comments: issue.comments.length,
  };
}

function pullJson(pull) {
  return {
    id: pull.id,
    node_id: globalId('pr', `${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: pull.user,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
  };
}

function commentJson(comment) {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: comment.user,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

function commitJson(store, repo, oid) {
  const object = store.getObject(repo, oid);
  const message = object !== null && object.type === 'commit' ? parseCommit(object.data).message : '';
  return {
    sha: oid,
    commit: {
      message,
      author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_DATE },
      committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_DATE },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

// Parse a JSON request body; returns {ok, value} or {ok:false} on malformed JSON.
function parseJsonBody(body) {
  if (body === null || body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function pageParams(query) {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate(items, query) {
  const { perPage, page } = pageParams(query);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), perPage, page, total: items.length };
}

function linkHeader(host, pathname, query, page, perPage, total) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (pageNumber) => `http://${host}${pathname}?per_page=${perPage}&page=${pageNumber}`;
  const parts = [];
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

// Resolve a ref-ish (branch name, full ref, or commit sha) to a commit oid.
function resolveRef(store, repo, ref) {
  if (ref === undefined) return store.refTip(repo, `refs/heads/${repo.default_branch}`);
  let tip = store.refTip(repo, ref);
  if (tip === null && !ref.startsWith('refs/')) tip = store.refTip(repo, `refs/heads/${ref}`);
  if (tip !== null) return tip;
  const object = store.getObject(repo, ref);
  if (object !== null && object.type === 'commit') return ref;
  return null;
}

export function handleRest(store, request) {
  const { method, pathname, query, headers, body, host } = request;
  const segments = pathname.split('/').filter((part) => part !== '');
  // Every /api/v3 route needs the bearer token.
  if (!isAuthorized(headers)) {
    return errorResponse(store, 401, 'Bad credentials');
  }
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') {
    return errorResponse(store, 404, 'Not Found');
  }
  const rest = segments.slice(2);

  const parsed = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? parseJsonBody(body) : { ok: true, value: {} };
  if (!parsed.ok) return errorResponse(store, 400, 'Problems parsing JSON');
  const input = parsed.value;

  // GET /api/v3/
  if (rest.length === 0) {
    if (method !== 'GET') return errorResponse(store, 404, 'Not Found');
    return jsonResponse(store, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    }, { 'x-oauth-scopes': 'repo' });
  }

  // GET /api/v3/user — the token owner's profile (the MCP setup reads it).
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return errorResponse(store, 404, 'Not Found');
    return jsonResponse(store, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      type: 'User',
      name: VIEWER.name,
      email: VIEWER.email,
    });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return errorResponse(store, 404, 'Not Found');
    return jsonResponse(store, 200, { installed_version: '1.0.0' });
  }

  // POST /api/v3/user/repos  |  GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') return errorResponse(store, 422, 'name is required');
      if (store.getRepo(VIEWER.login, name) !== null) {
        return errorResponse(store, 422, 'Repository already exists');
      }
      const created = store.createRepo(VIEWER.login, {
        name,
        private: input.private === true,
        description: typeof input.description === 'string' ? input.description : '',
      });
      return jsonResponse(store, 201, repoJson(created.repo));
    }
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER.login);
      const page = paginate(repos, query);
      const link = linkHeader(host, pathname, query, page.page, page.perPage, page.total);
      return jsonResponse(store, 200, page.items.map(repoJson), { link });
    }
    return errorResponse(store, 404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    // Another owner's repositories are 404, never 403.
    if (owner !== VIEWER.login) return errorResponse(store, 404, 'Not Found');
    const repo = store.getRepo(owner, name);
    const tail = rest.slice(3);

    // GET /repos/{o}/{r} | PATCH | DELETE
    if (tail.length === 0) {
      if (repo === null) return errorResponse(store, 404, 'Not Found');
      if (method === 'GET') return jsonResponse(store, 200, repoJson(repo));
      if (method === 'PATCH') {
        if (typeof input.description === 'string') repo.description = input.description;
        if (input.private === true || input.private === false) repo.private = input.private;
        repo.updated_at = FIXED_DATE;
        return jsonResponse(store, 200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return jsonResponse(store, 204, null);
      }
      return errorResponse(store, 404, 'Not Found');
    }

    if (repo === null) return errorResponse(store, 404, 'Not Found');

    // GET /repos/{o}/{r}/branches
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const branches = store.branches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false }));
      return jsonResponse(store, 200, branches);
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const tip = resolveRef(store, repo, query.get('sha') ?? undefined);
      if (tip === null) return jsonResponse(store, 200, []);
      const walk = store.walk(repo, [tip], {});
      const ordered = [...walk.commits.entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
      return jsonResponse(store, 200, ordered.map((oid) => commitJson(store, repo, oid)));
    }

    // POST /repos/{o}/{r}/git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) {
        return errorResponse(store, 422, 'Invalid ref or sha');
      }
      if (store.getObject(repo, sha) === null) return errorResponse(store, 422, 'Object does not exist');
      if (repo.refs.has(ref)) return errorResponse(store, 422, 'Reference already exists');
      store.setRef(repo, ref, sha);
      return jsonResponse(store, 201, { ref, object: { sha }, url: `/api/v3/repos/${repo.full_name}/git/refs/${encodeURIComponent(ref)}` });
    }

    // /repos/{o}/{r}/contents/{path...}
    if (tail.length >= 1 && tail[0] === 'contents') {
      const path = tail.slice(1).map((part) => decodeURIComponent(part)).join('/');
      return handleContents(store, repo, method, path, query, input);
    }

    // POST /repos/{o}/{r}/labels
    if (tail.length === 1 && tail[0] === 'labels' && method === 'POST') {
      const labelName = typeof input.name === 'string' ? input.name : '';
      if (labelName === '') return errorResponse(store, 422, 'name is required');
      const label = {
        name: labelName,
        color: typeof input.color === 'string' ? input.color : 'ededed',
        description: typeof input.description === 'string' ? input.description : '',
      };
      repo.labels.set(labelName, label);
      return jsonResponse(store, 201, label);
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (tail.length >= 1 && tail[0] === 'issues') {
      return handleIssues(store, repo, method, tail.slice(1), query, input);
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
    if (tail.length >= 1 && tail[0] === 'pulls') {
      return handlePulls(store, repo, method, tail.slice(1), query, input);
    }

    return errorResponse(store, 404, 'Not Found');
  }

  return errorResponse(store, 404, 'Not Found');
}

function handleContents(store, repo, method, path, query, input) {
  const branch = typeof input.branch === 'string' ? input.branch : repo.default_branch;
  const ref = query.get('ref') ?? undefined;

  if (method === 'GET') {
    const tip = resolveRef(store, repo, ref);
    if (tip === null) return errorResponse(store, 404, 'Not Found');
    // Read the tree of the resolved commit directly (the ref may be a sha).
    const flatMap = (() => {
      const object = store.getObject(repo, tip);
      if (object === null || object.type !== 'commit') return new Map();
      return store.flattenTree(repo, parseCommit(object.data).tree, '', new Map());
    })();
    if (path === '') {
      return jsonResponse(store, 200, directoryEntries(store, repo, flatMap, ''));
    }
    const entry = flatMap.get(path);
    if (entry !== undefined) {
      const object = store.getObject(repo, entry.oid);
      const data = object === null ? Buffer.alloc(0) : object.data;
      return jsonResponse(store, 200, {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: entry.oid,
        size: data.length,
        name: path.split('/').pop(),
        path,
      });
    }
    const prefix = `${path}/`;
    const under = [...flatMap.keys()].some((key) => key.startsWith(prefix));
    if (under) return jsonResponse(store, 200, directoryEntries(store, repo, flatMap, path));
    return errorResponse(store, 404, 'Not Found');
  }

  if (method === 'PUT') {
    if (path === '') return errorResponse(store, 422, 'path is required');
    const message = typeof input.message === 'string' ? input.message : 'Update file';
    const content = typeof input.content === 'string' ? Buffer.from(input.content.replace(/[\r\n\t ]+/g, ''), 'base64') : null;
    if (content === null) return errorResponse(store, 422, 'content is required');
    const branchTip = store.refTip(repo, `refs/heads/${branch}`);
    if (branchTip === null && branch !== repo.default_branch) {
      return errorResponse(store, 422, 'branch does not exist');
    }
    const flat = store.flatOfRef(repo, branch);
    const existing = flat.get(path);
    const isUpdate = existing !== undefined;
    if (isUpdate) {
      if (typeof input.sha !== 'string') return errorResponse(store, 422, 'sha is required to update an existing file');
      if (input.sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return errorResponse(store, 409, 'sha does not match the current file');
      }
    }
    const blobOid = hashObject('blob', content);
    const { commitSha } = store.commitFiles(repo, branch, [{ path, data: content }], message);
    return jsonResponse(store, isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const flat = store.flatOfRef(repo, branch);
    const existing = flat.get(path);
    if (existing === undefined) return errorResponse(store, 404, 'Not Found');
    if (typeof input.sha === 'string' && input.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return errorResponse(store, 409, 'sha does not match the current file');
    }
    const message = typeof input.message === 'string' ? input.message : 'Delete file';
    const { commitSha } = store.commitFiles(repo, branch, [{ path, data: null }], message);
    return jsonResponse(store, 200, { commit: { sha: commitSha, message } });
  }

  return errorResponse(store, 404, 'Not Found');
}

function directoryEntries(store, repo, flatMap, dir) {
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map();
  for (const [path, entry] of flatMap) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
    } else {
      const sub = rest.slice(0, slash);
      if (!children.has(sub)) {
        const subFlat = new Map();
        for (const [key, value] of flatMap) {
          if (key.startsWith(`${prefix}${sub}/`)) subFlat.set(key.slice(`${prefix}${sub}/`.length), value);
        }
        const treeOid = store.buildTreeFromFlat(repo, subFlat);
        children.set(sub, { type: 'dir', name: sub, path: `${prefix}${sub}`, sha: treeOid });
      }
    }
  }
  return [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function handleIssues(store, repo, method, tail, query, input) {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') return errorResponse(store, 422, 'title is required');
      const labels = Array.isArray(input.labels) ? input.labels : [];
      for (const label of labels) {
        if (typeof label !== 'string' || !repo.labels.has(label)) {
          return errorResponse(store, 422, 'Label does not exist');
        }
      }
      const issue = store.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '', labels });
      return jsonResponse(store, 201, issueJson(issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const page = paginate(issues, query);
      return jsonResponse(store, 200, page.items.map(issueJson));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  const number = Number.parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return errorResponse(store, 404, 'Not Found');
  const issue = store.getIssue(repo, number);
  if (tail.length === 1) {
    if (method === 'GET') {
      if (issue !== null) return jsonResponse(store, 200, issueJson(issue));
      const pull = store.getPull(repo, number);
      if (pull !== null) {
        // GitHub serves a pull request as an issue too.
        return jsonResponse(store, 200, issueJson({
          id: pull.id,
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          labels: [],
          user: pull.user,
          created_at: pull.created_at,
          updated_at: pull.updated_at,
          comments: [],
        }));
      }
      return errorResponse(store, 404, 'Not Found');
    }
    if (method === 'PATCH') {
      if (issue === null) return errorResponse(store, 404, 'Not Found');
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      return jsonResponse(store, 200, issueJson(issue));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === null) return errorResponse(store, 404, 'Not Found');
    if (method === 'POST') {
      const commentBody = typeof input.body === 'string' ? input.body : '';
      const comment = store.addComment(repo, issue, commentBody);
      return jsonResponse(store, 201, commentJson(comment));
    }
    if (method === 'GET') {
      return jsonResponse(store, 200, issue.comments.map(commentJson));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  return errorResponse(store, 404, 'Not Found');
}

function handlePulls(store, repo, method, tail, query, input) {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof input.title === 'string' ? input.title : '';
      const head = typeof input.head === 'string' ? input.head : '';
      const base = typeof input.base === 'string' ? input.base : '';
      if (title === '' || head === '' || base === '') return errorResponse(store, 422, 'title, head and base are required');
      const created = store.createPull(repo, { title, body: typeof input.body === 'string' ? input.body : '', head, base });
      if (created.error === 'missing-branch') return errorResponse(store, 422, 'head or base branch does not exist');
      if (created.error === 'duplicate') return errorResponse(store, 422, 'A pull request already exists for this head and base');
      return jsonResponse(store, 201, pullJson(created.pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      const page = paginate(pulls, query);
      return jsonResponse(store, 200, page.items.map(pullJson));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  const number = Number.parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return errorResponse(store, 404, 'Not Found');
  const pull = store.getPull(repo, number);

  if (tail.length === 1) {
    if (method === 'GET') {
      if (pull === null) return errorResponse(store, 404, 'Not Found');
      return jsonResponse(store, 200, pullJson(pull));
    }
    return errorResponse(store, 404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === null) return errorResponse(store, 404, 'Not Found');
    const files = store.pullFiles(repo, pull).map((file) => ({
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    return jsonResponse(store, 200, files);
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === null) return errorResponse(store, 404, 'Not Found');
    const merged = store.mergePull(repo, pull);
    if (merged.error === 'conflict') return errorResponse(store, 405, 'Merge conflict');
    if (merged.error !== undefined) return errorResponse(store, 405, 'Pull request is not open');
    return jsonResponse(store, 200, { merged: true, sha: merged.mergeSha, message: `Pull request #${pull.number} successfully merged` });
  }

  return errorResponse(store, 404, 'Not Found');
}
