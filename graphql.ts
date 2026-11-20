// GitHub GraphQL v4: a small parser and executor for the documents gh and github-mcp-server
// send — viewer, repository reads, issue and pull-request connections, the create/close/
// merge/comment mutations, node(id:) and the __type feature probes. A GraphQL-level failure
// (an unknown field, a bad input) is a 200 carrying an `errors` array, never an HTTP error.

import { createIssue, createPull, isOpError, mergePull, pullChangedFiles, pullConflict } from './ops.ts';
import { globalId, parseGlobalId, type Forge, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let j = i + 1;
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", got ${token.kind} ${JSON.stringify(token.value)}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind} ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) variableDefaults.set(varName, this.parseValue());
            this.skipDirectives();
          }
        }
        this.skipDirectives();
        operations.push({ operation: keyword, name, variableDefaults, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition "${keyword}"`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.skipPunct('...')) {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected token ${token.kind} ${JSON.stringify(token.value)} in value position`);
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

interface Wrapped {
  __typename: string;
  [key: string]: unknown;
}

function wrap(typename: string, fields: Record<string, unknown>): Wrapped {
  return { __typename: typename, ...fields };
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: GqlError[];
}

function valueOf(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => valueOf(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx);
  return out;
}

type Resolver = (parent: Wrapped, args: Record<string, unknown>, ctx: ExecContext) => unknown;

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'isPrivate', 'url'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  User: ['id', 'login', 'name', 'url'],
  Ref: ['id', 'name', 'prefix'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function repoWrapped(repo: Repo): Wrapped {
  return wrap('Repository', { repo });
}

function issueWrapped(repo: Repo, issue: Issue): Wrapped {
  return wrap('Issue', { repo, issue });
}

function pullWrapped(repo: Repo, pull: Pull): Wrapped {
  return wrap('PullRequest', { repo, pull });
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

interface ConnectionSlice<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function sliceConnection<T extends { number: number }>(ordered: readonly T[], first: unknown, after: unknown): ConnectionSlice<T> {
  const count = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : 30;
  const afterNumber = numberFromCursor(after);
  let start = 0;
  if (afterNumber !== null) {
    const index = ordered.findIndex((item) => item.number === afterNumber);
    start = index < 0 ? ordered.length : index + 1;
  }
  const nodes = ordered.slice(start, start + count);
  return {
    nodes,
    hasNextPage: start + count < ordered.length,
    endCursor: nodes.length > 0 ? cursorOf(nodes[nodes.length - 1]!.number) : null,
  };
}

function orderDirection(args: Record<string, unknown>): 'asc' | 'desc' {
  const orderBy = args.orderBy;
  if (typeof orderBy === 'object' && orderBy !== null && !Array.isArray(orderBy)) {
    const direction = (orderBy as Record<string, unknown>).direction;
    if (direction === 'ASC') return 'asc';
    if (direction === 'DESC') return 'desc';
  }
  return 'desc';
}

function repoFromGlobalId(forge: Forge, id: unknown): Repo {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (parsed === null || parsed.kind !== 'Repository') throw new Error(`Could not resolve to a node with the global id of '${String(id)}'.`);
  const repo = forge.repoById(Number.parseInt(parsed.parts[0] ?? '', 10));
  if (repo === undefined) throw new Error(`Could not resolve to a node with the global id of '${String(id)}'.`);
  return repo;
}

function issueFromGlobalId(forge: Forge, id: unknown): { repo: Repo; issue: Issue } {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (parsed === null || parsed.kind !== 'Issue') throw new Error(`Could not resolve to a node with the global id of '${String(id)}'.`);
  const repo = forge.repoById(Number.parseInt(parsed.parts[0] ?? '', 10));
  const issue = repo?.issues.get(Number.parseInt(parsed.parts[1] ?? '', 10));
  if (repo === undefined || issue === undefined) throw new Error(`Could not resolve to a node with the global id of '${String(id)}'.`);
  return { repo, issue };
}

function pullFromGlobalId(forge: Forge, id: unknown): { repo: Repo; pull: Pull } {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (parsed === null || parsed.kind !== 'PullRequest') throw new Error(`Could not resolve to a node with the global id of '${String(id)}'.`);
  const repo = forge.repoById(Number.parseInt(parsed.parts[0] ?? '', 10));
  const pull = repo?.pulls.get(Number.parseInt(parsed.parts[1] ?? '', 10));
  if (repo === undefined || pull === undefined) throw new Error(`Could not resolve to a node with the global id of '${String(id)}'.`);
  return { repo, pull };
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('input is required');
  return input as Record<string, unknown>;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_parent, _args, ctx) => wrap('User', { login: ctx.forge.viewerLogin ?? 'forge' }),
    repository: (_parent, args, ctx) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.forge.getRepo(owner, name);
      return repo === undefined ? null : repoWrapped(repo);
    },
    node: (_parent, args, ctx) => {
      const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = ctx.forge.repoById(Number.parseInt(parsed.parts[0] ?? '', 10));
        return repo === undefined ? null : repoWrapped(repo);
      }
      if (parsed.kind === 'Issue') {
        const repo = ctx.forge.repoById(Number.parseInt(parsed.parts[0] ?? '', 10));
        const issue = repo?.issues.get(Number.parseInt(parsed.parts[1] ?? '', 10));
        return repo === undefined || issue === undefined ? null : issueWrapped(repo, issue);
      }
      if (parsed.kind === 'PullRequest') {
        const repo = ctx.forge.repoById(Number.parseInt(parsed.parts[0] ?? '', 10));
        const pull = repo?.pulls.get(Number.parseInt(parsed.parts[1] ?? '', 10));
        return repo === undefined || pull === undefined ? null : pullWrapped(repo, pull);
      }
      if (parsed.kind === 'User') return wrap('User', { login: parsed.parts[0] ?? '' });
      return null;
    },
    __type: (_parent, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
      return wrap('__Type', { typeName: name });
    },
  },

  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = inputOf(args);
      const repo = repoFromGlobalId(ctx.forge, input.repositoryId);
      const created = createIssue(ctx.forge, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      if (isOpError(created)) throw new Error(created.error);
      return wrap('CreateIssuePayload', { issue: issueWrapped(repo, created) });
    },
    closeIssue: (_parent, args, ctx) => {
      const input = inputOf(args);
      const { repo, issue } = issueFromGlobalId(ctx.forge, input.issueId);
      issue.state = 'closed';
      repo.updatedAt = ctx.forge.tick().iso;
      return wrap('CloseIssuePayload', { issue: issueWrapped(repo, issue) });
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = inputOf(args);
      const repo = repoFromGlobalId(ctx.forge, input.repositoryId);
      const created = createPull(ctx.forge, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      if (isOpError(created)) throw new Error(created.error);
      return wrap('CreatePullRequestPayload', { pullRequest: pullWrapped(repo, created) });
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = inputOf(args);
      const { repo, pull } = pullFromGlobalId(ctx.forge, input.pullRequestId);
      const merged = mergePull(ctx.forge, repo, pull);
      if (isOpError(merged)) throw new Error(merged.error);
      return wrap('MergePullRequestPayload', { pullRequest: pullWrapped(repo, pull) });
    },
    addComment: (_parent, args, ctx) => {
      const input = inputOf(args);
      const body = typeof input.body === 'string' ? input.body : '';
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      if (parsed === null || (parsed.kind !== 'Issue' && parsed.kind !== 'PullRequest')) {
        throw new Error(`Could not resolve to a node with the global id of '${String(input.subjectId)}'.`);
      }
      const repo = ctx.forge.repoById(Number.parseInt(parsed.parts[0] ?? '', 10));
      const number = Number.parseInt(parsed.parts[1] ?? '', 10);
      if (repo === undefined || (!repo.issues.has(number) && !repo.pulls.has(number))) {
        throw new Error(`Could not resolve to a node with the global id of '${String(input.subjectId)}'.`);
      }
      const comment = { id: repo.nextCommentId++, issueNumber: number, body, seq: ctx.forge.tick().epochSec };
      repo.comments.push(comment);
      return wrap('AddCommentPayload', {
        commentEdge: wrap('IssueCommentEdge', {
          node: wrap('IssueComment', { repo, commentId: comment.id, body }),
        }),
      });
    },
  },

  Repository: {
    id: (parent) => globalId('Repository', [(parent.repo as Repo).id]),
    databaseId: (parent) => (parent.repo as Repo).id,
    name: (parent) => (parent.repo as Repo).name,
    nameWithOwner: (parent) => (parent.repo as Repo).fullName,
    description: (parent) => (parent.repo as Repo).description,
    owner: (parent) => wrap('User', { login: (parent.repo as Repo).owner }),
    defaultBranchRef: (parent) => {
      const repo = parent.repo as Repo;
      return repo.branchTip(repo.defaultBranch) === undefined ? null : wrap('Ref', { name: repo.defaultBranch });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (parent) => (parent.repo as Repo).isPrivate,
    createdAt: (parent) => (parent.repo as Repo).createdAt,
    updatedAt: (parent) => (parent.repo as Repo).updatedAt,
    url: (parent) => `/${(parent.repo as Repo).fullName}`,
    issue: (parent, args) => {
      const repo = parent.repo as Repo;
      const issue = repo.issues.get(typeof args.number === 'number' ? args.number : -1);
      return issue === undefined ? null : issueWrapped(repo, issue);
    },
    issues: (parent, args) => {
      const repo = parent.repo as Repo;
      let issues = [...repo.issues.values()];
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      issues.sort((a, b) => (orderDirection(args) === 'asc' ? a.number - b.number : b.number - a.number));
      const slice = sliceConnection(issues, args.first, args.after);
      return wrap('IssueConnection', {
        nodes: slice.nodes.map((issue) => issueWrapped(repo, issue)),
        totalCount: issues.length,
        pageInfo: wrap('PageInfo', { hasNextPage: slice.hasNextPage, hasPreviousPage: false, endCursor: slice.endCursor, startCursor: slice.nodes.length ? cursorOf(slice.nodes[0]!.number) : null }),
      });
    },
    pullRequest: (parent, args) => {
      const repo = parent.repo as Repo;
      const pull = repo.pulls.get(typeof args.number === 'number' ? args.number : -1);
      return pull === undefined ? null : pullWrapped(repo, pull);
    },
    pullRequests: (parent, args) => {
      const repo = parent.repo as Repo;
      let pulls = [...repo.pulls.values()];
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((state) => String(state)));
        pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      } else {
        pulls = pulls.filter((pull) => pull.state === 'open');
      }
      pulls.sort((a, b) => (orderDirection(args) === 'asc' ? a.number - b.number : b.number - a.number));
      const slice = sliceConnection(pulls, args.first, args.after);
      return wrap('PullRequestConnection', {
        nodes: slice.nodes.map((pull) => pullWrapped(repo, pull)),
        totalCount: pulls.length,
        pageInfo: wrap('PageInfo', { hasNextPage: slice.hasNextPage, hasPreviousPage: false, endCursor: slice.endCursor, startCursor: slice.nodes.length ? cursorOf(slice.nodes[0]!.number) : null }),
      });
    },
  },

  Issue: {
    id: (parent) => globalId('Issue', [(parent.repo as Repo).id, (parent.issue as Issue).number]),
    number: (parent) => (parent.issue as Issue).number,
    title: (parent) => (parent.issue as Issue).title,
    body: (parent) => (parent.issue as Issue).body,
    state: (parent) => (parent.issue as Issue).state.toUpperCase(),
    author: (_parent, _args, ctx) => wrap('User', { login: ctx.forge.viewerLogin ?? 'forge' }),
    createdAt: (_parent, _args, ctx) => ctx.forge.nowIso(),
    updatedAt: (_parent, _args, ctx) => ctx.forge.nowIso(),
    url: (parent) => `/${(parent.repo as Repo).fullName}/issues/${(parent.issue as Issue).number}`,
  },

  PullRequest: {
    id: (parent) => globalId('PullRequest', [(parent.repo as Repo).id, (parent.pull as Pull).number]),
    number: (parent) => (parent.pull as Pull).number,
    title: (parent) => (parent.pull as Pull).title,
    body: (parent) => (parent.pull as Pull).body,
    state: (parent) => {
      const pull = parent.pull as Pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (parent) => (parent.pull as Pull).merged,
    headRefName: (parent) => (parent.pull as Pull).headRef,
    baseRefName: (parent) => (parent.pull as Pull).baseRef,
    mergeable: (parent) => {
      const pull = parent.pull as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullConflict(parent.repo as Repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (parent, args) => {
      const files = pullChangedFiles(parent.repo as Repo, parent.pull as Pull);
      const count = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 100;
      return wrap('PullRequestChangedFileConnection', {
        nodes: files.slice(0, count).map((file) =>
          wrap('PullRequestChangedFile', {
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status.toUpperCase(),
          }),
        ),
        totalCount: files.length,
        pageInfo: wrap('PageInfo', { hasNextPage: count < files.length, hasPreviousPage: false, endCursor: null, startCursor: null }),
      });
    },
    author: (_parent, _args, ctx) => wrap('User', { login: ctx.forge.viewerLogin ?? 'forge' }),
    createdAt: (_parent, _args, ctx) => ctx.forge.nowIso(),
    updatedAt: (_parent, _args, ctx) => ctx.forge.nowIso(),
    url: (parent) => `/${(parent.repo as Repo).fullName}/pull/${(parent.pull as Pull).number}`,
  },

  User: {
    id: (parent) => globalId('User', [String(parent.login)]),
    login: (parent) => String(parent.login),
    name: (parent) => String(parent.login),
    url: (parent) => `/${String(parent.login)}`,
  },

  Ref: {
    id: (parent) => globalId('Ref', [String(parent.name)]),
    name: (parent) => String(parent.name),
    prefix: () => 'refs/heads/',
  },

  IssueConnection: {
    nodes: (parent) => parent.nodes,
    totalCount: (parent) => parent.totalCount,
    pageInfo: (parent) => parent.pageInfo,
  },

  PullRequestConnection: {
    nodes: (parent) => parent.nodes,
    totalCount: (parent) => parent.totalCount,
    pageInfo: (parent) => parent.pageInfo,
  },

  PullRequestChangedFileConnection: {
    nodes: (parent) => parent.nodes,
    totalCount: (parent) => parent.totalCount,
    pageInfo: (parent) => parent.pageInfo,
  },

  PullRequestChangedFile: {
    path: (parent) => parent.path,
    additions: (parent) => parent.additions,
    deletions: (parent) => parent.deletions,
    changeType: (parent) => parent.changeType,
  },

  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage,
    hasPreviousPage: (parent) => parent.hasPreviousPage,
    endCursor: (parent) => parent.endCursor,
    startCursor: (parent) => parent.startCursor,
  },

  IssueComment: {
    id: (parent) => globalId('IssueComment', [(parent.repo as Repo).id, Number(parent.commentId)]),
    body: (parent) => parent.body,
    createdAt: (_parent, _args, ctx) => ctx.forge.nowIso(),
    author: (_parent, _args, ctx) => wrap('User', { login: ctx.forge.viewerLogin ?? 'forge' }),
  },

  IssueCommentEdge: {
    node: (parent) => parent.node,
  },

  CreateIssuePayload: { issue: (parent) => parent.issue },
  CloseIssuePayload: { issue: (parent) => parent.issue },
  CreatePullRequestPayload: { pullRequest: (parent) => parent.pullRequest },
  MergePullRequestPayload: { pullRequest: (parent) => parent.pullRequest },
  AddCommentPayload: { commentEdge: (parent) => parent.commentEdge },

  __Type: {
    name: (parent) => parent.typeName,
    fields: (parent) => {
      const fields = TYPE_FIELDS[String(parent.typeName)];
      return fields === undefined ? null : fields.map((name) => wrap('__Field', { name }));
    },
    enumValues: (parent) => {
      const values = ENUM_VALUES[String(parent.typeName)];
      return values === undefined ? null : values.map((name) => wrap('__EnumValue', { name }));
    },
  },

  __Field: { name: (parent) => parent.name },
  __EnumValue: { name: (parent) => parent.name },
};

function executeSelectionSet(
  parent: Wrapped,
  selections: readonly SelectionNode[],
  ctx: ExecContext,
  path: Array<string | number>,
  out: Record<string, unknown>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === undefined || selection.typeCondition === parent.__typename) {
        executeSelectionSet(parent, selection.selectionSet, ctx, path, out);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === parent.__typename) {
        executeSelectionSet(parent, fragment.selectionSet, ctx, path, out);
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    if (selection.name === '__typename') {
      out[responseKey] = parent.__typename;
      continue;
    }
    const resolver = RESOLVERS[parent.__typename]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parent.__typename}".`, path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(parent, argsOf(selection, ctx), ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(value, selection.selectionSet, ctx, fieldPath);
  }
}

