import fs from 'node:fs';
import { diskGet, diskSet } from './diskcache.js';
import { EMPTY_TREE, git, GitError, gitBufferWithInput, gitWithInput, isSafeRef, isSha, SAFE_REF_RULE, safeRef, sha40 } from './git.js';

export interface CommitSummary {
  sha: string;
  short: string;
  parent: string | null;
  subject: string;
  author: string;
  authorEmail: string;
  date: string; // author date, ISO
  changeId: string | null; // Change-Id trailer, if any
  additions: number;
  deletions: number;
  filesChanged: number;
  /**
   * The commit whose tree is shown (default: `sha`); `parent` is then what it's diffed against. Only differs for a
   * landed PR, whose `sha` is its prs file's key and whose diff is merge-base(base, head)...head (or the merge
   * commit's first-parent diff), and for a PR with follow-up commits (`members`), whose tip is its branch head.
   * null: neither is in the repo, so there's nothing to diff.
   */
  tip?: string | null;
  landed?: LandedView; // set on landed (merged) PRs only
  /**
   * `pr_model: follow-ups`: the PR's commits, oldest first (its root, `sha`, then the follow-up commits up to its
   * branch's head, `tip`). Set only when there are follow-ups; `parent` stays the root's parent, so the diff covers all.
   */
  members?: MemberCommit[];
}

export interface MemberCommit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string;
  additions: number;
  deletions: number;
}

/** A merged PR, frozen by the agent before fetching: prs/<repo>/<key>.yaml `landed:`. */
export interface Landed {
  head?: string; // the PR's head at merge (full sha)
  base?: string; // pull.base.sha at merge
  commit?: string; // the merge / squash commit
  method?: 'merge' | 'squash' | 'rebase';
  at?: string; // ISO time
}

export interface LandedView extends Landed {
  /** how its diff was made: merge-base(base, head)...head; the merge commit's first-parent diff (head or base not in the repo); or none */
  diff: 'merge-base' | 'merge-commit' | 'none';
}

/** Which commits of a repo to review: (base or from) .. (to or branch). */
export interface RepoRange {
  name: string;
  path: string; // absolute
  branch?: string; // range end, unless `to` is given
  to?: string; // explicit range end (sha or ref), inclusive
  base?: string; // range start = merge-base(base, end), exclusive; default origin/HEAD, main, master
  from?: string; // alternative start: the first commit included (overrides base)
  /**
   * Linked projects (project.yaml `after:`): the predecessor's range end in this same repo (a ref). While it's an
   * ancestor of this range's end, the range starts there (exclusive) instead of at merge-base(base, end); once it
   * isn't (the predecessor merged and this branch was rebased, or its branch is gone), `base` applies as usual.
   * Set by projects.ts, never written in project.yaml itself; `from` still wins.
   */
  after?: string;
}

export interface RepoInfo {
  name: string;
  path: string;
  branch: string | null;
  end: string; // the ref (or sha) the range ends at
  base: string | null;
  from: string | null;
  head: string | null; // sha of `end`
  mergeBase: string | null; // exclusive start of the range (null for a range starting at a root commit)
  /** the range starts at the predecessor's end (`after`, linked projects) rather than at its base */
  startsAfter?: boolean;
  commits: CommitSummary[];
  error?: string;
  warning?: string; // a problem with the live range that isn't an error (the repo has landed PRs to show)
}

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';
  similarity?: number;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface FileWithContents extends FileChange {
  oldContent: string | null;
  newContent: string | null;
  tooLarge?: boolean;
}

// ---- caches keyed by immutable data (commit shas); the definite answers are also kept on disk (diskcache.ts) ----
const summaryCache = new Map<string, Omit<CommitSummary, 'sha' | 'short'>>(); // repo\0sha
const patchIdCache = new Map<string, string | null>();
const filesCache = new Map<string, FileChange[]>();
const blobsOf = new WeakMap<FileChange, { old: string; new: string }>(); // a changedFiles entry's blob ids (--raw)
const mergeBaseCache = new Map<string, string | null>(); // repo\0a\0b
const revListCache = new Map<string, string[]>(); // repo\0range of full shas

