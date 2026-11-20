// The HTTP server: one process speaking every surface — git smart HTTP, REST v3,
// GraphQL v4 and MCP — over one shared Forge. main.ts owns the lifecycle (bind, register,
// poll /done); this file only builds the server.
//
// Auth: the API surfaces (/api/v3, /api/graphql, /mcp) require `Authorization: Bearer
// <MAKEFUN_SHOP_TOKEN>` when that env var is set, and any non-empty bearer otherwise.
// The git paths are not gated (the suite's git client sends no token). /healthz is open.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' || token === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
}

function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function handleGraphQL(forge: Forge, res: ServerResponse, bodyText: string): void {
  const parsed = parseJsonBody(bodyText);
  if (!parsed.ok || parsed.value === undefined) {
    sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': nextRequestId() });
    return;
  }
  const runOne = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    if (query === '') return { data: null, errors: [{ message: 'query is required' }] };
    let variables: Record<string, unknown> = {};
    if (typeof record.variables === 'string') {
      const variablesParsed = parseJsonBody(record.variables);
      if (variablesParsed.ok && typeof variablesParsed.value === 'object' && variablesParsed.value !== null && !Array.isArray(variablesParsed.value)) {
        variables = variablesParsed.value as Record<string, unknown>;
      }
    } else if (typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables)) {
      variables = record.variables as Record<string, unknown>;
    }
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    return executeGraphQL(forge, query, variables, operationName);
  };
  const result = Array.isArray(parsed.value) ? parsed.value.map(runOne) : runOne(parsed.value);
  sendJson(res, 200, result, { 'x-github-request-id': nextRequestId() });
}

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const segments = pathSegments(url.pathname);
  const method = req.method ?? 'GET';

  // Boot probe: open, no auth.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    const repo = forge.getRepo(owner, repoName);
    if (method === 'GET' && segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
      handleInfoRefs(req, res, repo, url.searchParams.get('service'));
      return;
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'git-upload-pack') {
      handleUploadPack(res, repo, await readBody(req));
      return;
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'git-receive-pack') {
      handleReceivePack(res, repo, await readBody(req));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3: /api/v3/...
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': nextRequestId() });
      return;
    }
    const bodyText = method === 'GET' || method === 'HEAD' ? '' : (await readBody(req)).toString('utf8');
    const parsed = parseJsonBody(bodyText);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': nextRequestId() });
      return;
    }
    const reply = handleRest(forge, {
      method,
      segments: segments.slice(2),
      query: url.searchParams,
      body: parsed.value,
      host: req.headers.host ?? 'forge.invalid',
    });
    sendJson(res, reply.status, reply.body, { ...reply.headers, 'x-github-request-id': nextRequestId() });
    return;
  }

  // GraphQL v4: /api/graphql
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': nextRequestId() });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': nextRequestId() });
      return;
    }
    handleGraphQL(forge, res, (await readBody(req)).toString('utf8'));
    return;
  }

  // MCP: /mcp
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method === 'DELETE') {
      res.writeHead(200, { 'content-length': 0 });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method Not Allowed' } });
      return;
    }
    const reply = handleMcp(forge, (await readBody(req)).toString('utf8'));
    if (reply.body === null) {
      res.writeHead(reply.status, { 'content-length': 0 });
      res.end();
    } else {
      sendJson(res, reply.status, reply.body);
    }
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req, res) => {
    handle(forge, req, res).catch(() => {
      // A handler failure must never take the process down: answer 500 and keep serving.
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else if (!res.writableEnded) res.end();
    });
  });
  return server;
}
