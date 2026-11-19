// gitproto.ts — git smart HTTP: pkt-line codec, info/refs advertisements,
// ls-refs / fetch (protocol v2 and v0) and receive-pack (v0 only).
// The wire contract is the kit's git-client.ts: every behaviour here is
// written against what that client parses and what checks-git.ts asserts.

import {
  ZERO_OID,
  parseCommit,
  parseTag,
  readPack,
  writePack,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

const PKT_LINE_MAX = 65520;

export function pktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line of ${length} bytes exceeds ${PKT_LINE_MAX}`);
  const header = Buffer.alloc(4);
  header.write(length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush() {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim() {
  return Buffer.from('0001', 'ascii');
}

export function pktLines(lines) {
  return Buffer.concat(lines.map((line) => (typeof line === 'string' ? pktLine(line) : line)));
}

// Parse a whole body into packets. Throws on malformed input.
export function parsePktLines(buffer) {
  const packets = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (header === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(header, 16);
    if (!Number.isInteger(length) || length < 4 || length > PKT_LINE_MAX) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

// Split data into sideband packets (band byte + chunk), each a valid pkt-line.
export function sidebandPackets(band, data) {
  const out = [];
  const chunkSize = PKT_LINE_MAX - 4 - 1; // header + band byte
  if (data.length === 0) return out;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + chunkSize));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ref listing
// ---------------------------------------------------------------------------

const DEFAULT_BRANCH = 'main';

// Every ref the server advertises, in order: HEAD first, then refs in
// creation order. Each entry: {oid, name, peeled?, symrefTarget?, unborn?}.
export function listRefs(store, repo) {
  const out = [];
  const headTip = store.refTip(repo, `refs/heads/${DEFAULT_BRANCH}`);
  const head = {
    oid: headTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: `refs/heads/${DEFAULT_BRANCH}`,
    unborn: headTip === null,
  };
  out.push(head);
  for (const ref of repo.refOrder) {
    const oid = repo.refs.get(ref);
    const entry = { oid, name: ref };
    const object = store.getObject(repo, oid);
    if (object !== null && object.type === 'tag') {
      entry.peeled = parseTag(object.data).object;
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

const V2_CAPABILITIES = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];

function servicePreamble(service) {
  return pktLine(`# service=${service}\n`);
}

function v2Advertisement() {
  const lines = [pktLine('version 2\n')];
  for (const capability of V2_CAPABILITIES) lines.push(pktLine(`${capability}\n`));
  return Buffer.concat([...lines, pktFlush()]);
}