/** Put into a Map that's cleared when it gets big (entries are immutable facts, cheap to recompute). */
function remember<K, V>(m: Map<K, V>, k: K, v: V, max = 5000): V {
  if (m.size >= max) m.clear();
  m.set(k, v);
  return v;
}

const SEP = '\x1f';

export const rangeEnd = (cfg: RepoRange) => cfg.to ?? cfg.branch ?? '';
const baseCandidates = (cfg: RepoRange) => (cfg.base ? [cfg.base] : ['origin/HEAD', 'main', 'master']);

/**
 * Each ref (or sha) as the commit it names, in one `git cat-file --batch-check`: a full sha, or null if it doesn't
 * resolve to a commit (or isn't a ref we'd pass to git). Never throws.
 */
export async function resolveCommits(repo: string, refs: (string | null | undefined)[]): Promise<(string | null)[]> {
  const safe = refs.map((r) => {
    try {
      return r ? safeRef(r) : null;
    } catch {
      return null;
    }
  });
  const asked = safe.filter((r): r is string => !!r);
  if (!asked.length) return refs.map(() => null);
  let lines: string[];
  try {
    // one line in, one line out: the sha, or "<name> missing" / "<name> ambiguous"
    lines = (await gitWithInput(repo, ['cat-file', '--batch-check=%(objectname)'], asked.map((r) => `${r}^{commit}\n`).join(''))).split('\n');
  } catch {
    return refs.map(() => null);
  }
  let i = 0;
  return safe.map((r) => {
    if (!r) return null;
    const line = lines[i++]?.trim() ?? '';
    return isSha(line) ? line : null;
  });
}

/** What a range's refs resolve to: its end (branch or `to`), `from`, and the base ref that's used (first that resolves). */
export interface RangeRefs {
  head: string | null;
  from: string | null;
  after?: string | null; // the predecessor's range end (linked projects), if given and it resolves
  base: { ref: string; sha: string } | null;
}

/** Resolve a range's refs, in one git call. */
export async function resolveRange(cfg: RepoRange): Promise<RangeRefs> {
  const candidates = cfg.from ? [] : baseCandidates(cfg);
  const after = cfg.from ? undefined : cfg.after;
  const [head, from, afterSha, ...bases] = await resolveCommits(cfg.path, [rangeEnd(cfg), cfg.from, after, ...candidates]);
  const i = bases.findIndex(Boolean);
  return { head, from, ...(after ? { after: afterSha } : {}), base: i >= 0 ? { ref: candidates[i], sha: bases[i]! } : null };
}

/** The sha the range ends at (branch head or `to`), or null if it doesn't resolve. */
export async function headOf(cfg: RepoRange): Promise<string | null> {
  return (await resolveCommits(cfg.path, [rangeEnd(cfg)]))[0];
}

/** `git rev-list --reverse a..b` (or just `b`) of full shas: immutable, so cached. */
export async function revList(repo: string, from: string | null, to: string): Promise<string[]> {
  const range = from ? `${sha40(from)}..${sha40(to)}` : sha40(to);
  const key = `${repo}\0${range}`;
  const hit = revListCache.get(key) ?? diskGet<string[]>(repo, 'rev-list', range);
  if (hit) return remember(revListCache, key, hit, 500);
  const shas = (await git(repo, ['rev-list', '--reverse', '--end-of-options', range])).split('\n').filter(Boolean);
  diskSet(repo, 'rev-list', range, shas);
  return remember(revListCache, key, shas, 500);
}

export async function summarize(repo: string, sha: string): Promise<Omit<CommitSummary, 'sha' | 'short'>> {
  const key = repo + '\0' + sha;
  const hit = summaryCache.get(key);
  if (hit) return hit;
  const stored = diskGet<Omit<CommitSummary, 'sha' | 'short'>>(repo, 'summary', sha);
  if (stored) return remember(summaryCache, key, stored);
  const meta = await git(repo, ['show', '-s', `--format=%P${SEP}%s${SEP}%an${SEP}%ae${SEP}%aI${SEP}%(trailers:key=Change-Id,valueonly,separator=%x2C)`, sha40(sha)]);
  const [parents, subject, author, authorEmail, date, changeIds] = meta.trim().split(SEP);
  const parent = parents.split(' ').filter(Boolean)[0] ?? null;
  const files = await changedFiles(repo, sha, parent);
  const s = {
    parent,
    subject,
    author,
    authorEmail,
    date,
    changeId: changeIds?.split(',')[0]?.trim() || null,
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
    filesChanged: files.length,
  };
  diskSet(repo, 'summary', sha, s);
  return remember(summaryCache, key, s);
}

