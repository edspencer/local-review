// What GitHub says about a published PR, as Local Review keeps it: one snapshot per PR (server/github.ts writes them
// to <home>/github/<owner>/<repo>/<number>.json) and the summary the sidebar shows. Shared by the server (which
// builds snapshots from GitHub's GraphQL answer) and the UI (tones, counts, tooltips), so both say the same thing.
// No imports: it's bundled by Vite and run by tsx.
//
// A review thread is in one of three states: resolved; unresolved with the last word yours (answered: the reviewer's
// turn, they resolve it); or unresolved with the last word someone else's (open: your turn). Outdated threads that
// aren't resolved stay open or answered, as on GitHub. An approval counts whichever push it was on.

export type ThreadState = 'resolved' | 'answered' | 'open';
export type ChecksState = 'passing' | 'failing' | 'pending';
export type GhPrState = 'open' | 'closed' | 'merged';
/** The PR link's colour: green once approved, red if checks fail or someone asked for changes (red wins). */
export type GhTone = 'approved' | 'blocked' | null;

export interface GhComment {
  author: string | null; // null: a deleted account ("ghost")
  body: string;
  at: string;
  url: string;
}

export interface GhThread {
  state: ThreadState;
  outdated: boolean;
  path: string;
  line: number | null;
  url: string; // its first comment
  total: number; // comments in the thread (more than `comments` holds if it's very long)
  comments: GhComment[];
  last: GhComment | null;
}

export interface GhReview extends GhComment {
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
}

export interface GhPrSnapshot {
  version: 1;
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  fetched_at: string;
  viewer: string; // whose last word makes a thread "answered"
  title: string;
  author: string | null;
  state: GhPrState;
  draft: boolean;
  head: string | null;
  base: string | null;
  review_decision: string | null; // GitHub's own verdict (from branch protection); often null on stacked PRs
  checks: ChecksState | null;
  approved_by: string[];
  changes_requested_by: string[];
  threads: GhThread[];
  reviews: GhReview[]; // submitted reviews with a summary (a body), oldest first
  conversation: GhComment[]; // the PR's top-level comments, oldest first
  conversation_total: number;
}

export interface GhCounts {
  total: number;
  open: number;
  answered: number;
  resolved: number;
}

/** What the sidebar and the stack tallies need about one PR. */
export interface GhSummary {
  key: string;
  url: string;
  number: number;
  state: GhPrState;
  draft: boolean;
  checks: ChecksState | null;
  approved_by: string[];
  changes_requested_by: string[];
  tone: GhTone;
  threads: GhCounts;
  conversation: number;
  first_open: string | null; // the oldest open thread's URL, else the oldest answered one's
  fetched_at: string;
}

export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

