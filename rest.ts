// GitHub REST v3, the routes the suite drives: repositories, branches, commits, contents,
// labels, issues, comments and pull requests. Every reply is JSON with a `message` on
// errors; lists paginate with Link headers; a repository the token does not own is a 404,
// never a 403.

import { lookupTreePath, parseTree, treeOf } from './gitobj.ts';
import { createIssue, createPull, isOpError, mergePull, pullChangedFiles } from './ops.ts';
import { globalId, type Forge, type Issue, type Pull, type Repo } from './store.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3 (no leading empty segment). */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body, or undefined when the request carried none. */
  body: unknown;
  /** The Host header, for absolute pagination links. */
  host: string;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fail(status: number, message: string): RestReply {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown): boolean {
  return value === true;
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userJson(forge: Forge): Record<string, unknown> {
  const login = forge.viewerLogin ?? 'forge';
  return { login, id: 1, node_id: globalId('User', [login]), type: 'User', site_admin: false };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', [repo.id]),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: 1, node_id: globalId('User', [repo.owner]), type: 'User' },
    html_url: `/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number * 2,
    node_id: globalId('Issue', [repo.id, issue.number]),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed', default: false })),
    user: userJson(forge),
    comments: repo.comments.filter((comment) => comment.issueNumber === issue.number).length,
    created_at: forge.nowIso(),
    updated_at: forge.nowIso(),
    html_url: `/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? '0'.repeat(40);
  const baseSha = repo.branchTip(pull.baseRef) ?? '0'.repeat(40);
  return {
    id: repo.id * 100000 + pull.number * 2 + 1,
    node_id: globalId('PullRequest', [repo.id, pull.number]),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(forge),
    created_at: forge.nowIso(),
    updated_at: forge.nowIso(),
    html_url: `/${repo.fullName}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1,
  };
}

function pageSlice<T>(items: readonly T[], page: Page): T[] {
  return items.slice((page.page - 1) * page.perPage, page.page * page.perPage);
}

function linkHeaders(req: RestRequest, total: number, page: Page): Record<string, string> | undefined {
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  if (page.page >= lastPage) return undefined;
  const path = `/api/v3/${req.segments.map(encodeURIComponent).join('/')}`;
  const urlFor = (target: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(page.perPage));
    params.set('page', String(target));
    return `http://${req.host}${path}?${params.toString()}`;
  };
  const links = [`<${urlFor(page.page + 1)}>; rel="next"`, `<${urlFor(lastPage)}>; rel="last"`];
  return { link: links.join(', ') };
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return fail(404, 'Not Found');
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'repo, read:org' },
      body: {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: '/settings/connections/applications',
        rate_limit_url: '/api/v3/rate_limit',
        user_url: '/api/v3/users/{user}',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      },
    };
  }

  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return fail(404, 'Not Found');
    return { status: 200, body: { installed_version: '3.14.0', verifiable_password_authentication: true } };
  }

  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return fail(404, 'Not Found');
    if (forge.viewerLogin === null) return fail(404, 'Not Found');
    return { status: 200, body: { ...userJson(forge), name: forge.viewerLogin } };
  }

  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const page = pageOf(req.query);
      const repos = forge.viewerRepos();
      return { status: 200, body: pageSlice(repos, page).map((repo) => repoJson(forge, repo)), headers: linkHeaders(req, repos.length, page) };
    }
    if (method === 'POST') {
      if (!isRecord(req.body)) return fail(422, 'Validation Failed: body must be a JSON object');
      const name = str(req.body.name);
      if (name === '') return fail(422, 'Validation Failed: name is required');
      const repo = forge.createRepo(name, str(req.body.description), bool(req.body.private));
      if (repo === null) return fail(422, `Validation Failed: name already exists on this account`);
      return { status: 201, body: repoJson(forge, repo) };
    }
    return fail(404, 'Not Found');
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1]!;
    const name = seg[2]!;
    const rest = seg.slice(3);
    const repo = forge.getRepo(owner, name);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (repo === undefined) return fail(404, 'Not Found');
        return { status: 200, body: repoJson(forge, repo) };
      }
      if (method === 'PATCH') {
        if (repo === undefined) return fail(404, 'Not Found');
        if (isRecord(req.body)) {
          if (typeof req.body.description === 'string') repo.description = req.body.description;
          if (typeof req.body.private === 'boolean') repo.isPrivate = req.body.private;
          repo.updatedAt = forge.tick().iso;
        }
        return { status: 200, body: repoJson(forge, repo) };
      }
      if (method === 'DELETE') {
        if (repo === undefined) return fail(404, 'Not Found');
        forge.deleteRepo(owner, name);
        return { status: 204 };
      }
      return fail(404, 'Not Found');
    }

    if (repo === undefined) return fail(404, 'Not Found');
    return handleRepoScoped(forge, repo, req, rest);
  }

  return fail(404, 'Not Found');
}