/**
 * The repo's live range. With `optional` (the repo has landed PRs), a missing `branch`/`to`, or one that no longer
 * resolves (deleted after the merge), is no range at all rather than an error, and other range problems are a
 * `warning`; only a missing repo is still an error.
 */
export async function loadRepo(cfg: RepoRange, opts: { optional?: boolean; refs?: RangeRefs } = {}): Promise<RepoInfo> {
  const end = rangeEnd(cfg);
  const info: RepoInfo = { name: cfg.name, path: cfg.path, branch: cfg.branch ?? null, end, base: cfg.base ?? null, from: cfg.from ?? null, head: null, mergeBase: null, commits: [] };
  if (!fs.existsSync(cfg.path)) {
    info.error = `repo not found: ${cfg.path}`;
    return info;
  }
  try {
    if (!end) {
      if (opts.optional) return info;
      throw new Error('no `branch` or `to` given');
    }
    // a ref we won't pass to git would only read as "not found" below: say what's wrong with it instead
    for (const [what, ref] of [[cfg.to ? "'to' ref" : 'branch', end], ["'from' commit", cfg.from], ['base ref', cfg.base]] as const)
      if (ref && !isSafeRef(ref)) throw new Error(`${what} '${ref}' has characters Local Review won't pass to git (it allows ${SAFE_REF_RULE})`);
    // what the refs point at (given: already read by the caller, see stamps.ts); the rest follows from these shas
    const refs = opts.refs ?? (await resolveRange(cfg));
    info.head = refs.head;
    if (!info.head && opts.optional) return info;
    if (!info.head) throw new Error(cfg.to ? `'to' ref '${cfg.to}' not found` : `branch '${end}' not found`);
    if (cfg.from) {
      const first = refs.from;
      if (!first) throw new Error(`'from' commit '${cfg.from}' not found`);
      if (!(await isAncestor(cfg.path, first, info.head))) throw new Error(`'from' commit '${cfg.from}' is not an ancestor of ${end}`);
      info.mergeBase = (await summarize(cfg.path, first)).parent;
    } else if (refs.after && (refs.after === info.head || (await isAncestor(cfg.path, refs.after, info.head)))) {
      // linked projects: this range builds on the predecessor's, so it starts where that one ends
      info.base = refs.base?.ref ?? cfg.base ?? null;
      info.mergeBase = refs.after;
      info.startsAfter = true;
    } else {
      if (!refs.base) throw new Error(cfg.base ? `base ref '${cfg.base}' not found` : `no base found (tried origin/HEAD, main, master)`);
      info.base = refs.base.ref;
      const mb = await mergeBaseOf(cfg.path, refs.base.sha, info.head);
      if (!mb) throw new Error(`${refs.base.ref} and ${end} have no common ancestor`);
      info.mergeBase = mb;
    }
    const shas = info.mergeBase === info.head ? [] : await revList(cfg.path, info.mergeBase, info.head);
    info.commits = await Promise.all(shas.map(async (sha) => ({ sha, short: sha.slice(0, 8), ...(await summarize(cfg.path, sha)) })));
  } catch (e) {
    if (opts.optional) {
      info.warning = `live range: ${(e as Error).message}`;
      info.commits = [];
    } else info.error = (e as Error).message;
  }
  return info;
}

/** The repo's base ref as a sha (`base`, else origin/HEAD, main, master), or null. */
export async function baseSha(cfg: RepoRange): Promise<string | null> {
  return (await resolveRange({ ...cfg, from: undefined })).base?.sha ?? null;
}

