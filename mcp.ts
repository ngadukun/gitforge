// mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp.
// Modern era (2026-07-28): server/discover, no handshake, every request
// declares its revision in _meta. Legacy era: initialize +
// notifications/initialized. The transport contract is mcp-client.ts: a
// tools/call with an unknown tool answers JSON-RPC -32602/-32601 (never
// HTTP 500), missing required arguments -32602 (or isError), a body that is
// not JSON answers HTTP 400 with -32700, and a call without Authorization
// answers HTTP 401.

import { VIEWER } from './store.ts';

const SERVER_INFO = { name: 'gitforge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function tool(name, description, properties, required) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required },
  };
}

const stringProp = { type: 'string' };
const booleanProp = { type: 'boolean' };
const integerProp = { type: 'integer' };

const TOOLS = [
  tool('create_repo', 'Create a repository for the viewer.', {
    owner: stringProp, name: stringProp, description: stringProp, private: booleanProp,
  }, ['owner', 'name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: stringProp, repo: stringProp,
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: stringProp, repo: stringProp, title: stringProp, body: stringProp,
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues of a repository.', {
    owner: stringProp, repo: stringProp, state: stringProp,
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch onto a base branch.', {
    owner: stringProp, repo: stringProp, title: stringProp, body: stringProp, head: stringProp, base: stringProp,
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash-merge a pull request.', {
    owner: stringProp, repo: stringProp, pull_number: integerProp,
  }, ['owner', 'repo', 'pull_number']),
  tool('get_issue', 'Get one issue by number.', {
    owner: stringProp, repo: stringProp, issue_number: integerProp,
  }, ['owner', 'repo', 'issue_number']),
  tool('list_pull_requests', 'List pull requests of a repository.', {
    owner: stringProp, repo: stringProp, state: stringProp,
  }, ['owner', 'repo']),
  tool('add_comment', 'Add a comment to an issue.', {
    owner: stringProp, repo: stringProp, issue_number: integerProp, body: stringProp,
  }, ['owner', 'repo', 'issue_number', 'body']),
  tool('get_pull_request', 'Get one pull request by number.', {
    owner: stringProp, repo: stringProp, pull_number: integerProp,
  }, ['owner', 'repo', 'pull_number']),
];

const TOOL_MAP = new Map(TOOLS.map((entry) => [entry.name, entry]));

function rpcResult(id, result) {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id, code, message) {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function issueJson(issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
    user: issue.user,
    created_at: issue.created_at,
  };
}

function pullJson(pull) {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
  };
}

function repoJson(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
  };
}