function handleRepoScoped(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestReply {
  const method = req.method;
  const head = rest[0]!;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.branchTip(branch);
      if (sha === undefined) return fail(404, 'Branch not found');
      return { status: 200, body: { name: branch, commit: { sha } } };
    }
    return fail(404, 'Not Found');
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = req.query.get('sha');
    const tip = shaParam === null ? repo.branchTip(repo.defaultBranch) : repo.resolveRef(shaParam);
    if (tip === undefined) return { status: 200, body: [] };
    const page = pageOf(req.query);
    const commits = repo.commitList(tip, 10000).map((commit) => ({
      sha: commit.sha,
      commit: {
        message: commit.message.replace(/\n+$/, ''),
        author: identJson(commit.author),
        committer: identJson(commit.committer),
      },
      parents: commit.parents.map((sha) => ({ sha })),
      author: userJson(forge),
    }));
    return { status: 200, body: pageSlice(commits, page), headers: linkHeaders(req, commits.length, page) };
  }

  if (head === 'contents') {
    return handleContents(forge, repo, req, rest.slice(1));
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      if (!isRecord(req.body)) return fail(422, 'Validation Failed: body must be a JSON object');
      const ref = str(req.body.ref);
      const sha = str(req.body.sha);
      if (!ref.startsWith('refs/') || sha === '') return fail(422, 'Validation Failed: ref and sha are required');
      if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
      const object = repo.objects.get(sha);
      if (object === undefined) return fail(422, 'Validation Failed: object does not exist');
      repo.refs.set(ref, sha);
      repo.updatedAt = forge.tick().iso;
      return { status: 201, body: { ref, object: { sha, type: object.type } } };
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return fail(404, 'Not Found');
      return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
    }
    return fail(404, 'Not Found');
  }

  if (head === 'labels' && rest.length === 1) {
    if (method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })) };
    }
    if (method === 'POST') {
      if (!isRecord(req.body)) return fail(422, 'Validation Failed: body must be a JSON object');
      const name = str(req.body.name);
      if (name === '') return fail(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed: name has already been taken');
      const label = { name, color: str(req.body.color) || 'ededed' };
      repo.labels.set(name, label);
      return { status: 201, body: { name: label.name, color: label.color, default: false } };
    }
    return fail(404, 'Not Found');
  }

  if (head === 'issues') {
    return handleIssues(forge, repo, req, rest.slice(1));
  }

  if (head === 'pulls') {
    return handlePulls(forge, repo, req, rest.slice(1));
  }

  return fail(404, 'Not Found');
}

/** "Name <email> ts tz" -> {name, email, date}. */
function identJson(ident: string): Record<string, unknown> {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (match === null) return { name: ident, email: '', date: '' };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(forge: Forge, repo: Repo, req: RestRequest, pathParts: string[]): RestReply {
  const method = req.method;
  const path = pathParts.join('/');

  if (method === 'GET') {
    const refParam = req.query.get('ref');
    const tip = refParam === null ? repo.branchTip(repo.defaultBranch) : repo.resolveRef(refParam);
    if (tip === undefined) return fail(404, 'Not Found');
    const tree = treeOf(repo.lookup, tip);
    if (tree === null) return fail(404, 'Not Found');
    if (path === '') return { status: 200, body: dirListing(repo, tree, '') };
    const found = lookupTreePath(repo.lookup, tree, path.split('/'));
    if (found === null) return fail(404, 'Not Found');
    if (found.mode === '40000') return { status: 200, body: dirListing(repo, found.oid, path) };
    const blob = repo.objects.get(found.oid);
    if (blob === undefined || blob.type !== 'blob') return fail(404, 'Not Found');
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: found.oid,
        size: blob.data.length,
        name: path.split('/').pop(),
        path,
      },
    };
  }

  if (method === 'PUT') {
    if (!isRecord(req.body)) return fail(422, 'Validation Failed: body must be a JSON object');
    if (path === '') return fail(422, 'Validation Failed: path is required');
    const message = str(req.body.message);
    const contentB64 = str(req.body.content);
    const branch = str(req.body.branch) || repo.defaultBranch;
    const sha = typeof req.body.sha === 'string' ? req.body.sha : undefined;
    const tip = repo.branchTip(branch);
    let existingSha: string | undefined;
    if (tip !== undefined) {
      const tree = treeOf(repo.lookup, tip);
      if (tree !== null) existingSha = lookupTreePath(repo.lookup, tree, path.split('/'))?.oid;
    }
    if (existingSha !== undefined && sha !== existingSha) {
      return fail(409, `${path} does not match ${existingSha}`);
    }
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const tick = forge.tick();
    const { commitSha, blobSha } = repo.commitFile({
      branch,
      path,
      content,
      message,
      author: forge.commitIdentity(),
      timestamp: tick.epochSec,
    });
    repo.updatedAt = tick.iso;
    return {
      status: existingSha === undefined ? 201 : 200,
      body: {
        content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message },
      },
    };
  }

  if (method === 'DELETE') {
    if (!isRecord(req.body)) return fail(422, 'Validation Failed: body must be a JSON object');
    const message = str(req.body.message);
    const branch = str(req.body.branch) || repo.defaultBranch;
    const sha = typeof req.body.sha === 'string' ? req.body.sha : undefined;
    const tip = repo.branchTip(branch);
    if (tip === undefined) return fail(404, 'Not Found');
    const tree = treeOf(repo.lookup, tip);
    const existing = tree === null ? null : lookupTreePath(repo.lookup, tree, path.split('/'));
    if (existing === null || existing.mode === '40000') return fail(404, 'Not Found');
    if (sha !== undefined && sha !== existing.oid) return fail(409, `${path} does not match ${existing.oid}`);
    const tick = forge.tick();
    const { commitSha } = repo.commitFile({ branch, path, content: null, message, author: forge.commitIdentity(), timestamp: tick.epochSec });
    repo.updatedAt = tick.iso;
    return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
  }

  return fail(404, 'Not Found');
}

