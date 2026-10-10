import type { PrStatus, Progress } from '../shared/readiness';

export interface CommitSummary {
  sha: string;
  short: string;
  parent: string | null;
  subject: string;
  /** PR title: the override from prs/<repo>/<sha>.yaml, else the subject */
  title: string;
  title_source: 'commit' | 'override';
  /** 1-based position in the repo's range (what "PR 2" refers to) */
  position: number;
  /** index into the repo's `stacks` */
  stack: number;
  author: string;
  authorEmail: string;
  date: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  unresolved: number;
  threads: number;
  viewedCount: number;
  /** the commit's branch (display name and whether it still points here); absent or null: none known */
  branch?: BranchInfo | null;
  /** the GitHub PR it was published as, if any */
  github?: GithubInfo | null;
  /** draft / ready (prs/ `status:`), published once `github` is recorded, merged once `landed` is */
  status: PrStatus;
  /** conversations resolved and changed files viewed, for the readiness badge */
  progress: Progress;
  /** a landed (merged) PR: prs/ `landed:`, and how its diff was made */
  landed?: LandedInfo | null;
}

export interface LandedInfo {
  head?: string;
  base?: string;
  commit?: string;
  method?: 'merge' | 'squash' | 'rebase';
  at?: string;
  /** merge-base(base, head)...head; the merge commit's first-parent diff (head or base not in the repo); or none */
  diff: 'merge-base' | 'merge-commit' | 'none';
}

export interface BranchInfo {
  /** the display branch */
  name: string;
  /** moved: the recorded branch now points at another commit; missing: recorded but not in git; merged: a landed PR's (history) */
  status: 'ok' | 'moved' | 'missing' | 'discovered' | 'merged';
  /** where a moved branch points now */
  points_at?: string;
  discovered: string[];
}

export interface GithubInfo {
  number: number;
  url: string;
  branch?: string;
  base?: string;
  stack?: number;
  stacked_on?: string;
}

export interface StackGroup {
  index: number;
  /** 1-based among the declared stacks; null for an implicit group (Unstacked, or the branch when no stacks are declared) */
  number: number | null;
  title: string;
  /** palette name (blue, green, …, gray) or #hex */
  color: string;
  implicit?: 'unstacked' | 'branch';
  shas: string[];
  warning?: string;
  /** the stack's note (markdown) from project.yaml `stacks[].description`, for inter-stack context */
  description?: string;
  /** project.yaml `follow_on: true`: parked work, held back from the stacks going up now (advisory only) */
  follow_on?: boolean;
  /** PRs, distinct files and +/− of the whole stack (only in GET /api/projects/:p) */
  weight?: { prs: number; files: number; additions: number; deletions: number };
}

export interface RepoData {
  name: string;
  path: string;
  branch: string | null;
  end: string;
  base: string | null;
  from: string | null;
  head: string | null;
  mergeBase: string | null;
  error: string | null;
  warnings: string[];
  stacks: StackGroup[];
  reviewsDir: string;
  prsDir: string;
  commits: CommitSummary[];
}

export interface ProjectData {
  slug: string;
  title: string;
  description: string | null;
  file: string;
  error: string | null;
  repos: RepoData[];
}

export interface ProjectSummary {
  slug: string;
  title: string;
  description: string | null;
  error: string | null;
  repoCount: number;
  repos: string[];
  /** commits outside follow-on stacks */
  commitCount: number;
  /** commits in follow-on stacks (not in commitCount) */
  followOnCount: number;
  /** landed (merged) PRs (not in commitCount) */
  mergedCount: number;
  /** everything has landed: no live commits in any repo */
  archived: boolean;
  unresolved: number;
  modified: string;
}

export interface ProjectsResponse {
  projectsDir: string;
  /** the server's home directory: paths under it are shown as ~/… (shared/paths.ts) */
  home: string;
  projects: ProjectSummary[];
}

