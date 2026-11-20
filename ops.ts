// Operations shared by the REST, GraphQL and MCP surfaces: creating issues and pull
// requests, listing a pull request's changed files, detecting merge conflicts and merging.
// Every surface reads and writes the same store, so an object made on one surface is the
// same object on the others.

import {
  buildCommit,
  flattenTree,
  mergeBase,
  treeOf,
  updateTreePath,
} from './gitobj.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

export type OpError = { error: string; status: number };

export function isOpError(value: unknown): value is OpError {
  return typeof value === 'object' && value !== null && 'error' in value && 'status' in value;
}

export function createIssue(
  forge: Forge,
  repo: Repo,
  input: { title: string; body: string; labels?: readonly string[] },
): Issue | OpError {
  if (input.title.trim() === '') return { error: 'Validation Failed: title is required', status: 422 };
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `Validation Failed: label "${label}" does not exist`, status: 422 };
  }
  const issue: Issue = {
    number: repo.nextNumber++,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...labels],
    seq: forge.tick().epochSec,
  };
  repo.issues.set(issue.number, issue);
  repo.updatedAt = forge.nowIso();
  return issue;
}

export function createPull(
  forge: Forge,
  repo: Repo,
  input: { title: string; body: string; head: string; base: string },
): Pull | OpError {
  const head = stripOwnerPrefix(input.head);
  const base = stripOwnerPrefix(input.base);
  if (repo.branchTip(head) === undefined) return { error: `Validation Failed: head branch "${head}" does not exist`, status: 422 };
  if (repo.branchTip(base) === undefined) return { error: `Validation Failed: base branch "${base}" does not exist`, status: 422 };
  if (head === base) return { error: 'Validation Failed: head and base must differ', status: 422 };
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return { error: `Validation Failed: a pull request already exists for ${head} into ${base}`, status: 422 };
    }
  }
  const pull: Pull = {
    number: repo.nextNumber++,
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    mergedAt: null,
    mergeCommitSha: null,
    seq: forge.tick().epochSec,
  };
  repo.pulls.set(pull.number, pull);
  repo.updatedAt = forge.nowIso();
  return pull;
}

export function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon > 0 && !ref.startsWith('refs/') ? ref.slice(colon + 1) : ref;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** The files a pull request changes, diffed from the merge base to the head tip. */
export function pullChangedFiles(repo: Repo, pull: Pull): ChangedFile[] {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(repo.lookup, headTip, baseTip) ?? baseTip;
  const baseFiles = flattenTree(repo.lookup, treeOf(repo.lookup, base) ?? '');
  const headFiles = flattenTree(repo.lookup, treeOf(repo.lookup, headTip) ?? '');
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  const out: ChangedFile[] = [];
  for (const path of paths) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before === after) continue;
    const beforeText = before === undefined ? '' : (repo.objects.get(before)?.data.toString('utf8') ?? '');
    const afterText = after === undefined ? '' : (repo.objects.get(after)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(beforeText, afterText);
    out.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after ?? before ?? '',
    });
  }
  return out;
}

/** True when head and base both changed the same path differently since the merge base. */
export function pullConflict(repo: Repo, pull: Pull): boolean {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return false;
  const base = mergeBase(repo.lookup, headTip, baseTip);
  if (base === null) return false;
  const baseFiles = flattenTree(repo.lookup, treeOf(repo.lookup, base) ?? '');
  const headFiles = flattenTree(repo.lookup, treeOf(repo.lookup, headTip) ?? '');
  const tipFiles = flattenTree(repo.lookup, treeOf(repo.lookup, baseTip) ?? '');
  for (const path of new Set([...baseFiles.keys(), ...headFiles.keys()])) {
    const baseOid = baseFiles.get(path);
    const headOid = headFiles.get(path);
    if (headOid === baseOid) continue;
    const tipOid = tipFiles.get(path);
    if (tipOid !== baseOid && tipOid !== headOid) return true;
  }
  return false;
}

/**
 * Squash-merge a pull request onto its base branch: apply the head's changes (from the
 * merge base) onto the base tip's tree as one new commit. A path both sides changed
 * differently is a conflict and nothing moves.
 */
export function mergePull(forge: Forge, repo: Repo, pull: Pull): { sha: string } | OpError {
  if (pull.state !== 'open') return { error: 'Pull Request is not mergeable', status: 405 };
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return { error: 'Pull Request is not mergeable', status: 405 };
  if (pullConflict(repo, pull)) return { error: 'Pull Request is not mergeable', status: 405 };

  const base = mergeBase(repo.lookup, headTip, baseTip) ?? baseTip;
  const baseFiles = flattenTree(repo.lookup, treeOf(repo.lookup, base) ?? '');
  const headFiles = flattenTree(repo.lookup, treeOf(repo.lookup, headTip) ?? '');
  let newTree = treeOf(repo.lookup, baseTip) ?? '';
  for (const path of new Set([...baseFiles.keys(), ...headFiles.keys()])) {
    const baseOid = baseFiles.get(path);
    const headOid = headFiles.get(path);
    if (headOid === baseOid) continue;
    newTree = updateTreePath(repo.objects, newTree === '' ? null : newTree, path.split('/'), headOid ?? null);
  }
  const tick = forge.tick();
  const sha = repo.putObject(
    'commit',
    buildCommit({
      tree: newTree,
      parents: [baseTip],
      message: `${pull.title} (#${pull.number})`,
      author: forge.commitIdentity(),
      committer: forge.commitIdentity(),
      timestamp: tick.epochSec,
    }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = tick.iso;
  pull.mergeCommitSha = sha;
  repo.updatedAt = tick.iso;
  return { sha };
}

/** Line-level additions/deletions between two texts, by longest common subsequence. */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > 4000 || b.length > 4000) return { additions: b.length, deletions: a.length };
  // LCS length via dynamic programming over rows.
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    previous = current;
  }
  const common = previous[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}
