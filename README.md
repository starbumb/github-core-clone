[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/starbumb/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/starbumb/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone

A GitHub-compatible git forge in one Node.js process — no dependencies, Node built-ins only, all state in memory. Built for the make.fun bounty **github-core-clone-01**.

## What it speaks

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch` with shallow/deepen incl. `deepen-relative`, side-band-64k) and v0 fallback; `git-receive-pack` with report-status, fast-forward enforcement and branch deletion. Works with the real `git` CLI: clone, shallow clone, deepen, unshallow, push, tags.
- **REST v3** (`/api/v3`) — repositories, branches, commits, contents (get/put/delete with sha checks), git refs, labels, issues, comments, pull requests (list/create/files/squash-merge), pagination with `Link` headers, GitHub-shaped errors.
- **GraphQL v4** (`/api/graphql`) — viewer, repository, node(id:), issue/pull-request connections with cursor pagination, createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations, `__type` introspection, batched operations.
- **MCP** (`/mcp`) — Streamable HTTP JSON-RPC 2.0 with `server/discover` and legacy `initialize`; tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

Every surface reads and writes the same in-memory store, so an issue created over MCP is the same object REST and GraphQL return.

## Running

```sh
node --experimental-strip-types main.ts
```

`main.ts` follows the make.fun env lifecycle: it binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and serves until the env says done. `MAKEFUN_SHOP_TOKEN` is the bearer token the API surfaces require; `MAKEFUN_TRIAL_NOW` seeds the deterministic clock (no wall-clock or randomness in request handling).

## Layout

| File | Role |
| --- | --- |
| `main.ts` | env lifecycle: bind, register, poll `/done` |
| `app.ts` | HTTP server, auth gate, routing |
| `gitobj.ts` | git object model: hashing, trees/commits/tags, pkt-lines, pack read/write, reachability |
| `githttp.ts` | smart-HTTP advertisements, fetch planning, receive-pack |
| `store.ts` | in-memory forge state (repos, issues, pulls, labels, comments) |
| `ops.ts` | shared issue/pull operations and squash merge |
| `rest.ts` | REST v3 routes |
| `graphql.ts` | GraphQL parser + executor |
| `mcp.ts` | MCP tools over JSON-RPC |

## License

MIT — see [LICENSE](LICENSE).