const isFull = (s: string | undefined): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
/** Full shas from a YAML file, each as git itself prints it if the repo has it as a commit (else null); one git call. */
const present = (repo: string, shas: (string | undefined)[]) => resolveCommits(repo, shas.map((s) => (isFull(s) ? s : null)));

/** merge-base of two commits (null: none): immutable, so cached. */
async function mergeBaseOf(repo: string, a: string, b: string): Promise<string | null> {
  const key = `${repo}\0${a}\0${b}`;
  const hit = mergeBaseCache.get(key) ?? diskGet<string>(repo, 'merge-base', `${a}\0${b}`);
  if (hit !== undefined) return remember(mergeBaseCache, key, hit);
  let mb: string | null;
  try {
    mb = (await git(repo, ['merge-base', '--end-of-options', sha40(a), sha40(b)])).trim() || null;
  } catch {
    mb = null;
  }
  if (mb) diskSet(repo, 'merge-base', `${a}\0${b}`, mb); // not "none": the objects may just not be fetched yet
  return remember(mergeBaseCache, key, mb);
}

const landedCache = new Map<string, CommitSummary>(); // only complete (merge-base) results: objects don't vanish

/**
 * A landed PR as a range entry: `sha` is its prs file's key, and its diff is merge-base(base, head)...head (GitHub's
 * view of a stacked PR once it's retargeted and rebased onto the base). If the head or base object isn't in the repo
 * (a deleted branch, never fetched), it falls back to the merge commit's first-parent diff, else no diff at all.
 * Subject: the prs file's stored `subject:`, else the head's (or the key commit's), else the PR title.
 */
export async function landedSummary(repo: string, key: string, l: Landed, stored: { subject?: string; title?: string } = {}): Promise<CommitSummary> {
  sha40(key);
  const ck = [repo, key, l.head, l.base, l.commit, l.method, l.at, stored.subject, stored.title].join('\0');
  const hit = landedCache.get(ck);
  if (hit) return hit;
  const [head, base, merge, keyObj] = await present(repo, [l.head, l.base, l.commit, key]);
  let from: string | null = null;
  let to: string | null = null;
  let diff: LandedView['diff'] = 'none';
  if (head && base) {
    const mb = await mergeBaseOf(repo, base, head);
    if (mb) [from, to, diff] = [mb, head, 'merge-base'];
  }
  if (!to && merge) {
    from = (await summarize(repo, merge)).parent;
    [to, diff] = [merge, 'merge-commit'];
  }
  const metaSha = head ?? keyObj; // whose author, date and subject stand for the PR (not the merge commit's)
  const meta = metaSha ? await summarize(repo, metaSha) : merge ? await summarize(repo, merge) : null;
  const files = to ? await changedFiles(repo, to, from) : [];
  const s: CommitSummary = {
    sha: key,
    short: key.slice(0, 8),
    parent: from,
    subject: stored.subject?.trim() || (metaSha && meta?.subject) || stored.title || meta?.subject || '',
    author: meta?.author ?? '',
    authorEmail: meta?.authorEmail ?? '',
    date: (metaSha && meta?.date) || l.at || meta?.date || '',
    changeId: null,
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
    filesChanged: files.length,
    tip: to,
    landed: { ...l, diff },
  };
  if (diff === 'merge-base') {
    if (landedCache.size > 2000) landedCache.clear();
    landedCache.set(ck, s);
  }
  return s;
}

/** The files a range entry changes: its first-parent diff, or a landed PR's diff (none if it has none). */
export function filesOf(repo: string, c: CommitSummary): Promise<FileChange[]> {
  if (c.tip === null) return Promise.resolve([]);
  return changedFiles(repo, c.tip ?? c.sha, c.parent);
}

function parseStatus(code: string): FileChange['status'] {
  switch (code[0]) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type-changed';
    default: return 'modified';
  }
}

