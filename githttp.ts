// Git smart HTTP: info/refs advertisements (v0 and v2), upload-pack (ls-refs and fetch,
// including shallow depth), and receive-pack (push with fast-forward checks and
// report-status). The wire shapes follow git's pack protocol as the suite's client speaks it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  peelToNonTag,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import type { Forge, Repo } from './store.ts';

const AGENT = 'forge/1.0';
const SIDEBAND_CHUNK = 65515;

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const headOid = repo.branchTip(repo.defaultBranch);
  const refLines: string[] = [];
  if (service === 'git-upload-pack' && headOid !== undefined) refLines.push(`${headOid} HEAD`);
  for (const [name, oid] of refs) {
    refLines.push(`${oid} ${name}`);
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') refLines.push(`${peelToNonTag(repo.lookup, oid)} ${name}^{}`);
  }
  if (refLines.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refLines.forEach((line, index) => {
      lines.push(index === 0 ? `${line}\0${caps}\n` : `${line}\n`);
    });
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo | undefined, service: string | null): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendText(res, 400, 'invalid service\n');
    return;
  }
  if (repo === undefined) {
    sendText(res, 404, 'repository not found\n');
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  sendBuffer(res, 200, contentType, wantsV2 ? v2Advertisement() : v0Advertisement(repo, service));
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  send: string[];
  shallow: string[];
  unshallow: string[];
  common: string[];
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
  deepenRelative = false,
): FetchPlan {
  const lookup = repo.lookup;
  // Breadth-first over commits from the wants, depth-limited when asked. A plain `deepen N`
  // limits to N generations from the wants; with `deepen-relative` the N generations are
  // counted beyond the client's shallow boundary commits instead.
  const includedCommits = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commit = peelToNonTag(lookup, want);
    if (lookup(commit)?.type === 'commit' && !depthOf.has(commit)) {
      depthOf.set(commit, 1);
      queue.push(commit);
    }
  }
  let limit = depth;
  if (deepenRelative && depth !== null && shallowBoundaries.length > 0) {
    // Walk the full ancestry first so the boundary commits' depths are known.
    const fullQueue = [...queue];
    const fullDepth = new Map(depthOf);
    while (fullQueue.length) {
      const oid = fullQueue.shift()!;
      const object = lookup(oid);
      if (object?.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!fullDepth.has(parent)) {
          fullDepth.set(parent, fullDepth.get(oid)! + 1);
          fullQueue.push(parent);
        }
      }
    }
    let boundaryDepth = 0;
    for (const boundaryOid of shallowBoundaries) {
      const d = fullDepth.get(boundaryOid);
      if (d !== undefined && d > boundaryDepth) boundaryDepth = d;
    }
    if (boundaryDepth > 0) {
      limit = boundaryDepth + depth;
      for (const [oid, d] of fullDepth) depthOf.set(oid, d);
      queue.length = 0;
      queue.push(...fullDepth.keys());
    }
  }
  while (queue.length) {
    const oid = queue.shift()!;
    const d = depthOf.get(oid)!;
    if (limit !== null && d > limit) continue;
    includedCommits.add(oid);
    if (limit !== null && d >= limit) continue;
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!depthOf.has(parent)) {
        depthOf.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  const boundary = new Set<string>();
  if (limit !== null) {
    for (const oid of includedCommits) {
      if (depthOf.get(oid) !== limit) continue;
      const object = lookup(oid);
      if (object?.type !== 'commit') continue;
      if (parseCommit(object.data).parents.some((parent) => !includedCommits.has(parent))) boundary.add(oid);
    }
  }
  const included = collectReachable(wants, lookup, boundary);
  const excluded = collectReachable(haves, lookup, new Set(shallowBoundaries));
  const send = [...included].filter((oid) => !excluded.has(oid)).sort();
  const unshallow = shallowBoundaries.filter((oid) => includedCommits.has(oid) && !boundary.has(oid));
  const common = haves.filter((oid) => included.has(oid));
  return { send, shallow: [...boundary].sort(), unshallow, common };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    packets.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(encodePktLine(Buffer.from([1])));
  return packets;
}