export interface PrInfo {
  title: string;
  body: string;
  title_source: 'commit' | 'override';
  body_source: 'commit' | 'override';
  commit_subject: string;
  commit_body: string;
  file: string;
  target_file: string;
  matched_from: string | null;
  matched_by: CarriedOver['by'];
  parse_error: string | null;
  status: PrStatus;
  github: GithubInfo | null;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

export interface FileData {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  similarity?: number;
  additions: number;
  deletions: number;
  binary: boolean;
  oldContent: string | null;
  newContent: string | null;
  tooLarge?: boolean;
}

export interface Comment {
  id: string;
  author: string;
  created: string | null;
  body: string;
  edited?: string;
}

export interface Thread {
  id: string;
  path?: string;
  side?: 'left' | 'right';
  line?: number;
  start_line?: number;
  /** side of start_line, only when it differs from `side` (a range spanning old and new lines) */
  start_side?: 'left' | 'right';
  resolved: boolean;
  /** computed by the server: the commented code can't be found on this commit */
  outdated?: boolean;
  anchor?: Anchor;
  comments: Comment[];
}

/** Where a thread was originally made, with the commented text and some context. */
export interface Anchor {
  commit: string;
  path: string;
  old_path?: string;
  side: 'left' | 'right';
  line: number;
  start_line?: number;
  start_side?: 'left' | 'right';
  start_text?: string;
  text: string;
  before?: string;
  after?: string;
}

export interface CarriedOver {
  from: string;
  by: 'patch-id' | 'change-id' | 'subject' | null;
  saved: boolean;
}

export interface Review {
  repo: string;
  commit: string;
  patch_id: string | null;
  viewed: string[];
  threads: Thread[];
  file: string;
  target_file: string;
  matched_from: string | null;
  matched_by: CarriedOver['by'];
  carried_over: CarriedOver | null;
  parse_error: string | null;
  previous_commits?: string[];
}

export interface CommitRef {
  repo: string;
  sha: string;
}

export interface CommitResponse {
  project: string;
  projectTitle: string;
  repo: string;
  repoPath: string;
  branch: string;
  index: number;
  total: number;
  stack: (StackGroup & { position: number; count: number }) | null;
  prev: CommitRef | null;
  next: CommitRef | null;
  commit: Omit<CommitSummary, 'title' | 'title_source' | 'position' | 'stack' | 'unresolved' | 'threads' | 'viewedCount' | 'progress'> & { body: string; committer: string; committerDate: string; files: FileData[]; landed: LandedInfo | null };
  pr: PrInfo;
  review: Review;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
  return data as T;
}

/** Which repo of which project a commit page is about. */
export interface Loc {
  project: string;
  repo: string;
}

const enc = encodeURIComponent;
const base = (l: Loc, sha: string) => `/api/projects/${enc(l.project)}/repos/${enc(l.repo)}/commits/${sha}`;

/** The person at the browser (server/reviewer.ts): their comments are `author: <id>`, and only theirs are editable. */
export interface Reviewer {
  id: string;
  name: string;
}

export const api = {
  me: () => req<Reviewer>('GET', '/api/me'),
  projects: () => req<ProjectsResponse>('GET', '/api/projects'),
  project: (slug: string) => req<ProjectData>('GET', `/api/projects/${enc(slug)}`),
  commit: (l: Loc, sha: string) => req<CommitResponse>('GET', base(l, sha)),
  review: (l: Loc, sha: string) => req<Review>('GET', `${base(l, sha)}/review`),
  pr: (l: Loc, sha: string) => req<PrInfo>('GET', `${base(l, sha)}/pr`),
  setPr: (l: Loc, sha: string, change: { title?: string | null; body?: string | null; status?: 'draft' | 'ready' | null }) => req<PrInfo>('PUT', `${base(l, sha)}/pr`, change),
  newThread: (l: Loc, sha: string, t: { path?: string; side?: 'left' | 'right'; line?: number; start_line?: number; start_side?: 'left' | 'right'; body: string }) =>
    req<Review>('POST', `${base(l, sha)}/threads`, t),
  reply: (l: Loc, sha: string, tid: string, body: string) => req<Review>('POST', `${base(l, sha)}/threads/${tid}/comments`, { body }),
  resolve: (l: Loc, sha: string, tid: string, resolved: boolean) => req<Review>('PATCH', `${base(l, sha)}/threads/${tid}`, { resolved }),
  editComment: (l: Loc, sha: string, tid: string, cid: string, body: string) => req<Review>('PATCH', `${base(l, sha)}/threads/${tid}/comments/${cid}`, { body }),
  deleteComment: (l: Loc, sha: string, tid: string, cid: string) => req<Review>('DELETE', `${base(l, sha)}/threads/${tid}/comments/${cid}`),
  viewed: (l: Loc, sha: string, path: string, viewed: boolean) => req<Review>('PUT', `${base(l, sha)}/viewed`, { path, viewed }),
  /** the project intro (project.yaml `description:`); null removes it */
  setProjectDescription: (slug: string, description: string | null) => req<{ description: string | null; file: string }>('PUT', `/api/projects/${enc(slug)}/description`, { description }),
  /** a stack's note; `number` is the stack's 1-based position in `stacks:`, `title` guards against a reordered list */
  setStackDescription: (slug: string, repo: string, number: number, title: string, description: string | null) =>
    req<{ description: string | null; title: string | null; file: string }>('PUT', `/api/projects/${enc(slug)}/repos/${enc(repo)}/stacks/${number}/description`, { description, title }),
};

export type ServerEvent =
  | { type: 'review'; project: string; repo: string; sha: string }
  | { type: 'pr'; project: string; repo: string; sha: string }
  | { type: 'project'; project: string; reason: string; repo?: string }
  | { type: 'projects'; reason: string };

/** CSS colour for a stack: a palette variable (with dark-mode variants) or the #hex as given. */
export const stackColor = (c: string) => (c.startsWith('#') ? c : `var(--stack-${c})`);