/** Files changed by `sha` relative to its first parent (or the empty tree), with -M rename detection. */
export async function changedFiles(repo: string, sha: string, parent: string | null): Promise<FileChange[]> {
  const key = repo + '\0' + sha + '\0' + (parent ?? '');
  const hit = filesCache.get(key);
  if (hit) return hit;
  const diskKey = `${sha}\0${parent ?? ''}`;
  const stored = diskGet<{ files: FileChange[]; blobs: [string, string][] }>(repo, 'files', diskKey);
  if (stored && stored.blobs?.length === stored.files?.length) {
    stored.files.forEach((f, i) => blobsOf.set(f, { old: stored.blobs[i][0], new: stored.blobs[i][1] }));
    return remember(filesCache, key, stored.files);
  }
  const from = parent ? sha40(parent) : EMPTY_TREE;
  sha40(sha);
  const [rawOut, numOut] = await Promise.all([
    git(repo, ['diff', '-M', '--no-ext-diff', '--no-textconv', '--raw', '--no-abbrev', '-z', from, sha, '--']),
    git(repo, ['diff', '-M', '--no-ext-diff', '--no-textconv', '--numstat', '-z', from, sha, '--']),
  ]);
  // --raw -z: ":oldmode newmode oldsha newsha STATUS\0path\0[newpath\0]"
  const raw = rawOut.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < raw.length; ) {
    const head = raw[i++];
    if (!head || !head.startsWith(':')) continue;
    const [, , oldBlob, newBlob, statusCode = 'M'] = head.split(' ');
    const status = parseStatus(statusCode);
    let f: FileChange;
    if (status === 'renamed' || status === 'copied') {
      const oldPath = raw[i++];
      const newPath = raw[i++];
      f = { path: newPath, oldPath, status, similarity: Number(statusCode.slice(1)) || undefined, additions: 0, deletions: 0, binary: false };
    } else {
      const p = raw[i++];
      f = { path: p, oldPath: status === 'added' ? null : p, status, additions: 0, deletions: 0, binary: false };
    }
    files.push(f);
    blobsOf.set(f, { old: oldBlob ?? '', new: newBlob ?? '' });
  }
  // --numstat -z: "add\tdel\tpath\0" or for renames "add\tdel\t\0old\0new\0"
  const num = numOut.split('\0');
  const stats = new Map<string, { a: number; d: number; bin: boolean }>();
  for (let i = 0; i < num.length; ) {
    const rec = num[i++];
    if (!rec) continue;
    const [a, d, p] = rec.split('\t');
    let pathKey = p;
    if (p === '' || p === undefined) {
      i++; // old path
      pathKey = num[i++];
    }
    stats.set(pathKey, { a: a === '-' ? 0 : Number(a), d: d === '-' ? 0 : Number(d), bin: a === '-' });
  }
  for (const f of files) {
    const s = stats.get(f.path);
    if (s) {
      f.additions = s.a;
      f.deletions = s.d;
      f.binary = s.bin;
    }
  }
  diskSet(repo, 'files', diskKey, { files, blobs: files.map((f) => [blobsOf.get(f)!.old, blobsOf.get(f)!.new]) });
  return remember(filesCache, key, files);
}

const MAX_BLOB = 2 * 1024 * 1024;

type Blob = { text: string | null; tooLarge: boolean; binary: boolean };

/**
 * Read blobs by object id, in two `git cat-file` runs whatever their number: their types and sizes, then the
 * contents of those small enough to show. A missing object, or one that isn't a blob (a submodule's commit), reads
 * as binary.
 */
async function readBlobs(repo: string, ids: string[]): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>();
  const want = [...new Set(ids)].filter(isSha);
  if (!want.length) return out;
  const info = (await gitWithInput(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], want.map((id) => `${id}\n`).join(''))).split('\n');
  const small: string[] = [];
  for (const [i, id] of want.entries()) {
    const [name, type, size] = (info[i] ?? '').split(' ');
    if (name !== id || type !== 'blob') out.set(id, { text: null, tooLarge: false, binary: true });
    else if (Number(size) > MAX_BLOB) out.set(id, { text: null, tooLarge: true, binary: false });
    else small.push(id);
  }
  if (!small.length) return out;
  // --batch: "<id> blob <size>\n<contents>\n" per object, in the order asked
  const buf = await gitBufferWithInput(repo, ['cat-file', '--batch'], small.map((id) => `${id}\n`).join(''));
  let at = 0;
  for (const id of small) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const [name, type, size] = buf.subarray(at, nl).toString('latin1').split(' ');
    const n = Number(size);
    if (name !== id || type !== 'blob' || !Number.isFinite(n)) break; // out of step: leave the rest unread
    const body = buf.subarray(nl + 1, nl + 1 + n);
    at = nl + 1 + n + 1;
    out.set(id, body.subarray(0, 8000).includes(0) ? { text: null, tooLarge: false, binary: true } : { text: body.toString('utf8'), tooLarge: false, binary: false });
  }
  return out;
}