function buildPack(repo: Repo, oids: readonly string[]): Buffer {
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return writePack(objects);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const headOid = repo.branchTip(repo.defaultBranch);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      lines.push(args.symrefs ? `${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headOid} HEAD\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    } else if (args.symrefs) {
      lines.push(`${ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel && repo.objects.get(oid)?.type === 'tag') line += ` peeled:${peelToNonTag(repo.lookup, oid)}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenRelative: boolean;
  done: boolean;
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenRelative);
  const parts: Buffer[] = [];
  // The acknowledgments section answers negotiation: it is sent only when the client
  // offered haves. A fresh clone (wants + done, no haves) expects shallow-info or the
  // packfile section straight away. And when the client has not said `done` and nothing
  // is in common yet, the reply is the acknowledgments section alone — a packfile after
  // a bare NAK is a protocol error; the client negotiates another round instead.
  const negotiating = !args.done && plan.common.length === 0;
  if (args.haves.length > 0 || negotiating) {
    const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
    if (plan.common.length > 0) {
      for (const oid of plan.common) ackLines.push(`ACK ${oid}\n`);
      ackLines.push('ready\n');
    } else {
      ackLines.push('NAK\n');
    }
    ackLines.push('delim');
    parts.push(encodePktLines(ackLines));
    if (negotiating) {
      parts.push(encodePktLines(['flush']));
      return Buffer.concat(parts);
    }
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push('delim');
    parts.push(encodePktLines(shallowLines));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPackets(buildPack(repo, plan.send)));
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenRelative);
  // Without `done` the client is still negotiating: answer ACK/NAK lines only, no pack.
  if (!args.done) {
    const ackLines: Array<string | 'flush'> =
      plan.common.length > 0 ? plan.common.map((oid) => `ACK ${oid}\n`) : ['NAK\n'];
    ackLines.push('flush');
    return encodePktLines(ackLines);
  }
  const lines: Array<string | 'flush'> = [];
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  if (plan.common.length > 0) {
    for (const oid of plan.common) lines.push(`ACK ${oid}\n`);
  } else {
    lines.push('NAK\n');
  }
  const parts: Buffer[] = [encodePktLines(lines), ...sidebandPackets(buildPack(repo, plan.send)), encodePktLines(['flush'])];
  return Buffer.concat(parts);
}

export function handleUploadPack(res: ServerResponse, repo: Repo | undefined, body: Buffer): void {
  if (repo === undefined) {
    sendText(res, 404, 'repository not found\n');
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body, true).packets;
  } catch {
    sendText(res, 400, 'malformed pkt-line\n');
    return;
  }
  const dataLines: string[] = [];
  let sawDelim = false;
  const argsAfterDelim: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (sawDelim) argsAfterDelim.push(text);
    else dataLines.push(text);
  }
  const first = (dataLines[0] ?? '').replace(/\n$/, '');

  if (first.startsWith('command=')) {
    const command = first.slice('command='.length);
    if (command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const raw of argsAfterDelim) {
        const line = raw.replace(/\n$/, '');
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
      return;
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false, done: false };
      for (const raw of argsAfterDelim) {
        const line = raw.replace(/\n$/, '');
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) {
          const n = Number.parseInt(line.slice(7), 10);
          if (Number.isFinite(n) && n > 0) args.depth = n;
        } else if (line === 'deepen-relative') args.deepenRelative = true;
        else if (line === 'done') args.done = true;
      }
      args.wants = args.wants.filter(isObjectId);
      args.haves = args.haves.filter(isObjectId);
      args.shallow = args.shallow.filter(isObjectId);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchResponseV2(repo, args));
      return;
    }
    sendText(res, 400, `unknown command ${command}\n`);
    return;
  }

  // v0: want lines (the first may carry capabilities), shallow/deepen, flush, have lines, done, flush.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false, done: false };
  let inWants = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      inWants = false;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!;
      if (isObjectId(oid)) args.wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line === 'deepen-relative') {
      args.deepenRelative = true;
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) args.haves.push(oid);
    } else if (line === 'done') {
      args.done = true;
    }
  }
  void inWants;
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchResponseV0(repo, args));
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(res: ServerResponse, repo: Repo | undefined, body: Buffer): void {
  if (repo === undefined) {
    sendText(res, 404, 'repository not found\n');
    return;
  }
  let decoded;
  try {
    decoded = decodePktLines(body);
  } catch {
    sendText(res, 400, 'malformed pkt-line\n');
    return;
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      text = text.slice(0, nul);
    }
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3 && isObjectId(parts[0]!) && isObjectId(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = body.subarray(decoded.consumed);

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, repo.lookup);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} missing object ${command.newOid}\n`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID && !isAncestor(repo.lookup, current, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const innerReport = encodePktLines([...reportLines, 'flush']);
  let response: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < innerReport.length; offset += SIDEBAND_CHUNK) {
      const chunk = innerReport.subarray(offset, Math.min(innerReport.length, offset + SIDEBAND_CHUNK));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(encodePktLines(['flush']));
    response = Buffer.concat(parts);
  } else {
    response = innerReport;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', response);
}
