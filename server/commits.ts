import fs from 'node:fs';
import { EMPTY_TREE, git, gitBuffer, gitWithInput, safeRef, sha40 } from './git.js';

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
   * commit's first-parent diff). null: neither is in the repo, so there's nothing to diff.
   */
  tip?: string | null;
  landed?: LandedView; // set on landed (merged) PRs only
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

// ---- caches keyed by immutable data (commit shas) ----
const summaryCache = new Map<string, Omit<CommitSummary, 'sha' | 'short'>>(); // repo\0sha
const patchIdCache = new Map<string, string | null>();
const filesCache = new Map<string, FileChange[]>();

const SEP = '\x1f';

async function resolveBase(cfg: RepoRange): Promise<string> {
  const candidates = cfg.base ? [cfg.base] : ['origin/HEAD', 'main', 'master'];
  for (const c of candidates) {
    try {
      await git(cfg.path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${safeRef(c)}^{commit}`]);
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(cfg.base ? `base ref '${cfg.base}' not found` : `no base found (tried origin/HEAD, main, master)`);
}

export const rangeEnd = (cfg: RepoRange) => cfg.to ?? cfg.branch ?? '';

/** The sha the range ends at (branch head or `to`), or null if it doesn't resolve. */
export async function headOf(cfg: RepoRange): Promise<string | null> {
  try {
    return (await git(cfg.path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${safeRef(rangeEnd(cfg))}^{commit}`])).trim();
  } catch {
    return null;
  }
}