const PR_URL = /^https?:\/\/([^/\s]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]{0,8})(?:[/?#].*)?$/;

/** A PR's host, owner, repo and number, from its URL (`https://github.com/o/r/pull/12`); null if it isn't one. */
export function prRef(url: string | null | undefined): PrRef | null {
  const m = PR_URL.exec(url?.trim() ?? '');
  if (!m) return null;
  const [, host, owner, repo, n] = m;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return { host: host.toLowerCase(), owner, repo, number: Number(n) };
}

/** The key a PR is known by: `owner/repo#number`, owner and repo lower-cased (GitHub treats them so). */
export const repoKey = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`.toLowerCase();
export const prKey = (r: { owner: string; repo: string; number: number }) => `${repoKey(r)}#${r.number}`;

export function threadState(resolved: boolean, lastAuthor: string | null | undefined, viewer: string): ThreadState {
  if (resolved) return 'resolved';
  return lastAuthor && lastAuthor.toLowerCase() === viewer.toLowerCase() ? 'answered' : 'open';
}

export function counts(threads: { state: ThreadState }[]): GhCounts {
  const c = { total: threads.length, open: 0, answered: 0, resolved: 0 };
  for (const t of threads) c[t.state]++;
  return c;
}

export function toneOf(s: Pick<GhPrSnapshot, 'state' | 'checks' | 'approved_by' | 'changes_requested_by'>): GhTone {
  if (s.state !== 'open') return null;
  if (s.checks === 'failing' || s.changes_requested_by.length) return 'blocked';
  return s.approved_by.length ? 'approved' : null;
}

export function summaryOf(s: GhPrSnapshot): GhSummary {
  const first = s.threads.find((t) => t.state === 'open') ?? s.threads.find((t) => t.state === 'answered');
  return {
    key: prKey(s),
    url: s.url,
    number: s.number,
    state: s.state,
    draft: s.draft,
    checks: s.checks,
    approved_by: s.approved_by,
    changes_requested_by: s.changes_requested_by,
    tone: toneOf(s),
    threads: counts(s.threads),
    conversation: s.conversation_total,
    first_open: first?.url ?? null,
    fetched_at: s.fetched_at,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => xs.join(', ');

/** The PR link's tooltip: everything the colours and the chip stand for, in words. */
export function summaryTooltip(s: GhSummary): string {
  const lines = [`GitHub PR #${s.number}${s.state !== 'open' ? ` (${s.state})` : s.draft ? ' (draft on GitHub)' : ''}`];
  if (s.changes_requested_by.length) lines.push(`Changes requested by ${list(s.changes_requested_by)}`);
  if (s.approved_by.length) lines.push(`Approved by ${list(s.approved_by)}`);
  if (!s.approved_by.length && !s.changes_requested_by.length) lines.push('No approval yet');
  if (s.checks) lines.push(`Checks ${s.checks}`);
  lines.push(threadsLine(s.threads) + (s.conversation ? ` · ${plural(s.conversation, 'comment')} on the PR` : ''));
  return lines.join('\n');
}

export function threadsLine(c: GhCounts): string {
  if (!c.total) return 'No review threads';
  return `${plural(c.total, 'thread')}: ${c.open} open, ${c.answered} answered, ${c.resolved} resolved`;
}

// ---------------- from GitHub's GraphQL answer (server/github.ts asks; the shape is its PR_FIELDS) ----------------
const login = (a: any): string | null => (a && typeof a.login === 'string' ? a.login : null);
const comment = (c: any): GhComment => ({ author: login(c?.author), body: typeof c?.body === 'string' ? c.body : '', at: String(c?.createdAt ?? c?.submittedAt ?? ''), url: String(c?.url ?? '') });

function checksOf(state: unknown): ChecksState | null {
  switch (state) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return null;
  }
}

/** A snapshot from one `pullRequest` node of the query. Tolerant of missing fields: GitHub omits what it can't show. */
export function snapshotOf(node: any, ref: PrRef, viewer: string, fetchedAt: string): GhPrSnapshot {
  const threads: GhThread[] = (node?.reviewThreads?.nodes ?? []).filter(Boolean).map((t: any) => {
    const comments: GhComment[] = (t.comments?.nodes ?? []).filter(Boolean).map(comment);
    const lastNode = t.lastComment?.nodes?.[0];
    const last = lastNode ? comment(lastNode) : (comments[comments.length - 1] ?? null);
    return {
      state: threadState(!!t.isResolved, last?.author, viewer),
      outdated: !!t.isOutdated,
      path: String(t.path ?? ''),
      line: typeof t.line === 'number' ? t.line : typeof t.originalLine === 'number' ? t.originalLine : null,
      url: comments[0]?.url ?? last?.url ?? '',
      total: typeof t.comments?.totalCount === 'number' ? t.comments.totalCount : comments.length,
      comments,
      last,
    };
  });
  const opinions = (node?.latestOpinionatedReviews?.nodes ?? []).filter(Boolean);
  const by = (state: string) => [...new Set(opinions.filter((r: any) => r.state === state).map((r: any) => login(r.author)).filter((x: string | null): x is string => !!x))] as string[];
  const reviews: GhReview[] = (node?.reviews?.nodes ?? [])
    .filter((r: any) => r && typeof r.body === 'string' && r.body.trim())
    .map((r: any) => ({ ...comment(r), state: String(r.state ?? '') }));
  const conversation: GhComment[] = (node?.comments?.nodes ?? []).filter(Boolean).map(comment);
  const state: GhPrState = node?.merged || node?.state === 'MERGED' ? 'merged' : node?.state === 'CLOSED' ? 'closed' : 'open';
  return {
    version: 1,
    ...ref,
    url: typeof node?.url === 'string' ? node.url : `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    fetched_at: fetchedAt,
    viewer,
    title: String(node?.title ?? ''),
    author: login(node?.author),
    state,
    draft: !!node?.isDraft,
    head: typeof node?.headRefOid === 'string' ? node.headRefOid : null,
    base: typeof node?.baseRefName === 'string' ? node.baseRefName : null,
    review_decision: typeof node?.reviewDecision === 'string' ? node.reviewDecision : null,
    checks: checksOf(node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    approved_by: by('APPROVED'),
    changes_requested_by: by('CHANGES_REQUESTED'),
    threads,
    reviews,
    conversation,
    conversation_total: typeof node?.comments?.totalCount === 'number' ? node.comments.totalCount : conversation.length,
  };
}

/**
 * The fields asked for each PR. Comment text is kept (for the PR page, and for agents reading the snapshots), up to
 * 50 comments a thread (its last one always, to tell answered from open), 100 threads and the last 100 PR comments.
 */
export const PR_FIELDS = `
  number url title state merged isDraft headRefOid baseRefName reviewDecision
  author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  latestOpinionatedReviews(first: 50) { nodes { state author { login } } }
  reviews(last: 50) { nodes { state body submittedAt url author { login } } }
  comments(last: 100) { totalCount nodes { body createdAt url author { login } } }
  reviewThreads(first: 100) {
    nodes {
      isResolved isOutdated path line originalLine
      comments(first: 50) { totalCount nodes { body createdAt url author { login } } }
      lastComment: comments(last: 1) { nodes { body createdAt url author { login } } }
    }
  }`;

/** One query for several PRs of one repo, each under an alias `pr<number>`. Fixed text: only numbers vary. */
export function prsQuery(numbers: number[]): string {
  const prs = numbers.map((n) => {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`bad PR number ${n}`);
    return `pr${n}: pullRequest(number: ${n}) { ...PrFields }`;
  });
  return `query($owner: String!, $name: String!) {\n  viewer { login }\n  repository(owner: $owner, name: $name) {\n    ${prs.join('\n    ')}\n  }\n}\nfragment PrFields on PullRequest {${PR_FIELDS}\n}\n`;
}
