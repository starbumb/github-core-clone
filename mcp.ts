// MCP (Model Context Protocol) over Streamable HTTP: JSON-RPC 2.0 at POST /mcp. The suite
// probes server/discover first (the 2026-07-28 revision) and falls back to the legacy
// initialize handshake, so both are answered. The tool list is a fixed constant, so two
// tools/list replies are byte-identical. Tool results carry the same JSON shapes as REST.

import { createIssue, createPull, isOpError, mergePull } from './ops.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Forge } from './store.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

export interface McpReply {
  status: number;
  body: unknown;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function toolResult(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      if (typeof args.owner === 'string' && args.owner !== '') forge.learnOwner(args.owner);
      const repoName = str(args.name);
      if (repoName === '') return toolError('name is required');
      const repo = forge.createRepo(repoName, str(args.description), args.private === true);
      if (repo === null) return toolError(`repository ${repoName} already exists`);
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = forge.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      return toolResult(repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = forge.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      const created = createIssue(forge, repo, { title: str(args.title), body: str(args.body) });
      if (isOpError(created)) return toolError(created.error);
      return toolResult(issueJson(forge, repo, created));
    }
    case 'list_issues': {
      const repo = forge.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(forge, repo, issue));
      return {
        content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }],
        structuredContent: { issues },
        isError: false,
      };
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      const created = createPull(forge, repo, {
        title: str(args.title),
        body: str(args.body),
        head: str(args.head),
        base: str(args.base),
      });
      if (isOpError(created)) return toolError(created.error);
      return toolResult(pullJson(forge, repo, created));
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return toolError(`repository ${str(args.owner)}/${str(args.repo)} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`pull request #${number} not found`);
      const merged = mergePull(forge, repo, pull);
      if (isOpError(merged)) return toolError(merged.error);
      return toolResult({ ...pullJson(forge, repo, pull), sha: merged.sha, merged: true });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

function handleMessage(forge: Forge, message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) return rpcError(null, -32600, 'Invalid Request');
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = isRecord(message.params) ? message.params : {};
  // Notifications (no id) are acknowledged with no response body.
  if (id === undefined) return null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const required = (tool.inputSchema as { required?: readonly string[] }).required ?? [];
      const missing = required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
      if (missing.length > 0) return rpcResult(id, toolError(`missing required argument: ${missing.join(', ')}`));
      try {
        return rpcResult(id, callTool(forge, name, args));
      } catch (err) {
        return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(forge: Forge, bodyText: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed
      .map((message) => handleMessage(forge, message))
      .filter((reply): reply is Record<string, unknown> => reply !== null);
    return replies.length > 0 ? { status: 200, body: replies } : { status: 202, body: null };
  }
  const reply = handleMessage(forge, parsed);
  return reply === null ? { status: 202, body: null } : { status: 200, body: reply };
}
