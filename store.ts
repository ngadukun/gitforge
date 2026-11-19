// gitforge store: the in-memory forge. One Store holds every repository: its
// git objects and refs, and the REST/GraphQL/MCP view of issues, pull
// requests, labels and comments. Everything is plain Maps; there is no disk
// state (a trial starts the process fresh) and no clock in any stored value
// that a check could read, so two runs on the same scenario behave the same.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER = Object.freeze({
  id: 1000,
  login: VIEWER_LOGIN,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});
export const SERVER_VERSION = '1.0.0';

const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function isOid(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// commits, trees, tags
// ---------------------------------------------------------------------------

export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? '' : text.slice(split + 2);
  // A commit object stores its message with one trailing newline (git's
  // convention); the message itself does not include it.
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit({ tree, parents, message, author, committer, timestamp }) {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  const stamp = `${timestamp} +0000`;
  lines.push(`author ${author} ${stamp}`);
  lines.push(`committer ${committer} ${stamp}`);
  lines.push('');
  lines.push(message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function parseTag(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag({ object, type, tag, message, tagger, timestamp }) {
  const lines = [`object ${object}`, `type ${type}`, `tag ${tag}`, `tagger ${tagger} ${timestamp} +0000`, '', message.endsWith('\n') ? message : `${message}\n`];
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a, b) {
  const an = a.endsWith('/') ? a : a;
  const bn = b.endsWith('/') ? b : b;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

// Git's tree order: entries sorted by name, directories as if their name had
// a trailing slash.
export function sortTreeEntries(entries) {
  return [...entries].sort((x, y) => {
    const xn = x.mode === '40000' ? `${x.name}/` : x.name;
    const yn = y.mode === '40000' ? `${y.name}/` : y.name;
    return compareTreeNames(xn, yn);
  });
}

export function buildTree(entries) {
  const parts = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// packs (plain objects only on write; deltas resolved on read)
// ---------------------------------------------------------------------------

function readVarintSize(buffer, start) {
  let byte = buffer[start];
  let size = byte & 0x0f;
  let shift = 4;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { size, next, first: buffer[start] };
}

function readOfsDeltaBase(buffer, start) {
  let byte = buffer[start];
  let offset = byte & 0x7f;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next];
    offset = ((offset + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { baseOffset: offset, next };
}

export function applyDelta(base, delta) {
  let pos = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const outSize = readVarint();
  const chunks = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[pos] << (bit * 8);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[pos] << (bit * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== outSize) throw new Error('delta output size mismatch');
  return Buffer.concat(chunks, outSize);
}

export function packChecksum(pack) {
  const hash = createHash('sha1');
  hash.update(pack.subarray(0, pack.length - 20));
  return hash.digest('hex');
}

export function readPack(pack) {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  const expectedTrailer = packChecksum(pack);
  const actualTrailer = pack.subarray(pack.length - 20).toString('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack trailer checksum mismatch');
  const objects = new Map();
  const deltas = [];
  let offset = 12;
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(pack, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    if (typeCode === 6) {
      const { baseOffset, next: afterBase } = readOfsDeltaBase(pack, offset);
      offset = afterBase;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      deltas.push({ kind: 'ofs', baseOffset, data: inflated.data, size, entryOffset });
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      deltas.push({ kind: 'ref', baseOid, data: inflated.data, size, entryOffset });
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, inflated.data);
      objects.set(oid, { type, data: inflated.data });
      offsets.push({ offset: entryOffset, oid });
    }
  }
  // Resolve deltas (possibly chained) after the plain objects are known.
  const byOffset = new Map(offsets.map((entry) => [entry.offset, entry.oid]));
  let pending = deltas;
  for (let round = 0; round < pending.length + 2 && pending.length > 0; round += 1) {
    const nextPending = [];
    for (const delta of pending) {
      let base = null;
      if (delta.kind === 'ofs') base = objects.get(byOffset.get(delta.entryOffset - delta.baseOffset));
      else base = objects.get(delta.baseOid);
      if (base === undefined) {
        nextPending.push(delta);
        continue;
      }
      const data = applyDelta(base.data, delta.data);
      const type = base.type;
      const oid = hashObject(type, data);
      objects.set(oid, { type, data });
      byOffset.set(delta.entryOffset, oid);
    }
    if (nextPending.length === pending.length) throw new Error('unresolvable pack delta (thin pack without its base)');
    pending = nextPending;
  }
  if (pending.length > 0) throw new Error('unresolvable pack delta (thin pack without its base)');
  return { version, count, objects };
}

// Adler-32 of `data` as the 4 big-endian bytes a zlib stream ends with
// (deferred-mod blocks, the standard NMAX=5552 formulation).
function adler32Trailer(data) {
  let a = 1;
  let b = 0;
  let offset = 0;
  while (offset < data.length) {
    const blockEnd = Math.min(offset + 5552, data.length);
    for (; offset < blockEnd; offset += 1) {
      a += data[offset];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return Buffer.from([(b >> 8) & 0xff, b & 0xff, (a >> 8) & 0xff, a & 0xff]);
}

// Inflate the stream starting at `offset`; returns {data, next} with `next`
// the offset just past the stream's end. One inflate over the whole tail
// yields the object (zlib stops at the stream's end and ignores what
// follows); the exact end is then the first place the stream's own Adler-32
// trailer appears where a fresh inflate of just that prefix returns the
// same bytes — a chance match inside the compressed data fails that check
// and the search moves on. When no candidate verifies (a corrupt stream),
// the exact prefix search below runs instead, so bad packs fail as before.
function inflateAt(buffer, offset, maxEnd) {
  const end = maxEnd === undefined ? buffer.length : maxEnd;
  let data;
  try {
    data = inflateSync(buffer.subarray(offset, end));
  } catch {
    return inflateAtSearch(buffer, offset, end);
  }
  const trailer = adler32Trailer(data);
  let searchFrom = offset + 2;
  for (;;) {
    const at = buffer.indexOf(trailer, searchFrom);
    if (at === -1 || at + 4 > end) return inflateAtSearch(buffer, offset, end);
    try {
      const check = inflateSync(buffer.subarray(offset, at + 4));
      if (check.equals(data)) return { data, next: at + 4 };
    } catch {
      // A chance match inside the compressed bytes: keep looking.
    }
    searchFrom = at + 1;
  }
}

// The exact-end search: grow a prefix until it inflates, then binary-search
// the minimal succeeding prefix (any shorter one is a truncated stream).
function inflateAtSearch(buffer, offset, maxEnd) {
  const end = maxEnd === undefined ? buffer.length : maxEnd;
  let lo = offset;
  let hi = Math.min(end, offset + 16);
  let data = null;
  for (;;) {
    try {
      data = inflateSync(buffer.subarray(offset, hi));
      break;
    } catch {
      if (hi >= end) {
        // One final attempt on the whole tail, so the real error surfaces.
        data = inflateSync(buffer.subarray(offset, end));
        return { data, next: end };
      }
      lo = hi;
      hi = Math.min(end, hi * 2);
    }
  }
  // Binary search the minimal succeeding prefix in (lo, hi].
  let low = lo;
  let high = hi;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(buffer.subarray(offset, mid));
      high = mid;
    } catch {
      low = mid;
    }
  }
  data = inflateSync(buffer.subarray(offset, high));
  return { data, next: high };
}

// Write a pack of plain objects (no deltas): 'PACK', version 2, count, then
// per object a varint type+size header and a zlib stream, then the SHA-1
// trailer over everything before it. Object order is sorted by oid, so the
// bytes are deterministic for a given set.
function writePackObjectHeader(type, size) {
  const typeCode = TYPE_CODE[type];
  const bytes = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size !== 0) first |= 0x80;
  bytes.push(first);
  while (size !== 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size !== 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

export function writePack(objects) {
  const list = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const hash = createHash('sha1');
  hash.update(body);
  return Buffer.concat([body, hash.digest()]);
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

const FIXED_DATE = '2025-01-01T00:00:00Z';
const IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

function b64encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function globalId(kind, key) {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id) {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Store {
  constructor() {
    this.repos = new Map(); // "owner/name" -> repo
    this.repoSeq = 1;
    this.repoInstanceSeq = 1; // identity per repo instance (delete+recreate differs)
    this.objectSeq = 10000; // numeric ids for issues / pulls / comments
    this.timeSeq = 1700000000; // commit timestamps, deterministic per run
    this.requestSeq = 1;
  }

  nextRequestId() {
    const id = this.requestSeq;
    this.requestSeq += 1;
    return `req-${id.toString(16).padStart(12, '0')}`;
  }

  nextTimestamp() {
    const stamp = this.timeSeq;
    this.timeSeq += 1;
    return stamp;
  }

  repoKey(owner, name) {
    return `${owner}/${name}`;
  }

  createRepo(owner, { name, private: isPrivate, description }) {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return { error: 'exists' };
    const repo = {
      id: this.repoSeq,
      instance: this.repoInstanceSeq,
      version: 0, // bumped on every git-visible mutation (objects/refs)
      nodeId: globalId('repo', key),
      owner,
      name,
      full_name: key,
      private: isPrivate === true,
      description: description ?? '',
      default_branch: 'main',
      created_at: FIXED_DATE,
      updated_at: FIXED_DATE,
      objects: new Map(), // oid -> {type, data}
      refs: new Map(), // refname -> oid
      refOrder: [], // ref creation order
      issues: [],
      pulls: [],
      labels: new Map(), // name -> {name, color, description}
      nextNumber: 1,
    };
    this.repoSeq += 1;
    this.repoInstanceSeq += 1;
    this.repos.set(key, repo);
    return { repo };
  }

  getRepo(owner, name) {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  deleteRepo(owner, name) {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner) {
    const out = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  putObject(repo, type, data) {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.version += 1;
    }
    return oid;
  }

  getObject(repo, oid) {
    return repo.objects.get(oid) ?? null;
  }

  setRef(repo, ref, oid) {
    if (!repo.refs.has(ref)) repo.refOrder.push(ref);
    if (repo.refs.get(ref) !== oid) repo.version += 1;
    repo.refs.set(ref, oid);
  }

  deleteRef(repo, ref) {
    if (repo.refs.delete(ref)) repo.version += 1;
    repo.refOrder = repo.refOrder.filter((name) => name !== ref);
  }

  refTip(repo, ref) {
    return repo.refs.get(ref) ?? null;
  }

  branches(repo) {
    const out = [];
    for (const ref of repo.refOrder) {
      if (!ref.startsWith('refs/heads/')) continue;
      out.push({ name: ref.slice('refs/heads/'.length), sha: repo.refs.get(ref) });
    }
    return out;
  }

  // -- trees ---------------------------------------------------------------

  // Flatten a tree object into path -> {oid, mode}.
  flattenTree(repo, treeOid, prefix, out) {
    const object = this.getObject(repo, treeOid);
    if (object === null || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  // Build (and store) a tree from a flat path map; returns the root tree oid.
  buildTreeFromFlat(repo, flat) {
    const buildDir = (dirFlat) => {
      const entries = [];
      const sub = new Map();
      for (const [path, value] of dirFlat) {
        const slash = path.indexOf('/');
        if (slash === -1) entries.push({ mode: value.mode, name: path, oid: value.oid });
        else {
          const head = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          if (!sub.has(head)) sub.set(head, new Map());
          sub.get(head).set(rest, value);
        }
      }
      for (const [name, childFlat] of sub) {
        entries.push({ mode: '40000', name, oid: buildDir(childFlat) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir(flat);
  }

  // The tree of a ref (branch name or full ref), or null when the ref is unborn.
  treeOfRef(repo, ref) {
    const tip = this.refTip(repo, ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
    if (tip === null) return null;
    const object = this.getObject(repo, tip);
    if (object === null || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  flatOfRef(repo, ref) {
    const tree = this.treeOfRef(repo, ref);
    if (tree === null) return new Map();
    return this.flattenTree(repo, tree, '', new Map());
  }

  // Commit a set of file changes on a branch: changes is [{path, data: Buffer|null}]
  // (null deletes). Returns {commitSha, treeSha}.
  commitFiles(repo, branch, changes, message) {
    const ref = `refs/heads/${branch}`;
    const tip = this.refTip(repo, ref);
    const flat = tip === null ? new Map() : this.flatOfRef(repo, ref);
    for (const change of changes) {
      if (change.data === null) flat.delete(change.path);
      else {
        const blobOid = this.putObject(repo, 'blob', change.data);
        flat.set(change.path, { oid: blobOid, mode: '100644' });
      }
    }
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === null ? [] : [tip],
      message,
      author: IDENTITY,
      committer: IDENTITY,
      timestamp: this.nextTimestamp(),
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    this.setRef(repo, ref, commitSha);
    return { commitSha, treeSha: treeOid };
  }

  // -- reachability ----------------------------------------------------------

  // Walk commits from `tips`, following parents. `depth` limits parent steps
  // (undefined = full walk). `cutAt` is a set of commit oids whose parents
  // are not traversed (shallow boundaries; the boundary itself is included).
  // Returns {commits: Map<oid, depth>, objects: Map<oid, {type, data}>} with
  // every object the walk touches (commits, their trees, blobs, tag targets).
  walk(repo, tips, options = {}) {
    const depthLimit = options.depth;
    const cutAt = options.cutAt ?? new Set();
    const exclude = options.exclude ?? new Set();
    const commits = new Map();
    const objects = new Map();
    const queue = [];
    for (const tip of tips) queue.push({ oid: tip, depth: 0 });
    const seenTags = new Set();
    const expanded = new Set();
    while (queue.length > 0) {
      const { oid, depth } = queue.shift();
      if (oid === ZERO_OID) continue;
      const object = this.getObject(repo, oid);
      if (object === null) continue;
      const excluded = exclude.has(oid);
      if (object.type === 'tag') {
        if (seenTags.has(oid)) continue;
        seenTags.add(oid);
        if (!excluded) objects.set(oid, object);
        const target = parseTag(object.data).object;
        queue.push({ oid: target, depth });
        continue;
      }
      if (object.type !== 'commit') {
        if (!excluded) objects.set(oid, object);
        continue;
      }
      if (expanded.has(oid)) continue;
      expanded.add(oid);
      if (depthLimit !== undefined && depth > depthLimit) continue;
      const parsed = parseCommit(object.data);
      if (!excluded) {
        commits.set(oid, depth);
        objects.set(oid, object);
        // The commit's whole tree.
        const flat = this.flattenTree(repo, parsed.tree, '', new Map());
        const treeObject = this.getObject(repo, parsed.tree);
        if (treeObject !== null && !exclude.has(parsed.tree)) objects.set(parsed.tree, treeObject);
        for (const entry of flat.values()) {
          const blob = this.getObject(repo, entry.oid);
          if (blob !== null && !exclude.has(entry.oid)) objects.set(entry.oid, blob);
        }
        // Subtrees too (the pack must carry them for a clone to verify).
        const collectTrees = (treeOid) => {
          const subtree = this.getObject(repo, treeOid);
          if (subtree === null || subtree.type !== 'tree') return;
          if (!exclude.has(treeOid)) objects.set(treeOid, subtree);
          for (const entry of parseTree(subtree.data)) {
            if (entry.mode === '40000') collectTrees(entry.oid);
          }
        };
        collectTrees(parsed.tree);
      }
      // Traverse parents even through an excluded commit: a deepen must
      // reach past a boundary the client already holds.
      if (cutAt.has(oid)) continue;
      if (depthLimit !== undefined && depth >= depthLimit) continue;
      for (const parent of parsed.parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    return { commits, objects };
  }

  // The objects a fetch must send: reachable from `wants` (depth-limited)
  // minus everything reachable from `haves` (cut at the old boundaries).
  fetchObjects(repo, { wants, haves, shallow, depth }) {
    const cutAt = new Set(shallow ?? []);
    const haveWalk = this.walk(repo, haves ?? [], { cutAt });
    const exclude = new Set(haveWalk.objects.keys());
    // The want walk is bounded by the depth limit and the have set alone:
    // the old shallow boundaries must NOT cut it, or a deepen could never
    // reach past the boundary the client already holds (the boundary commit
    // is excluded from the send set, but its parents are the deepen).
    const wantWalk = this.walk(repo, wants, { depth: depth === undefined ? undefined : depth - 1, exclude });
    return { objects: wantWalk.objects, commits: wantWalk.commits };
  }

  isAncestor(repo, ancestor, descendant) {
    if (ancestor === descendant) return true;
    // Reachability over the commit parent graph only, with an early exit:
    // the full walk() would expand every reachable commit and flatten its
    // tree, which makes a fast-forward check cost O(history) — the push
    // workload checks a direct parent, so stop as soon as it is found.
    // Semantics match walk(): tags are peeled to their target, and only a
    // commit can be an ancestor (a tag oid is never in walk()'s commits).
    const seen = new Set();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.getObject(repo, oid);
      if (object === null) continue;
      if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      if (oid === ancestor) return true;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  // -- diff ------------------------------------------------------------------

  // Line diff counts between two blobs (LCS over lines).
  lineDiff(oldData, newData) {
    const oldLines = oldData.length === 0 ? [] : oldData.toString('utf8').split('\n');
    const newLines = newData.length === 0 ? [] : newData.toString('utf8').split('\n');
    if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
    if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    let prev = new Uint32Array(cols);
    let current = new Uint32Array(cols);
    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        current[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], current[j - 1]);
      }
      const swap = prev;
      prev = current;
      current = swap;
    }
    const lcs = prev[cols - 1];
    return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
  }

  // Diff two flat trees; returns [{path, status, additions, deletions, changes}].
  diffFlat(repo, oldFlat, newFlat) {
    const files = [];
    const paths = new Set([...oldFlat.keys(), ...newFlat.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = oldFlat.get(path);
      const newEntry = newFlat.get(path);
      if (oldEntry !== undefined && newEntry === undefined) {
        const oldData = this.getObject(repo, oldEntry.oid)?.data ?? Buffer.alloc(0);
        const counts = this.lineDiff(oldData, Buffer.alloc(0));
        files.push({ path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
      } else if (oldEntry === undefined && newEntry !== undefined) {
        const newData = this.getObject(repo, newEntry.oid)?.data ?? Buffer.alloc(0);
        const counts = this.lineDiff(Buffer.alloc(0), newData);
        files.push({ path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
      } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
        const oldData = this.getObject(repo, oldEntry.oid)?.data ?? Buffer.alloc(0);
        const newData = this.getObject(repo, newEntry.oid)?.data ?? Buffer.alloc(0);
        const counts = this.lineDiff(oldData, newData);
        files.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
      }
    }
    return files;
  }

  // -- issues / pulls ----------------------------------------------------------

  nextIssueNumber(repo) {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    return number;
  }

  createIssue(repo, { title, body, labels }) {
    const number = this.nextIssueNumber(repo);
    const issue = {
      id: this.objectSeq,
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: (labels ?? []).map((name) => {
        const label = repo.labels.get(name);
        return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
      }),
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      created_at: FIXED_DATE,
      updated_at: FIXED_DATE,
      createdSeq: this.objectSeq,
      comments: [],
    };
    this.objectSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo, number) {
    return repo.issues.find((issue) => issue.number === number) ?? null;
  }

  addComment(repo, issue, body) {
    const comment = {
      id: this.objectSeq,
      nodeId: globalId('comment', `${repo.full_name}#${issue.number}:${this.objectSeq}`),
      body,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      created_at: FIXED_DATE,
      updated_at: FIXED_DATE,
    };
    this.objectSeq += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo, { title, body, head, base }) {
    const headTip = this.refTip(repo, `refs/heads/${head}`);
    const baseTip = this.refTip(repo, `refs/heads/${base}`);
    if (headTip === null || baseTip === null) return { error: 'missing-branch' };
    const open = repo.pulls.find((pull) => pull.head.ref === head && pull.base.ref === base && pull.state === 'open');
    if (open !== undefined) return { error: 'duplicate', pull: open };
    const number = this.nextIssueNumber(repo);
    const pull = {
      id: this.objectSeq,
      number,
      title,
      body: body ?? '',
      state: 'open',
      head: { ref: head, sha: headTip, label: `${VIEWER.login}:${head}` },
      base: { ref: base, sha: baseTip, label: `${VIEWER.login}:${base}` },
      baseShaAtOpen: baseTip,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      created_at: FIXED_DATE,
      updated_at: FIXED_DATE,
      createdSeq: this.objectSeq,
    };
    this.objectSeq += 1;
    repo.pulls.push(pull);
    return { pull };
  }

  getPull(repo, number) {
    return repo.pulls.find((pull) => pull.number === number) ?? null;
  }

  pullFiles(repo, pull) {
    const baseFlat = this.flatOfRef(repo, pull.base.ref);
    // The PR's base is the base branch tip at read time for the file list;
    // GitHub diffs head against the merge-base, which here is the base tip
    // at open time when the base has not moved. Use the stored open-time
    // base tree when the base has moved, so the file list stays stable.
    const baseTree = (() => {
      const baseObject = this.getObject(repo, pull.baseShaAtOpen);
      if (baseObject === null || baseObject.type !== 'commit') return baseFlat;
      return this.flattenTree(repo, parseCommit(baseObject.data).tree, '', new Map());
    })();
    const headFlat = this.flatOfRef(repo, pull.head.ref);
    return this.diffFlat(repo, baseTree, headFlat);
  }

  // MERGEABLE / CONFLICTING / UNKNOWN for a pull request, from a three-way
  // merge of its head onto the base branch's current tip.
  pullMergeable(repo, pull) {
    if (pull.state !== 'open') return 'UNKNOWN';
    const check = this.mergePlan(repo, pull);
    if (check.error !== undefined) return 'UNKNOWN';
    return check.conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  // Plan a squash merge: three-way merge of the head's changes onto the
  // base tip. Returns {conflict: bool, tree: Map} or {error}.
  mergePlan(repo, pull) {
    const baseTip = this.refTip(repo, `refs/heads/${pull.base.ref}`);
    const headTip = this.refTip(repo, `refs/heads/${pull.head.ref}`);
    if (baseTip === null || headTip === null) return { error: 'missing-branch' };
    const ancestorFlat = (() => {
      const baseObject = this.getObject(repo, pull.baseShaAtOpen);
      if (baseObject === null || baseObject.type !== 'commit') return new Map();
      return this.flattenTree(repo, parseCommit(baseObject.data).tree, '', new Map());
    })();
    const baseFlat = this.flatOfRef(repo, pull.base.ref);
    const headFlat = this.flatOfRef(repo, pull.head.ref);
    const merged = new Map(baseFlat);
    let conflict = false;
    const paths = new Set([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFlat.get(path);
      const base = baseFlat.get(path);
      const head = headFlat.get(path);
      const headChanged = (ancestor?.oid ?? null) !== (head?.oid ?? null);
      const baseChanged = (ancestor?.oid ?? null) !== (base?.oid ?? null);
      if (!headChanged) continue; // head did not touch it: keep base's version
      if (!baseChanged) {
        // Only the head changed it: take the head's version.
        if (head === undefined) merged.delete(path);
        else merged.set(path, head);
        continue;
      }
      // Both sides changed it.
      if ((base?.oid ?? null) === (head?.oid ?? null)) continue; // same change
      conflict = true;
    }
    return { conflict, tree: merged, baseTip, headTip };
  }

  // Squash-merge an open pull request onto its base branch. Returns
  // {mergeSha} or {error: 'unknown'|'closed'|'conflict'}.
  mergePull(repo, pull) {
    if (pull.state !== 'open') return { error: pull.merged ? 'closed' : 'closed' };
    const plan = this.mergePlan(repo, pull);
    if (plan.error !== undefined) return { error: 'unknown' };
    if (plan.conflict) return { error: 'conflict' };
    const treeOid = this.buildTreeFromFlat(repo, plan.tree);
    const message = `Merge pull request #${pull.number} from ${VIEWER.login}/${pull.head.ref}`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [plan.baseTip],
      message,
      author: IDENTITY,
      committer: IDENTITY,
      timestamp: this.nextTimestamp(),
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    this.setRef(repo, `refs/heads/${pull.base.ref}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = FIXED_DATE;
    pull.merge_commit_sha = mergeSha;
    return { mergeSha };
  }
}

export { b64encode };