function dirListing(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const child = repo.objects.get(entry.oid);
    return {
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (child?.data.length ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// issues and comments
// ---------------------------------------------------------------------------------------------

function handleIssues(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestReply {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(req.query);
      return { status: 200, body: pageSlice(issues, page).map((issue) => issueJson(forge, repo, issue)), headers: linkHeaders(req, issues.length, page) };
    }
    if (method === 'POST') {
      if (!isRecord(req.body)) return fail(422, 'Validation Failed: body must be a JSON object');
      const labels = labelNames(req.body.labels);
      const created = createIssue(forge, repo, { title: str(req.body.title), body: str(req.body.body), labels });
      if (isOpError(created)) return fail(created.status, created.error);
      return { status: 201, body: issueJson(forge, repo, created) };
    }
    return fail(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number) || number < 1) return fail(404, 'Not Found');
  const issue = repo.issues.get(number);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue === undefined) return fail(404, 'Not Found');
      return { status: 200, body: issueJson(forge, repo, issue) };
    }
    if (method === 'PATCH') {
      if (issue === undefined) return fail(404, 'Not Found');
      if (isRecord(req.body)) {
        if (req.body.state === 'open' || req.body.state === 'closed') issue.state = req.body.state;
        if (typeof req.body.title === 'string') issue.title = req.body.title;
        if (typeof req.body.body === 'string') issue.body = req.body.body;
        if (req.body.labels !== undefined) {
          const labels = labelNames(req.body.labels);
          for (const label of labels) if (!repo.labels.has(label)) return fail(422, `Validation Failed: label "${label}" does not exist`);
          issue.labels = labels;
        }
        repo.updatedAt = forge.tick().iso;
      }
      return { status: 200, body: issueJson(forge, repo, issue) };
    }
    return fail(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    const known = issue !== undefined || repo.pulls.has(number);
    if (method === 'GET') {
      if (!known) return fail(404, 'Not Found');
      const comments = repo.comments
        .filter((comment) => comment.issueNumber === number)
        .map((comment) => ({ id: comment.id, body: comment.body, user: userJson(forge), created_at: forge.nowIso(), updated_at: forge.nowIso() }));
      return { status: 200, body: comments };
    }
    if (method === 'POST') {
      if (!known) return fail(404, 'Not Found');
      if (!isRecord(req.body)) return fail(422, 'Validation Failed: body must be a JSON object');
      const comment = { id: repo.nextCommentId++, issueNumber: number, body: str(req.body.body), seq: forge.tick().epochSec };
      repo.comments.push(comment);
      return { status: 201, body: { id: comment.id, body: comment.body, user: userJson(forge), created_at: forge.nowIso(), updated_at: forge.nowIso() } };
    }
    return fail(404, 'Not Found');
  }

  return fail(404, 'Not Found');
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
  }
  return names;
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): RestReply {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const page = pageOf(req.query);
      return { status: 200, body: pageSlice(pulls, page).map((pull) => pullJson(forge, repo, pull)), headers: linkHeaders(req, pulls.length, page) };
    }
    if (method === 'POST') {
      if (!isRecord(req.body)) return fail(422, 'Validation Failed: body must be a JSON object');
      const created = createPull(forge, repo, {
        title: str(req.body.title),
        body: str(req.body.body),
        head: str(req.body.head),
        base: str(req.body.base),
      });
      if (isOpError(created)) return fail(created.status, created.error);
      return { status: 201, body: pullJson(forge, repo, created) };
    }
    return fail(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number) || number < 1) return fail(404, 'Not Found');
  const pull = repo.pulls.get(number);

  if (rest.length === 1 && method === 'GET') {
    if (pull === undefined) return fail(404, 'Not Found');
    return { status: 200, body: pullJson(forge, repo, pull) };
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) return fail(404, 'Not Found');
    const files = pullChangedFiles(repo, pull).map((file) => ({
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: file.sha,
    }));
    return { status: 200, body: files };
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return fail(404, 'Not Found');
    const merged = mergePull(forge, repo, pull);
    if (isOpError(merged)) return fail(merged.status, merged.error);
    return { status: 200, body: { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' } };
  }

  return fail(404, 'Not Found');
}