async function revParse(repo: string, ref: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${safeRef(ref)}^{commit}`])).trim();
  } catch {
    return null;
  }
}

export async function summarize(repo: string, sha: string): Promise<Omit<CommitSummary, 'sha' | 'short'>> {
  const key = repo + '\0' + sha;
  const hit = summaryCache.get(key);
  if (hit) return hit;
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
  summaryCache.set(key, s);
  return s;
}

/**
 * The repo's live range. With `optional` (the repo has landed PRs), a missing `branch`/`to`, or one that no longer
 * resolves (deleted after the merge), is no range at all rather than an error, and other range problems are a
 * `warning`; only a missing repo is still an error.
 */
export async function loadRepo(cfg: RepoRange, opts: { optional?: boolean } = {}): Promise<RepoInfo> {
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
    info.head = await headOf(cfg);
    if (!info.head && opts.optional) return info;
    if (!info.head) throw new Error(cfg.to ? `'to' ref '${cfg.to}' not found` : `branch '${end}' not found`);
    let range: string;
    if (cfg.from) {
      const first = await revParse(cfg.path, cfg.from);
      if (!first) throw new Error(`'from' commit '${cfg.from}' not found`);
      try {
        await git(cfg.path, ['merge-base', '--is-ancestor', '--end-of-options', sha40(first), sha40(info.head)]);
      } catch {
        throw new Error(`'from' commit '${cfg.from}' is not an ancestor of ${end}`);
      }
      const parent = (await summarize(cfg.path, first)).parent;
      info.mergeBase = parent;
      range = parent ? `${sha40(parent)}..${sha40(info.head)}` : sha40(info.head);
    } else {
      const base = await resolveBase(cfg);
      info.base = base;
      const mb = (await git(cfg.path, ['merge-base', '--end-of-options', safeRef(base), info.head])).trim();
      info.mergeBase = mb;
      range = `${sha40(mb)}..${sha40(info.head)}`;
    }
    const shas = (await git(cfg.path, ['rev-list', '--reverse', '--end-of-options', range])).split('\n').filter(Boolean);
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
  try {
    return await revParse(cfg.path, await resolveBase(cfg));
  } catch {
    return null;
  }
}

const isFull = (s: string | undefined): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
/** A full sha from a YAML file, if the repo has it as a commit; returned as git itself prints it. */
const present = (repo: string, s: string | undefined) => (isFull(s) ? revParse(repo, s) : Promise.resolve(null));

async function mergeBaseOf(repo: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(repo, ['merge-base', '--end-of-options', sha40(a), sha40(b)])).trim() || null;
  } catch {
    return null;
  }
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
  const [head, base, merge, keyObj] = await Promise.all([present(repo, l.head), present(repo, l.base), present(repo, l.commit), present(repo, key)]);
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
  const from = parent ? sha40(parent) : EMPTY_TREE;
  sha40(sha);
  const [rawOut, numOut] = await Promise.all([
    git(repo, ['diff', '-M', '--no-ext-diff', '--no-textconv', '--raw', '-z', from, sha, '--']),
    git(repo, ['diff', '-M', '--no-ext-diff', '--no-textconv', '--numstat', '-z', from, sha, '--']),
  ]);
  // --raw -z: ":old new oldsha newsha STATUS\0path\0[newpath\0]"
  const raw = rawOut.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < raw.length; ) {
    const head = raw[i++];
    if (!head || !head.startsWith(':')) continue;
    const statusCode = head.split(' ')[4] ?? 'M';
    const status = parseStatus(statusCode);
    if (status === 'renamed' || status === 'copied') {
      const oldPath = raw[i++];
      const newPath = raw[i++];
      files.push({ path: newPath, oldPath, status, similarity: Number(statusCode.slice(1)) || undefined, additions: 0, deletions: 0, binary: false });
    } else {
      const p = raw[i++];
      files.push({ path: p, oldPath: status === 'added' ? null : p, status, additions: 0, deletions: 0, binary: false });
    }
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
  filesCache.set(key, files);
  return files;
}

const MAX_BLOB = 2 * 1024 * 1024;

async function readBlob(repo: string, rev: string, p: string): Promise<{ text: string | null; tooLarge: boolean; binary: boolean }> {
  const spec = `${sha40(rev)}:${p}`;
  const size = Number((await git(repo, ['cat-file', '-s', spec])).trim());
  if (size > MAX_BLOB) return { text: null, tooLarge: true, binary: false };
  const buf = await gitBuffer(repo, ['cat-file', 'blob', spec]);
  if (buf.subarray(0, 8000).includes(0)) return { text: null, tooLarge: false, binary: true };
  return { text: buf.toString('utf8'), tooLarge: false, binary: false };
}

export interface CommitDetail extends CommitSummary {
  body: string;
  committer: string;
  committerDate: string;
  files: FileWithContents[];
}

// commit details are immutable per sha; keep the last few (file contents can be large)
const detailCache = new Map<string, Promise<CommitDetail>>();
const DETAIL_CACHE_SIZE = 12;

export function commitDetail(repo: string, sha: string): Promise<CommitDetail> {
  return cachedDetail(repo + '\0' + sha, () => loadCommitDetail(repo, sha));
}

/** A range entry's detail: a commit's, or a landed PR's (its own diff, the head's message; see landedSummary). */
export function detailOf(repo: string, c: CommitSummary): Promise<CommitDetail> {
  if (!c.landed) return commitDetail(repo, c.sha);
  return cachedDetail(`${repo}\0landed\0${c.sha}\0${c.parent}\0${c.tip}\0${c.subject}`, () => loadLandedDetail(repo, c));
}

function cachedDetail(key: string, load: () => Promise<CommitDetail>): Promise<CommitDetail> {
  let p = detailCache.get(key);
  if (p) {
    detailCache.delete(key); // refresh LRU position
  } else {
    p = load();
    p.catch(() => detailCache.delete(key));
  }
  detailCache.set(key, p);
  while (detailCache.size > DETAIL_CACHE_SIZE) detailCache.delete(detailCache.keys().next().value!);
  return p;
}

const messageBody = (message: string) => message.replace(/^[^\n]*\n?/, '').replace(/^\n+/, '').trimEnd();

/** A commit's message body (everything after the subject line), without loading its files. */
export async function commitBody(repo: string, sha: string): Promise<string> {
  return messageBody(await git(repo, ['show', '-s', '--format=%B', sha40(sha)]));
}

async function loadCommitDetail(repo: string, sha: string): Promise<CommitDetail> {
  const s = await summarize(repo, sha);
  const meta = await git(repo, ['show', '-s', `--format=%B${SEP}%cn${SEP}%cI`, sha40(sha)]);
  const [message, committer, committerDate] = meta.split(SEP);
  const body = messageBody(message);
  const files = await withContents(repo, await changedFiles(repo, sha, s.parent), s.parent, sha);
  return { sha, short: sha.slice(0, 8), ...s, body, committer, committerDate, files };
}

async function loadLandedDetail(repo: string, c: CommitSummary): Promise<CommitDetail> {
  // the message of the head (or the key commit), if the repo has it; a merge commit's message isn't the PR's
  const msgSha = (await present(repo, c.landed?.head)) ?? (await present(repo, c.sha));
  let body = '';
  let committer = '';
  let committerDate = '';
  if (msgSha) {
    const [message, cn, cd] = (await git(repo, ['show', '-s', `--format=%B${SEP}%cn${SEP}%cI`, sha40(msgSha)])).split(SEP);
    [body, committer, committerDate] = [messageBody(message), cn, cd.trim()];
  }
  const files = c.tip ? await withContents(repo, await changedFiles(repo, c.tip, c.parent), c.parent, c.tip) : [];
  return { ...c, body, committer, committerDate, files };
}

/** Old and new contents for each changed file, `from` (null: the empty tree) .. `to`. */
async function withContents(repo: string, files: FileChange[], from: string | null, to: string): Promise<FileWithContents[]> {
  const s = { parent: from };
  const sha = to;
  return Promise.all(
    files.map(async (f): Promise<FileWithContents> => {
      const out: FileWithContents = { ...f, oldContent: null, newContent: null };
      if (f.binary) return out;
      try {
        if (f.status !== 'added' && f.oldPath && s.parent) {
          const r = await readBlob(repo, s.parent, f.oldPath);
          out.oldContent = r.text;
          out.tooLarge ||= r.tooLarge;
          out.binary ||= r.binary;
        }
        if (f.status !== 'deleted') {
          const r = await readBlob(repo, sha, f.path);
          out.newContent = r.text;
          out.tooLarge ||= r.tooLarge;
          out.binary ||= r.binary;
        }
      } catch {
        // e.g. submodule entries: leave contents empty
        out.binary = true;
      }
      return out;
    }),
  );
}

const ancestorCache = new Map<string, boolean>(); // repo\0sha\0head

/** Is `sha` an ancestor of (or equal to) `head`? False if either is unknown to the repo. */
export async function isAncestor(repo: string, sha: string, head: string): Promise<boolean> {
  const key = `${repo}\0${sha}\0${head}`;
  const hit = ancestorCache.get(key);
  if (hit !== undefined) return hit;
  let yes = false;
  try {
    await git(repo, ['merge-base', '--is-ancestor', '--end-of-options', sha40(sha), sha40(head)]);
    yes = true;
  } catch {
    yes = false;
  }
  if (ancestorCache.size > 5000) ancestorCache.clear();
  ancestorCache.set(key, yes);
  return yes;
}

/** `git patch-id --stable` of a commit's diff against its first parent. */
export async function patchId(repo: string, sha: string): Promise<string | null> {
  const key = repo + '\0' + sha;
  if (patchIdCache.has(key)) return patchIdCache.get(key)!;
  let id: string | null = null;
  try {
    const s = await summarize(repo, sha);
    const diff = await git(repo, ['diff', '-M', '--no-ext-diff', '--no-textconv', s.parent ? sha40(s.parent) : EMPTY_TREE, sha40(sha), '--']);
    const out = await gitWithInput(repo, ['patch-id', '--stable'], diff);
    id = out.trim().split(/\s+/)[0] || null;
  } catch {
    id = null;
  }
  patchIdCache.set(key, id);
  return id;
}