function v0Advertisement(store, repo, service, capabilities) {
  const refs = listRefs(store, repo);
  const lines = [];
  if (refs.length === 1 && refs[0].unborn === true) {
    // Empty repo: the capabilities^{} pseudo-ref carries the capabilities.
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`));
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0;
      const line = first ? `${ref.oid} ${ref.name}\u0000${capabilities}\n` : `${ref.oid} ${ref.name}\n`;
      lines.push(pktLine(line));
      if (ref.peeled !== undefined) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  return Buffer.concat([...lines, pktFlush()]);
}

function uploadPackV0Capabilities() {
  return 'side-band-64k shallow thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/main agent=gitforge/1.0';
}

function receivePackCapabilities() {
  return 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=gitforge/1.0';
}

export function infoRefsBody(store, repo, service, version2) {
  const preamble = servicePreamble(service);
  if (service === 'git-upload-pack' && version2) {
    return Buffer.concat([preamble, pktFlush(), v2Advertisement()]);
  }
  const capabilities = service === 'git-upload-pack' ? uploadPackV0Capabilities() : receivePackCapabilities();
  return Buffer.concat([preamble, pktFlush(), v0Advertisement(store, repo, service, capabilities)]);
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

function parseFetchRequest(packets, version2) {
  const request = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (version2) {
      if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
    } else {
      // v0: the first want line carries capabilities after the oid.
      if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
    }
  }
  return request;
}

function parseLsRefsRequest(packets) {
  const args = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue; // command= / agent= / object-format= lines
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

// The objects + shallow bookkeeping for a fetch request.
function computeFetch(store, repo, request) {
  const depth = request.depth === undefined ? undefined : request.depth;
  const result = store.fetchObjects(repo, {
    wants: request.wants,
    haves: request.haves,
    shallow: request.shallow,
    depth,
  });
  // New shallow boundaries: included commits at the depth cutoff that have
  // parents (the walk stopped there).
  const boundaries = [];
  const unshallow = [];
  if (depth !== undefined) {
    const depthLimit = depth - 1;
    for (const [oid, atDepth] of result.commits) {
      if (atDepth !== depthLimit) continue;
      const object = store.getObject(repo, oid);
      if (object !== null && object.type === 'commit' && parseCommit(object.data).parents.length > 0) {
        boundaries.push(oid);
      }
    }
    for (const old of request.shallow) {
      const object = store.getObject(repo, old);
      if (object === null || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => result.commits.has(parent))) unshallow.push(old);
    }
  }
  // ACK every have that is an ancestor of a want; otherwise NAK.
  const acks = [];
  for (const have of request.haves) {
    if (have === ZERO_OID) continue;
    if (request.wants.some((want) => store.isAncestor(repo, have, want))) acks.push(have);
  }
  // Wanted refs: refs whose tip is one of the wants.
  const wantedRefs = [];
  for (const ref of repo.refOrder) {
    const tip = repo.refs.get(ref);
    if (request.wants.includes(tip)) wantedRefs.push({ oid: tip, ref });
  }
  const headTip = store.refTip(repo, `refs/heads/${DEFAULT_BRANCH}`);
  if (headTip !== null && request.wants.includes(headTip)) {
    wantedRefs.push({ oid: headTip, ref: 'HEAD' });
  }
  return { objects: result.objects, boundaries, unshallow, acks, wantedRefs };
}

function handleLsRefs(store, repo, packets) {
  const args = parseLsRefsRequest(packets);
  const refs = listRefs(store, repo);
  const lines = [];
  for (const ref of refs) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    if (ref.unborn === true && !args.unborn) continue;
    if (ref.unborn === true) {
      const suffix = args.symrefs && ref.symrefTarget !== undefined ? ` symref-target:${ref.symrefTarget}` : '';
      lines.push(pktLine(`unborn ${ref.name}${suffix}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (args.symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(pktLine(`${line}\n`));
  }
  return Buffer.concat([...lines, pktFlush()]);
}

function handleFetchV2(store, repo, packets) {
  const request = parseFetchRequest(packets, true);
  const result = computeFetch(store, repo, request);
  const parts = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (result.acks.length > 0) {
    for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  // shallow-info
  if (result.boundaries.length > 0 || result.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.boundaries) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // wanted-refs
  if (result.wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const entry of result.wantedRefs) parts.push(pktLine(`${entry.oid} ${entry.ref}\n`));
    parts.push(pktDelim());
  }
  // packfile
  if (result.objects.size > 0) {
    const pack = writePack([...result.objects.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data })));
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(1, pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV0(store, repo, packets) {
  const request = parseFetchRequest(packets, false);
  const result = computeFetch(store, repo, request);
  const parts = [];
  if (result.acks.length > 0) {
    for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of result.boundaries) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (result.objects.size > 0) {
    const pack = writePack([...result.objects.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data })));
    parts.push(...sidebandPackets(1, pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(store, repo, body, version2) {
  const packets = parsePktLines(body);
  if (version2) {
    const first = packets.find((packet) => packet.kind === 'data');
    const command = first === undefined ? '' : first.payload.toString('utf8').replace(/\n$/, '');
    if (command === 'command=ls-refs') return handleLsRefs(store, repo, packets);
    if (command === 'command=fetch') return handleFetchV2(store, repo, packets);
    throw new Error(`unknown v2 upload-pack command ${JSON.stringify(command)}`);
  }
  return handleFetchV0(store, repo, packets);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

// Parse the command list at the head of a receive-pack body. Returns
// {commands, capabilities, packOffset} — packOffset is where the pack bytes
// start (or body.length when there is no pack).
function parseReceivePack(body) {
  const commands = [];
  let capabilities = [];
  let offset = 0;
  let first = true;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line header in receive-pack');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      offset += 4;
      break;
    }
    const length = Number.parseInt(header, 16);
    if (!Number.isInteger(length) || length < 4 || length > PKT_LINE_MAX) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)} in receive-pack`);
    }
    if (offset + length > body.length) throw new Error('truncated pkt-line payload in receive-pack');
    let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    if (first) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command line ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new Error('receive-pack with no commands');
  return { commands, capabilities, packOffset: offset };
}

export function handleReceivePack(store, repo, body) {
  const { commands, capabilities, packOffset } = parseReceivePack(body);
  const useSideband = capabilities.includes('side-band-64k');
  const wantsUpdate = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError = null;
  if (wantsUpdate && packOffset < body.length) {
    try {
      const read = readPack(body.subarray(packOffset));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  } else if (wantsUpdate && packOffset >= body.length) {
    unpackError = 'unpacker error: no pack data';
  }

  // Decide each ref update; apply only the ok ones.
  const reportLines = [];
  reportLines.push(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`);
  for (const command of commands) {
    let reason = null;
    if (unpackError !== null) {
      reason = 'unpacker error';
    } else {
      const current = repo.refs.get(command.ref) ?? null;
      const isTag = command.ref.startsWith('refs/tags/');
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === null) reason = 'ref does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'old value does not match';
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== null) reason = 'already exists';
        else if (!isTag && store.getObject(repo, command.newOid) === null) reason = 'object not found';
        else if (isTag && store.getObject(repo, command.newOid) === null) reason = 'object not found';
      } else {
        // Update.
        if (current === null) reason = 'ref does not exist';
        else if (command.oldOid !== current) reason = 'old value does not match';
        else if (isTag) reason = 'non-fast-forward';
        else if (!store.isAncestor(repo, command.oldOid, command.newOid)) reason = 'non-fast-forward';
      }
    }
    if (reason === null) {
      if (command.newOid === ZERO_OID) store.deleteRef(repo, command.ref);
      else store.setRef(repo, command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    } else {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    }
  }

  const report = pktLines(reportLines);  if (useSideband) {
    return Buffer.concat([...sidebandPackets(1, report), pktFlush()]);
  }
  return Buffer.concat([report, pktFlush()]);
}
