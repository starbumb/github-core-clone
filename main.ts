// Entrypoint: the trial lifecycle wrapped around the forge server from app.ts.
//
// The contract (kit RULES.txt): bind an ephemeral port — port 0, never 8080,
// which belongs to the suite — then POST {"port": N} to $MAKEFUN_ENV_URL/register
// so the suite knows where to dial. While the suite drives the forge, keep asking
// GET $MAKEFUN_ENV_URL/done; it answers {"done": false} until its export is
// written, then {"done": true}, and on that answer this process exits 0.
//
// Run by hand without MAKEFUN_ENV_URL, the same server simply serves until it is
// signalled, which is how the local conformance runner is pointed at it.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from './app.ts';

/** Where the suite listens, e.g. http://127.0.0.1:8080; empty for a hand-run server. */
const suiteBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** How long to keep trying to register before giving up (the suite should already be up). */
const REGISTER_BUDGET_MS = 30_000;
/** Pause between two /done polls that answered "not yet". */
const DONE_POLL_PAUSE_MS = 150;
/** Grace for open connections to drain at shutdown before the exit is forced. */
const SHUTDOWN_GRACE_MS = 1_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SuiteReply {
  status: number;
  text: string;
}

/** One request to the suite, on a fresh socket that closes with the reply. */
function askSuite(method: 'GET' | 'POST', path: string, bodyText?: string): Promise<SuiteReply> {
  return new Promise((resolve, reject) => {
    const target = new URL(suiteBase + path);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method,
        agent: false,
        headers:
          bodyText === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyText) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

/** Tell the suite which port the forge bound; retry while it is still coming up. */
async function announcePort(port: number): Promise<void> {
  const body = JSON.stringify({ port });
  const deadline = Date.now() + REGISTER_BUDGET_MS;
  let lastFailure: unknown = new Error('register was never attempted');
  while (Date.now() < deadline) {
    try {
      const reply = await askSuite('POST', '/register', body);
      if (reply.status >= 200 && reply.status < 300) return;
      lastFailure = new Error(`register answered HTTP ${reply.status}`);
    } catch (err) {
      lastFailure = err;
    }
    await pause(200);
  }
  throw lastFailure;
}

/** Poll /done until the suite says its export is written. A failed poll is just retried. */
async function awaitSuiteDone(): Promise<void> {
  for (;;) {
    try {
      const reply = await askSuite('GET', '/done');
      if (reply.status >= 200 && reply.status < 300) {
        const parsed: unknown = JSON.parse(reply.text);
        if (typeof parsed === 'object' && parsed !== null && (parsed as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // No verdict in a dropped poll: wait a beat and ask again.
    }
    await pause(DONE_POLL_PAUSE_MS);
  }
}

/** Stop accepting, let in-flight replies finish briefly, then exit 0 either way. */
function shutDown(server: Server): void {
  const forceExit = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  forceExit.unref();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the kernel picks a free ephemeral port; 8080 is the suite's own.
    server.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  process.stderr.write(`forge: listening on port ${port}\n`);

  process.once('SIGTERM', () => shutDown(server));
  process.once('SIGINT', () => shutDown(server));

  if (suiteBase === '') return; // Hand-run: serve until signalled.

  await announcePort(port);
  await awaitSuiteDone();
  shutDown(server);
}

run().catch((err: unknown) => {
  process.stderr.write(`forge: startup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
