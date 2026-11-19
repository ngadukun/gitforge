// graphql.ts — a small GraphQL engine for POST /api/graphql, covering exactly
// the documents the conformance suite sends (checks-graphql.ts's
// GRAPHQL_DOCUMENTS): viewer/repository/node reads, __type introspection,
// issues/pulls connections, the five mutations, and batched operations.
// It is not a general GraphQL implementation; unknown fields answer with a
// GraphQL errors array (HTTP 200), as the invalid-field check requires.

import { Store, VIEWER, globalId, decodeGlobalId } from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: '...', value: '...' });
      index += 3;
      continue;
    }
    if ('{}():![]=@$'.includes(char)) {
      tokens.push({ kind: char, value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const next = source[index + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1; // closing quote
      tokens.push({ kind: 'String', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let value = '';
      while (index < source.length && /[0-9.eE+-]/.test(source[index])) {
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: 'Number', value });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) {
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: 'Name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in GraphQL document`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.position = 0;
  }

  peek() {
    return this.tokens[this.position];
  }

  next() {
    const token = this.tokens[this.position];
    this.position += 1;
    return token;
  }

  expect(kind) {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, got ${token.kind} ${JSON.stringify(token.value)}`);
    return token;
  }

  expectName(value) {
    const token = this.next();
    if (token.kind !== 'Name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''}, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  parseDocument() {
    const definitions = [];
    while (this.peek().kind !== 'EOF') definitions.push(this.parseOperation());
    return { definitions };
  }

  parseOperation() {
    let operation = 'query';
    let name = null;
    if (this.peek().kind === 'Name' && (this.peek().value === 'query' || this.peek().value === 'mutation')) {
      operation = this.next().value;
      if (this.peek().kind === 'Name') name = this.next().value;
    }
    const variableDefinitions = this.peek().kind === '(' ? this.parseVariableDefinitions() : [];
    const selectionSet = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selectionSet };
  }

  parseVariableDefinitions() {
    const definitions = [];
    this.expect('(');
    while (this.peek().kind !== ')') {
      this.expect('$');
      const name = this.expectName();
      this.expect(':');
      // Skip the type (a name, possibly wrapped in [ ] and suffixed with !).
      let depth = 0;
      while (this.peek().kind !== 'EOF') {
        const token = this.peek();
        if (depth === 0 && (token.kind === ',' || token.kind === ')')) break;
        if (token.kind === '[') depth += 1;
        if (token.kind === ']') depth -= 1;
        this.next();
      }
      definitions.push({ name });
      if (this.peek().kind === ',') this.next();
    }
    this.expect(')');
    return definitions;
  }

  parseSelectionSet() {
    const selections = [];
    this.expect('{');
    while (this.peek().kind !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }

  parseSelection() {
    if (this.peek().kind === '...') {
      this.next();
      let typeCondition = null;
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const selectionSet = this.parseSelectionSet();
      return { kind: 'InlineFragment', typeCondition, selectionSet };
    }
    let alias = null;
    let name = this.expectName();
    if (this.peek().kind === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === '(' ? this.parseArguments() : [];
    const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'Field', alias, name, arguments: args, selectionSet };
  }

  parseArguments() {
    const args = [];
    this.expect('(');
    while (this.peek().kind !== ')') {
      const name = this.expectName();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
      if (this.peek().kind === ',') this.next();
    }
    this.expect(')');
    return args;
  }

  parseValue() {
    const token = this.next();
    if (token.kind === '$') return { kind: 'Variable', name: this.expectName() };
    if (token.kind === 'String') return { kind: 'StringValue', value: token.value };
    if (token.kind === 'Number') {
      return token.value.includes('.') || token.value.includes('e') || token.value.includes('E')
        ? { kind: 'FloatValue', value: Number.parseFloat(token.value) }
        : { kind: 'IntValue', value: Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'Name') {
      if (token.value === 'true') return { kind: 'BooleanValue', value: true };
      if (token.value === 'false') return { kind: 'BooleanValue', value: false };
      if (token.value === 'null') return { kind: 'NullValue' };
      return { kind: 'EnumValue', value: token.value };
    }
    if (token.kind === '[') {
      const values = [];
      while (this.peek().kind !== ']') {
        values.push(this.parseValue());
        if (this.peek().kind === ',') this.next();
      }
      this.expect(']');
      return { kind: 'ListValue', values };
    }
    if (token.kind === '{') {
      const fields = [];
      while (this.peek().kind !== '}') {
        const name = this.expectName();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peek().kind === ',') this.next();
      }
      this.expect('}');
      return { kind: 'ObjectValue', fields };
    }
    throw new Error(`unexpected value token ${token.kind} ${JSON.stringify(token.value)}`);
  }
}

function valueOf(node, variables) {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name] ?? null;
    case 'StringValue':
    case 'IntValue':
    case 'FloatValue':
    case 'BooleanValue':
    case 'EnumValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'ListValue':
      return node.values.map((child) => valueOf(child, variables));
    case 'ObjectValue': {
      const out = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// schema data
// ---------------------------------------------------------------------------

const TYPE_FIELDS = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function issueGlobalId(repo, issue) {
  return globalId('issue', `${repo.full_name}#${issue.number}`);
}

function pullGlobalId(repo, pull) {
  return globalId('pr', `${repo.full_name}#${pull.number}`);
}

function cursorFor(number) {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor) {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('issue:')) return null;
    const number = Number.parseInt(text.slice('issue:'.length), 10);
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

class Executor {
  constructor(store) {
    this.store = store;
    this.errors = [];
  }

  error(message) {
    this.errors.push({ message });
  }

  execute(document, variables) {
    const operation = document.definitions[0];
    if (operation === undefined) {
      this.error('No operation in document');
      return { data: null };
    }
    const data = this.executeSelectionSet('Query', { __type: 'Query' }, operation.selectionSet, variables);
    return { data };
  }

  executeSelectionSet(typeName, value, selectionSet, variables) {
    if (value === null || value === undefined) return null;
    const out = {};
    for (const selection of selectionSet) {
      if (selection.kind === 'InlineFragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== value.__type) continue;
        const fragment = this.executeSelectionSet(typeName, value, selection.selectionSet, variables);
        if (fragment !== null) Object.assign(out, fragment);
        continue;
      }
      const key = selection.alias ?? selection.name;
      out[key] = this.executeField(typeName, value, selection, variables);
    }
    return out;
  }

  executeField(typeName, value, selection, variables) {
    const args = {};
    for (const arg of selection.arguments) args[arg.name] = valueOf(arg.value, variables);
    const resolver = this.resolve(typeName, value, selection.name, args);
    if (resolver.unknown === true) {
      this.error(`Cannot query field "${selection.name}" on type "${typeName}".`);
      return null;
    }
    const resolved = resolver.value;
    if (resolved === null || resolved === undefined) return null;
    if (selection.selectionSet === null) return resolved;
    if (Array.isArray(resolved)) {
      return resolved.map((item) => this.executeSelectionSet(item.__type ?? typeName, item, selection.selectionSet, variables));
    }
    return this.executeSelectionSet(resolved.__type ?? typeName, resolved, selection.selectionSet, variables);
  }

  // Returns {value} or {unknown: true}. `value` is a scalar, null, or an
  // object carrying __type for nested selection sets.
  resolve(typeName, value, field, args) {
    const store = this.store;
    switch (typeName) {
      case 'Query': {
        if (field === 'viewer') return { value: { __type: 'Viewer', login: VIEWER.login, id: VIEWER.id } };
        if (field === 'repository') {
          const repo = store.getRepo(args.owner, args.name);
          if (repo === null || args.owner !== VIEWER.login) return { value: null };
          return { value: repoObject(repo) };
        }
        if (field === 'node') {
          const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
          if (decoded === null) return { value: null };
          if (decoded.kind === 'repo') {
            const [owner, name] = decoded.key.split('/');
            const repo = store.getRepo(owner, name);
            if (repo === null) return { value: null };
            return { value: repoObject(repo) };
          }
          if (decoded.kind === 'issue') {
            const [fullName, numberText] = decoded.key.split('#');
            const [owner, name] = fullName.split('/');
            const repo = store.getRepo(owner, name);
            const issue = repo === null ? null : store.getIssue(repo, Number.parseInt(numberText, 10));
            if (issue === null) return { value: null };
            return { value: issueObject(repo, issue) };
          }
          if (decoded.kind === 'pr') {
            const [fullName, numberText] = decoded.key.split('#');
            const [owner, name] = fullName.split('/');
            const repo = store.getRepo(owner, name);
            const pull = repo === null ? null : store.getPull(repo, Number.parseInt(numberText, 10));
            if (pull === null) return { value: null };
            return { value: pullObject(repo, pull) };
          }
          return { value: null };
        }
        if (field === '__type') {
          const name = args.name;
          if (typeof name !== 'string' || !(name in TYPE_FIELDS)) return { value: null };
          return {
            value: {
              __type: '__Type',
              name,
              fields: TYPE_FIELDS[name].map((fieldName) => ({ __type: '__Field', name: fieldName })),
              enumValues: name === 'SearchType' ? SEARCH_TYPE_VALUES.map((enumName) => ({ __type: '__EnumValue', name: enumName })) : null,
            },
          };
        }
        if (field === 'createIssue' || field === 'closeIssue' || field === 'createPullRequest' || field === 'mergePullRequest' || field === 'addComment') {
          return { value: this.mutation(field, args.input ?? {}) };
        }
        return { unknown: true };
      }
      case 'Viewer':
      case 'User': {
        if (field === 'login') return { value: value.login };
        if (field === 'id') return { value: value.id ?? 0 };
        return { unknown: true };
      }
      case 'Repository': {
        const repo = value.__repo;
        if (field === 'id') return { value: repo.nodeId };
        if (field === 'databaseId') return { value: repo.id };
        if (field === 'name') return { value: repo.name };
        if (field === 'nameWithOwner') return { value: repo.full_name };
        if (field === 'owner') return { value: { __type: 'User', login: repo.owner, id: VIEWER.id } };
        if (field === 'defaultBranchRef') {
          return { value: { __type: 'Ref', name: repo.default_branch } };
        }
        if (field === 'viewerPermission') return { value: 'ADMIN' };
        if (field === 'hasIssuesEnabled') return { value: true };
        if (field === 'description') return { value: repo.description };
        if (field === 'isPrivate') return { value: repo.private };
        if (field === 'issue') {
          const issue = store.getIssue(repo, args.number);
          if (issue === null) return { value: null };
          return { value: issueObject(repo, issue) };
        }
        if (field === 'issues') return { value: this.issuesConnection(repo, args) };
        if (field === 'pullRequests') return { value: this.pullsConnection(repo, args) };
        if (field === 'pullRequest') {
          const pull = store.getPull(repo, args.number);
          if (pull === null) return { value: null };
          return { value: pullObject(repo, pull) };
        }
        return { unknown: true };
      }
      case 'Issue': {
        const issue = value.__issue;
        if (field === 'id') return { value: issueGlobalId(value.__repo, issue) };
        if (field === 'number') return { value: issue.number };
        if (field === 'title') return { value: issue.title };
        if (field === 'body') return { value: issue.body };
        if (field === 'state') return { value: issue.state === 'open' ? 'OPEN' : 'CLOSED' };
        return { unknown: true };
      }
      case 'PullRequest': {
        const pull = value.__pull;
        if (field === 'id') return { value: pullGlobalId(value.__repo, pull) };
        if (field === 'number') return { value: pull.number };
        if (field === 'title') return { value: pull.title };
        if (field === 'body') return { value: pull.body };
        if (field === 'state') return { value: pull.state === 'open' ? 'OPEN' : 'CLOSED' };
        if (field === 'merged') return { value: pull.merged };
        if (field === 'mergeable') return { value: store.pullMergeable(value.__repo, pull) };
        if (field === 'headRefName') return { value: pull.head.ref };
        if (field === 'baseRefName') return { value: pull.base.ref };
        if (field === 'headRefOid') return { value: pull.head.sha };
        if (field === 'baseRefOid') return { value: pull.base.sha };
        if (field === 'files') {
          const files = store.pullFiles(value.__repo, pull).slice(0, args.first ?? 100);
          return {
            value: {
              __type: 'PullRequestFileConnection',
              nodes: files.map((file) => ({ __type: 'PullRequestFile', path: file.path, additions: file.additions, deletions: file.deletions, changes: file.changes })),
            },
          };
        }
        return { unknown: true };
      }
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestFileConnection': {
        if (field === 'nodes') return { value: value.nodes };
        if (field === 'pageInfo') return { value: value.pageInfo ?? { __type: 'PageInfo', hasNextPage: false, endCursor: null } };
        if (field === 'totalCount') return { value: value.nodes.length };
        return { unknown: true };
      }
      case 'PageInfo': {
        if (field === 'hasNextPage') return { value: value.hasNextPage };
        if (field === 'endCursor') return { value: value.endCursor };
        return { unknown: true };
      }
      case 'Ref': {
        if (field === 'name') return { value: value.name };
        return { unknown: true };
      }
      case '__Type': {
        if (field === 'name') return { value: value.name };
        if (field === 'fields') return { value: value.fields };
        if (field === 'enumValues') return { value: value.enumValues };
        return { unknown: true };
      }
      case '__Field':
      case '__EnumValue': {
        if (field === 'name') return { value: value.name };
        return { unknown: true };
      }
      case 'PullRequestFile': {
        if (field === 'path') return { value: value.path };
        if (field === 'additions') return { value: value.additions };
        if (field === 'deletions') return { value: value.deletions };
        if (field === 'changes') return { value: value.changes };
        return { unknown: true };
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (field === 'issue') return { value: value.issue ?? null };
        return { unknown: true };
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (field === 'pullRequest') return { value: value.pullRequest ?? null };
        return { unknown: true };
      }
      case 'AddCommentPayload': {
        if (field === 'commentEdge') return { value: value.commentEdge ?? null };
        return { unknown: true };
      }
      case 'CommentEdge': {
        if (field === 'node') return { value: value.node ?? null };
        return { unknown: true };
      }
      case 'Comment': {
        if (field === 'id') return { value: value.id };
        if (field === 'body') return { value: value.body };
        return { unknown: true };
      }
      default:
        return { unknown: true };
    }
  }

  issuesConnection(repo, args) {
    let issues = [...repo.issues];
    if (Array.isArray(args.states) && args.states.length > 0) {
      const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const direction = args.orderBy?.direction === 'ASC' ? 'asc' : 'desc';
    if (args.orderBy?.field === 'CREATED_AT') {
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    } else {
      // Default order: creation order.
      issues.sort((a, b) => a.createdSeq - b.createdSeq);
    }
    const first = typeof args.first === 'number' ? args.first : issues.length;
    let start = 0;
    if (typeof args.after === 'string' && args.after !== '') {
      const afterNumber = cursorNumber(args.after);
      if (afterNumber !== null) {
        const index = issues.findIndex((issue) => issue.number === afterNumber);
        if (index >= 0) start = index + 1;
      }
    }
    const page = issues.slice(start, start + first);
    const hasNextPage = start + page.length < issues.length;
    const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
    return {
      __type: 'IssueConnection',
      nodes: page.map((issue) => issueObject(repo, issue)),
      pageInfo: { __type: 'PageInfo', hasNextPage, endCursor },
    };
  }

  pullsConnection(repo, args) {
    let pulls = [...repo.pulls];
    if (Array.isArray(args.states) && args.states.length > 0) {
      const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
      pulls = pulls.filter((pull) => wanted.has(pull.state));
    }
    const first = typeof args.first === 'number' ? args.first : pulls.length;
    return {
      __type: 'PullRequestConnection',
      nodes: pulls.slice(0, first).map((pull) => pullObject(repo, pull)),
      pageInfo: { __type: 'PageInfo', hasNextPage: pulls.length > first, endCursor: null },
    };
  }

  mutation(field, input) {
    const store = this.store;
    if (field === 'createIssue') {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      if (decoded === null || decoded.kind !== 'repo') {
        this.error('createIssue: repositoryId does not name a repository');
        return { __type: 'CreateIssuePayload', issue: null };
      }
      const [owner, name] = decoded.key.split('/');
      const repo = store.getRepo(owner, name);
      if (repo === null) {
        this.error('createIssue: repository not found');
        return { __type: 'CreateIssuePayload', issue: null };
      }
      const issue = store.createIssue(repo, { title: input.title ?? '', body: input.body ?? '', labels: [] });
      return { __type: 'CreateIssuePayload', issue: issueObject(repo, issue) };
    }
    if (field === 'closeIssue') {
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      if (decoded === null || decoded.kind !== 'issue') {
        this.error('closeIssue: issueId does not name an issue');
        return { __type: 'CloseIssuePayload', issue: null };
      }
      const [fullName, numberText] = decoded.key.split('#');
      const [owner, name] = fullName.split('/');
      const repo = store.getRepo(owner, name);
      const issue = repo === null ? null : store.getIssue(repo, Number.parseInt(numberText, 10));
      if (issue === null) {
        this.error('closeIssue: issue not found');
        return { __type: 'CloseIssuePayload', issue: null };
      }
      issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueObject(repo, issue) };
    }
    if (field === 'createPullRequest') {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      if (decoded === null || decoded.kind !== 'repo') {
        this.error('createPullRequest: repositoryId does not name a repository');
        return { __type: 'CreatePullRequestPayload', pullRequest: null };
      }
      const [owner, name] = decoded.key.split('/');
      const repo = store.getRepo(owner, name);
      if (repo === null) {
        this.error('createPullRequest: repository not found');
        return { __type: 'CreatePullRequestPayload', pullRequest: null };
      }
      const created = store.createPull(repo, {
        title: input.title ?? '',
        body: input.body ?? '',
        head: input.headRefName ?? '',
        base: input.baseRefName ?? '',
      });
      if (created.error !== undefined) {
        this.error(`createPullRequest: ${created.error}`);
        return { __type: 'CreatePullRequestPayload', pullRequest: null };
      }
      return { __type: 'CreatePullRequestPayload', pullRequest: pullObject(repo, created.pull) };
    }
    if (field === 'mergePullRequest') {
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      if (decoded === null || decoded.kind !== 'pr') {
        this.error('mergePullRequest: pullRequestId does not name a pull request');
        return { __type: 'MergePullRequestPayload', pullRequest: null };
      }
      const [fullName, numberText] = decoded.key.split('#');
      const [owner, name] = fullName.split('/');
      const repo = store.getRepo(owner, name);
      const pull = repo === null ? null : store.getPull(repo, Number.parseInt(numberText, 10));
      if (pull === null) {
        this.error('mergePullRequest: pull request not found');
        return { __type: 'MergePullRequestPayload', pullRequest: null };
      }
      const merged = store.mergePull(repo, pull);
      if (merged.error !== undefined) {
        this.error(`mergePullRequest: ${merged.error}`);
        return { __type: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
      }
      return { __type: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
    }
    if (field === 'addComment') {
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      if (decoded === null || decoded.kind !== 'issue') {
        this.error('addComment: subjectId does not name an issue');
        return { __type: 'AddCommentPayload', commentEdge: null };
      }
      const [fullName, numberText] = decoded.key.split('#');
      const [owner, name] = fullName.split('/');
      const repo = store.getRepo(owner, name);
      const issue = repo === null ? null : store.getIssue(repo, Number.parseInt(numberText, 10));
      if (issue === null) {
        this.error('addComment: issue not found');
        return { __type: 'AddCommentPayload', commentEdge: null };
      }
      const comment = store.addComment(repo, issue, input.body ?? '');
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'CommentEdge', node: { __type: 'Comment', id: comment.nodeId, body: comment.body } },
      };
    }
    this.error(`Unknown mutation ${field}`);
    return { __type: 'Payload', value: null };
  }
}

function repoObject(repo) {
  return { __type: 'Repository', __repo: repo };
}

function issueObject(repo, issue) {
  return { __type: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(repo, pull) {
  return { __type: 'PullRequest', __repo: repo, __pull: pull };
}

// Execute one {query, variables} operation body. Returns the GraphQL response object.
export function executeGraphQL(store, body) {
  const executor = new Executor(store);
  let document;
  try {
    document = new Parser(tokenize(body.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const result = executor.execute(document, body.variables ?? {});
  if (executor.errors.length > 0) result.errors = executor.errors;
  return result;
}