export interface CommitDetail extends CommitSummary {
  body: string;
  committer: string;
  committerDate: string;
  files: FileWithContents[];
}

// commit details are immutable per sha: keep the most recently used, up to a total size of file contents (a
// commit's detail is mostly its files' old and new text)
const detailCache = new Map<string, { p: Promise<CommitDetail>; bytes: number }>();
let detailBytes = 0;
const DETAIL_CACHE_BYTES = 96 * 1024 * 1024;

export function commitDetail(repo: string, sha: string): Promise<CommitDetail> {
  return cachedDetail(repo + '\0' + sha, () => loadCommitDetail(repo, sha));
}

/**
 * A range entry's detail: a commit's, or a landed PR's (its own diff, the head's message; see landedSummary), or a PR
 * with follow-up commits (its root's message, the diff of all its commits).
 */
export function detailOf(repo: string, c: CommitSummary): Promise<CommitDetail> {
  if (!c.landed && !c.members) return commitDetail(repo, c.sha);
  return cachedDetail(`${repo}\0landed\0${c.sha}\0${c.parent}\0${c.tip}\0${c.subject}`, () => loadLandedDetail(repo, c));
}

const contentBytes = (d: CommitDetail) => d.files.reduce((a, f) => a + (f.oldContent?.length ?? 0) + (f.newContent?.length ?? 0), 1024);

function cachedDetail(key: string, load: () => Promise<CommitDetail>): Promise<CommitDetail> {
  const hit = detailCache.get(key);
  if (hit) {
    detailCache.delete(key); // refresh LRU position
    detailCache.set(key, hit);
    return hit.p;
  }
  const e = { p: load(), bytes: 0 };
  detailCache.set(key, e);
  e.p.then(
    (d) => {
      if (detailCache.get(key) !== e) return; // evicted meanwhile
      e.bytes = contentBytes(d);
      detailBytes += e.bytes;
      // oldest first, never the one just added
      for (const [k, old] of detailCache) {
        if (detailBytes <= DETAIL_CACHE_BYTES || old === e) break;
        detailCache.delete(k);
        detailBytes -= old.bytes;
      }
    },
    () => {
      if (detailCache.get(key) === e) detailCache.delete(key);
    },
  );
  return e.p;
}

const messageBody = (message: string) => message.replace(/^[^\n]*\n?/, '').replace(/^\n+/, '').trimEnd();

/** A PR with follow-up commits: its head (the branch's) and how many follow-ups it has; undefined for any other entry. */
export const followUpsOf = (c: CommitSummary) => (c.members && c.tip ? { head: c.tip, count: c.members.length - 1 } : undefined);

/** A commit's message body (everything after the subject line), without loading its files. */
export async function commitBody(repo: string, sha: string): Promise<string> {
  return messageBody(await git(repo, ['show', '-s', '--format=%B', sha40(sha)]));
}

async function loadCommitDetail(repo: string, sha: string): Promise<CommitDetail> {
  const s = await summarize(repo, sha);
  const meta = await git(repo, ['show', '-s', `--format=%B${SEP}%cn${SEP}%cI`, sha40(sha)]);
  const [message, committer, committerDate] = meta.split(SEP);
  const body = messageBody(message);
  const files = await withContents(repo, await changedFiles(repo, sha, s.parent), s.parent);
  return { sha, short: sha.slice(0, 8), ...s, body, committer, committerDate, files };
}