function completeValue(value: unknown, selectionSet: SelectionNode[] | undefined, ctx: ExecContext, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(item, selectionSet, ctx, [...path, index]));
  }
  if (typeof value === 'object') {
    const wrapped = value as Wrapped;
    if (selectionSet === undefined) return null;
    const out: Record<string, unknown> = {};
    executeSelectionSet(wrapped, selectionSet, ctx, path, out);
    return out;
  }
  return value;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: GqlError[];
}

export function executeGraphQL(
  forge: Forge,
  document: string,
  variables: Record<string, unknown>,
  operationName?: string,
): GraphQLResult {
  let parsed: DocumentNode;
  try {
    parsed = new Parser(document).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: OperationNode | undefined;
  if (operationName !== undefined && operationName !== '') {
    operation = parsed.operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (parsed.operations.length === 1) {
    operation = parsed.operations[0];
  } else if (parsed.operations.length === 0) {
    return { data: null, errors: [{ message: 'Document contains no operations.' }] };
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  const ctx: ExecContext = { forge, variables: mergedVariables, fragments: parsed.fragments, errors: [] };
  for (const [name, defaultValue] of operation.variableDefaults) {
    if (mergedVariables[name] === undefined) mergedVariables[name] = valueOf(defaultValue, ctx);
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  executeSelectionSet(wrap(rootType, {}), operation.selectionSet, ctx, [], data);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}
