// The forge's in-memory state: repositories with their git object stores, issues, pull
// requests, labels and comments. One bearer token owns everything (the suite's viewer); the
// login that token names is learned from the first request that names an owner, because the
// suite always addresses the viewer's repositories first (its git checks run before the rest).
//
// Determinism: nothing here reads a clock or a random source. Timestamps derive from
// MAKEFUN_TRIAL_NOW plus a per-forge counter, ids from counters, so two runs fed the same
// requests hold the same state.

import { buildCommit, hashObject, parseCommit, treeOf, updateTreePath, type GitObject, type GitObjectType } from './gitobj.ts';

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  seq: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export class Repo {
  readonly id: number;
  owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  readonly labels = new Map<string, Label>();
  readonly comments: Comment[] = [];
  nextNumber = 1;
  nextCommentId = 1;
  readonly createdAt: string;
  updatedAt: string;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, createdAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a ref name, branch name, tag name or full oid to an oid, or undefined. */
  resolveRef(ref: string): string | undefined {
    if (/^[0-9a-f]{40}$/.test(ref) && this.objects.has(ref)) return ref;
    if (ref === 'HEAD') return this.branchTip(this.defaultBranch);
    return this.refs.get(ref) ?? this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(`refs/tags/${ref}`);
  }

  /** One contents-API style commit: set or delete `path` on `branch`, creating the branch if needed. */
  commitFile(options: {
    branch: string;
    path: string;
    content: Buffer | null;
    message: string;
    author: string;
    timestamp: number;
  }): { commitSha: string; blobSha: string | null } {
    const tip = this.branchTip(options.branch) ?? this.branchTip(this.defaultBranch);
    const baseTree = tip === undefined ? null : treeOf(this.lookup, tip);
    const blobSha = options.content === null ? null : this.putObject('blob', options.content);
    const newTree = updateTreePath(this.objects, baseTree, options.path.split('/'), blobSha);
    const commitSha = this.putObject(
      'commit',
      buildCommit({
        tree: newTree,
        parents: tip === undefined ? [] : [tip],
        message: options.message,
        author: options.author,
        committer: options.author,
        timestamp: options.timestamp,
      }),
    );
    this.refs.set(`refs/heads/${options.branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Commits reachable from `tip`, newest first (a pre-order walk following parents). */
  commitList(tip: string, limit = 1000): Array<{ sha: string; message: string; parents: string[]; author: string; committer: string }> {
    const out: Array<{ sha: string; message: string; parents: string[]; author: string; committer: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, parents: commit.parents, author: commit.author, committer: commit.committer });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }
}

const PENDING_OWNER = '';

export class Forge {
  readonly repos = new Map<string, Repo>();
  viewerLogin: string | null = null;
  private nextRepoId = 1;
  private counter = 0;
  readonly baseEpochSec: number;

  constructor() {
    this.baseEpochSec = parseTrialNow(process.env.MAKEFUN_TRIAL_NOW);
  }

  /** The next deterministic timestamp (ISO) and its epoch seconds. */
  tick(): { iso: string; epochSec: number } {
    this.counter += 1;
    const epochSec = this.baseEpochSec + this.counter;
    return { iso: new Date(epochSec * 1000).toISOString(), epochSec };
  }

  nowIso(): string {
    return new Date((this.baseEpochSec + this.counter) * 1000).toISOString();
  }

  /**
   * Record the login the bearer token names, from a request that addressed a repository by
   * owner. Repositories created before the login was known (through POST /user/repos) are
   * adopted under it.
   */
  learnOwner(owner: string): void {
    if (this.viewerLogin !== null || owner === '' || owner === PENDING_OWNER) return;
    this.viewerLogin = owner;
    for (const repo of [...this.repos.values()]) {
      if (repo.owner === PENDING_OWNER) {
        this.repos.delete(`${PENDING_OWNER}/${repo.name}`);
        repo.owner = owner;
        this.repos.set(`${owner}/${repo.name}`, repo);
      }
    }
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const owner = this.viewerLogin ?? PENDING_OWNER;
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.nextRepoId++, owner, name, description, isPrivate, this.tick().iso);
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    this.learnOwner(owner);
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    this.learnOwner(owner);
    return this.repos.delete(`${owner}/${name}`);
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    const owner = this.viewerLogin ?? PENDING_OWNER;
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  /** The identity contents-API commits carry: the viewer, as `Name <login@forge>`. */
  commitIdentity(): string {
    const login = this.viewerLogin ?? 'forge';
    return `${login} <${login}@forge.invalid>`;
  }
}

function parseTrialNow(value: string | undefined): number {
  const fallback = Math.floor(Date.UTC(2025, 0, 1) / 1000);
  if (value === undefined || value === '') return fallback;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    // Epoch seconds, or milliseconds when the number is large enough to be one.
    return asNumber > 10_000_000_000 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : Math.floor(parsed / 1000);
}

// ---------------------------------------------------------------------------------------------
// Relay-style global ids: opaque, stable, and decodable back to the object they name.
// ---------------------------------------------------------------------------------------------

export function globalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}