async function loadLandedDetail(repo: string, c: CommitSummary): Promise<CommitDetail> {
  // the message of the head (or the key commit: a PR with follow-ups uses its root's), if the repo has it; a merge
  // commit's message isn't the PR's
  const [headSha, keySha] = await present(repo, [c.landed?.head, c.sha]);
  const msgSha = headSha ?? keySha;
  let body = '';
  let committer = '';
  let committerDate = '';
  if (msgSha) {
    const [message, cn, cd] = (await git(repo, ['show', '-s', `--format=%B${SEP}%cn${SEP}%cI`, sha40(msgSha)])).split(SEP);
    [body, committer, committerDate] = [messageBody(message), cn, cd.trim()];
  }
  const files = c.tip ? await withContents(repo, await changedFiles(repo, c.tip, c.parent), c.parent) : [];
  return { ...c, body, committer, committerDate, files };
}

/** Old and new contents for each changed file, `from` (null: the empty tree) .. `to` (the diff changedFiles made). */
async function withContents(repo: string, files: FileChange[], from: string | null): Promise<FileWithContents[]> {
  const sides = files.map((f) => {
    const b = blobsOf.get(f);
    return { old: !f.binary && f.status !== 'added' && f.oldPath && from ? b?.old : undefined, new: !f.binary && f.status !== 'deleted' ? b?.new : undefined };
  });
  const blobs = await readBlobs(repo, sides.flatMap((s) => [s.old ?? '', s.new ?? '']));
  return files.map((f, i): FileWithContents => {
    const out: FileWithContents = { ...f, oldContent: null, newContent: null };
    for (const side of ['old', 'new'] as const) {
      const id = sides[i][side];
      if (id === undefined) continue;
      // e.g. a submodule entry, or an id we couldn't read: leave the contents empty
      const r = blobs.get(id) ?? { text: null, tooLarge: false, binary: true };
      out[side === 'old' ? 'oldContent' : 'newContent'] = r.text;
      out.tooLarge ||= r.tooLarge;
      out.binary ||= r.binary;
    }
    return out;
  });
}

const ancestorCache = new Map<string, boolean>(); // repo\0sha\0head

/** Is `sha` an ancestor of (or equal to) `head`? False if either is unknown to the repo. */
export async function isAncestor(repo: string, sha: string, head: string): Promise<boolean> {
  const key = `${repo}\0${sha}\0${head}`;
  const hit = ancestorCache.get(key) ?? diskGet<boolean>(repo, 'ancestor', `${sha}\0${head}`);
  if (hit !== undefined) return remember(ancestorCache, key, hit);
  let yes = false;
  try {
    await git(repo, ['merge-base', '--is-ancestor', '--end-of-options', sha40(sha), sha40(head)]);
    yes = true;
    diskSet(repo, 'ancestor', `${sha}\0${head}`, true);
  } catch (e) {
    yes = false;
    // exit 1 is a definite "no"; anything else (128: an object not fetched yet) may change, so isn't kept
    if (e instanceof GitError && e.exitCode === 1) diskSet(repo, 'ancestor', `${sha}\0${head}`, false);
  }
  if (ancestorCache.size > 5000) ancestorCache.clear();
  ancestorCache.set(key, yes);
  return yes;
}

/** `git patch-id --stable` of a commit's diff against its first parent. */
export async function patchId(repo: string, sha: string): Promise<string | null> {
  const key = repo + '\0' + sha;
  if (patchIdCache.has(key)) return patchIdCache.get(key)!;
  const stored = diskGet<string>(repo, 'patch-id', sha);
  if (stored) return remember(patchIdCache, key, stored);
  let id: string | null = null;
  try {
    const s = await summarize(repo, sha);
    const diff = await git(repo, ['diff', '-M', '--no-ext-diff', '--no-textconv', s.parent ? sha40(s.parent) : EMPTY_TREE, sha40(sha), '--']);
    const out = await gitWithInput(repo, ['patch-id', '--stable'], diff);
    id = out.trim().split(/\s+/)[0] || null;
  } catch {
    id = null;
  }
  if (id) diskSet(repo, 'patch-id', sha, id);
  return remember(patchIdCache, key, id);
}