export function handleMcp(store, request) {
  const { headers, body } = request;
  // Authentication is decided before any tool exists.
  const auth = headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (token === '' || (expected !== undefined && expected !== '' && token !== expected)) {
    return { status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Bad credentials' }) };
  }

  let rpc;
  try {
    rpc = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (rpc === null || typeof rpc !== 'object' || Array.isArray(rpc) || typeof rpc.method !== 'string') {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }

  const id = rpc.id ?? null;
  const isNotification = rpc.id === undefined;

  if (rpc.method === 'notifications/initialized') {
    return { status: 202, headers: {}, body: '' };
  }
  if (rpc.method === 'server/discover') {
    return rpcResult(id, {
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_VERSIONS,
      instructions: 'A GitHub-compatible forge: repositories, issues, pull requests, git smart HTTP, REST v3 and GraphQL.',
    });
  }
  if (rpc.method === 'initialize') {
    const offered = rpc.params?.protocolVersion;
    const chosen = typeof offered === 'string' && LEGACY_VERSIONS.includes(offered) ? offered : LEGACY_VERSIONS[0];
    return rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (rpc.method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (rpc.method === 'tools/call') {
    const name = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};
    const definition = typeof name === 'string' ? TOOL_MAP.get(name) : undefined;
    if (definition === undefined) {
      return rpcError(id, -32601, `Method not found: ${String(name)}`);
    }
    const missing = definition.inputSchema.required.filter((property) => args[property] === undefined || args[property] === null || args[property] === '');
    if (missing.length > 0) {
      return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
    }
    try {
      const result = callTool(store, name, args);
      if (result.error !== undefined) return rpcResult(id, toolError(result.error));
      return rpcResult(id, toolResult(result.value));
    } catch (err) {
      return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
    }
  }
  if (isNotification) return { status: 202, headers: {}, body: '' };
  return rpcError(id, -32601, `Method not found: ${rpc.method}`);
}

function requireRepo(store, owner, repoName) {
  if (owner !== VIEWER.login) return { error: `repository ${owner}/${repoName} not found` };
  const repo = store.getRepo(owner, repoName);
  if (repo === null) return { error: `repository ${owner}/${repoName} not found` };
  return { repo };
}

function callTool(store, name, args) {
  switch (name) {
    case 'create_repo': {
      if (args.owner !== VIEWER.login) return { error: `cannot create a repository for ${args.owner}` };
      if (store.getRepo(VIEWER.login, args.name) !== null) return { error: 'Repository already exists' };
      const created = store.createRepo(VIEWER.login, {
        name: args.name,
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return { value: repoJson(created.repo) };
    }
    case 'get_repo': {
      const found = requireRepo(store, args.owner, args.repo);
      if (found.error !== undefined) return found;
      return { value: repoJson(found.repo) };
    }
    case 'create_issue': {
      const found = requireRepo(store, args.owner, args.repo);
      if (found.error !== undefined) return found;
      const issue = store.createIssue(found.repo, { title: args.title, body: typeof args.body === 'string' ? args.body : '', labels: [] });
      return { value: issueJson(issue) };
    }
    case 'list_issues': {
      const found = requireRepo(store, args.owner, args.repo);
      if (found.error !== undefined) return found;
      let issues = [...found.repo.issues];
      if (typeof args.state === 'string' && args.state !== 'all') {
        issues = issues.filter((issue) => issue.state === args.state);
      }
      return { value: issues.map(issueJson) };
    }
    case 'create_pull_request': {
      const found = requireRepo(store, args.owner, args.repo);
      if (found.error !== undefined) return found;
      const created = store.createPull(found.repo, {
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        head: args.head,
        base: args.base,
      });
      if (created.error === 'missing-branch') return { error: 'head or base branch does not exist' };
      if (created.error === 'duplicate') return { error: 'A pull request already exists for this head and base' };
      return { value: pullJson(created.pull) };
    }
    case 'merge_pull_request': {
      const found = requireRepo(store, args.owner, args.repo);
      if (found.error !== undefined) return found;
      const pull = store.getPull(found.repo, args.pull_number);
      if (pull === null) return { error: `pull request #${args.pull_number} not found` };
      const merged = store.mergePull(found.repo, pull);
      if (merged.error === 'conflict') return { error: 'Merge conflict' };
      if (merged.error !== undefined) return { error: 'Pull request is not open' };
      return { value: { ...pullJson(pull), sha: merged.mergeSha } };
    }
    case 'get_issue': {
      const found = requireRepo(store, args.owner, args.repo);
      if (found.error !== undefined) return found;
      const issue = store.getIssue(found.repo, args.issue_number);
      if (issue === null) return { error: `issue #${args.issue_number} not found` };
      return { value: issueJson(issue) };
    }
    case 'list_pull_requests': {
      const found = requireRepo(store, args.owner, args.repo);
      if (found.error !== undefined) return found;
      let pulls = [...found.repo.pulls];
      if (typeof args.state === 'string' && args.state !== 'all') {
        pulls = pulls.filter((pull) => pull.state === args.state);
      }
      return { value: pulls.map(pullJson) };
    }
    case 'add_comment': {
      const found = requireRepo(store, args.owner, args.repo);
      if (found.error !== undefined) return found;
      const issue = store.getIssue(found.repo, args.issue_number);
      if (issue === null) return { error: `issue #${args.issue_number} not found` };
      const comment = store.addComment(found.repo, issue, args.body);
      return { value: { id: comment.id, body: comment.body, user: comment.user } };
    }
    case 'get_pull_request': {
      const found = requireRepo(store, args.owner, args.repo);
      if (found.error !== undefined) return found;
      const pull = store.getPull(found.repo, args.pull_number);
      if (pull === null) return { error: `pull request #${args.pull_number} not found` };
      return { value: pullJson(pull) };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
