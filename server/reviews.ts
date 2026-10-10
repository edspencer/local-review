// Review comment files: projects/<project>/reviews/<repo>/<full-sha>.yaml
// Reads are tolerant of hand edits (by the reviewer or by an agent); writes are atomic, re-read the file first and
// apply the change as an operation to what's on disk, retrying if the file changed underneath us.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { atomicWrite, renameToBak } from './safefs.js';
import { isMixed, makeAnchor, placeThread, type Anchor, type DiffFile } from './anchors.js';

export interface Comment {
  id: string;
  author: string;
  created: string | null;
  body: string;
  [k: string]: unknown;
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
  outdated?: boolean;
  anchor?: Anchor;
  comments: Comment[];
  [k: string]: unknown;
}

export type MatchKind = 'patch-id' | 'change-id' | 'subject';

export interface Review {
  repo: string;
  repo_path: string;
  branch: string;
  commit: string;
  patch_id: string | null;
  change_id?: string;
  subject: string;
  viewed: string[];
  threads: Thread[];
  previous_commits?: string[];
  matched_by?: MatchKind;
  [k: string]: unknown;
}

export interface LiveCommit {
  sha: string;
  subject: string;
  changeId?: string | null;
  getPatchId: () => Promise<string | null>;
  /** a landed PR: its own files are never orphans, and it never takes another commit's file */
  frozen?: boolean;
}

export interface ReviewContext {
  /** repo name (written as `repo:`) */
  repo: string;
  /** the directory this repo's review files live in: projects/<project>/reviews/<repo> */
  dir: string;
  repoPath: string;
  branch: string;
  sha: string;
  subject: string;
  changeId?: string | null;
  getPatchId: () => Promise<string | null>;
  /** All commits currently in the repo range, oldest first (used for rebase re-matching). Default: just this one. */
  liveCommits?: LiveCommit[];
  /** A commit's changed files with contents (null if the commit can't be read). Needed for anchors. */
  getFiles?: (sha: string) => Promise<DiffFile[] | null>;
  /** What the repo says about an orphan's sha (see matchOrphans). Without it, only the file's own metadata is used. */
  inspectOrphan?: InspectOrphan;
}

/** What git knows about the sha of an orphaned file, in the reviewed repo. */
export interface OrphanFacts {
  exists: boolean; // the commit object is in the repo
  reachable: boolean; // it's an ancestor of the range end: it only left the range (base/from moved), it wasn't rewritten
  subject?: string;
  changeId?: string | null;
  getPatchId?: () => Promise<string | null>;
}
export type InspectOrphan = (sha: string) => Promise<OrphanFacts | null>;

export interface LoadedReview {
  review: Review;
  file: string | null; // file the review was read from (null = none yet)
  raw: string | null; // its text as read, for detecting concurrent edits
  matchedFrom?: string; // old sha, if re-matched after a rebase
  matchedBy?: MatchKind;
  parseError?: string;
}

// objects whose ids were invented on read (no id in the file); replaced with real ids on write
const autoIds = new WeakSet<object>();

export const randomId = (prefix: string) => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;

const SHA_FILE = /^([0-9a-f]{40})\.yaml$/;

/** `<dir>/<40-hex>.yaml`; `dir` is always built by the server from validated names, never taken from a URL. */
export function reviewPath(dir: string, sha: string) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('bad sha');
  if (!path.isAbsolute(dir)) throw new Error('review dir must be absolute');
  return path.join(dir, `${sha}.yaml`);
}

export function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

const normSide = (s: unknown): 'left' | 'right' => {
  const v = str(s)?.toLowerCase();
  return v === 'left' || v === 'old' || v === 'deletions' ? 'left' : 'right';
};

/** Commit subject as used for re-matching: no fixup!/squash!/amend! prefixes, whitespace collapsed. */
export function normalizeSubject(s: string | undefined | null): string {
  let v = (s ?? '').replace(/\s+/g, ' ').trim();
  for (;;) {
    const next = v.replace(/^(fixup|squash|amend)!\s*/i, '');
    if (next === v) return v;
    v = next;
  }
}

/** Normalise one comment; deterministic fallback ids so the UI can address them before a write. */
function normComment(c: any, threadId: string, i: number): Comment {
  if (typeof c === 'string') c = { body: c };
  if (!c || typeof c !== 'object') c = { body: String(c ?? '') };
  const author = (str(c.author) ?? 'unknown').trim().toLowerCase() || 'unknown';
  const out: Comment = {
    ...c,
    id: str(c.id) ?? `${threadId}-c${i}`,
    author,
    created: str(c.created) ?? null,
    body: str(c.body) ?? str(c.text) ?? str(c.comment) ?? '',
  };
  if (!str(c.id)) autoIds.add(out);
  return out;
}

function normAnchor(a: any): Anchor | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const commit = str(a.commit);
  const p = str(a.path);
  const line = num(a.line);
  const text = str(a.text);
  if (!commit || !/^[0-9a-f]{40}$/.test(commit) || !p || !line || text === undefined) return undefined;
  const out: Anchor = { ...a, commit, path: p, side: normSide(a.side), line, text };
  const sl = num(a.start_line);
  const ss = a.start_side == null ? undefined : normSide(a.start_side);
  delete out.start_side;
  if (sl && ss && ss !== out.side) {
    out.start_line = sl;
    out.start_side = ss;
  } else if (sl && sl < line) out.start_line = sl;
  else delete out.start_line;
  for (const k of ['before', 'after', 'old_path', 'start_text'] as const) {
    const v = str(a[k]);
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

function normThread(t: any, i: number): Thread {
  // a bare string (or number) in `threads` is a general comment; never drop it
  if (t !== null && t !== undefined && typeof t !== 'object') t = { comments: [{ body: String(t) }] };
  if (!t || typeof t !== 'object') t = {};
  const id = str(t.id) ?? `t-auto${i}`;
  // `comments:` written as a single mapping or a single string instead of a list
  let comments: any[] = Array.isArray(t.comments) ? t.comments : t.comments && typeof t.comments === 'object' ? [t.comments] : typeof t.comments === 'string' ? [{ body: t.comments }] : [];
  // tolerate a thread written with a single top-level body
  if (comments.length === 0 && (t.body || t.comment)) comments = [{ author: t.author, created: t.created, body: t.body ?? t.comment }];
  const out: Thread = {
    ...t,
    id,
    resolved: t.resolved === true || t.resolved === 'true',
    comments: comments.map((c, j) => normComment(c, id, j)),
  };
  if (out.path !== undefined) out.path = str(t.path);
  if (!out.path) delete out.path;
  const line = num(t.line);
  if (out.path && line) {
    out.line = line;
    out.side = normSide(t.side);
    const sl = num(t.start_line);
    const ss = t.start_side == null ? undefined : normSide(t.start_side);
    delete out.start_side;
    if (sl && ss && ss !== out.side) {
      // a range from an old-file line to a new-file line (or the reverse): no ordering between the numbers
      out.start_line = sl;
      out.start_side = ss;
    } else if (sl && sl < line) out.start_line = sl;
    else delete out.start_line;
  } else {
    delete out.line;
    delete out.start_line;
    delete out.start_side;
    if (!out.path) delete out.side;
    else if (t.side) out.side = normSide(t.side);
  }
  const anchor = out.path && out.line ? normAnchor(t.anchor) : undefined;
  if (anchor) out.anchor = anchor;
  else delete out.anchor;
  if (t.outdated === true || t.outdated === 'true') out.outdated = true;
  else delete out.outdated;
  delete (out as any).body;
  if (!str(t.id)) autoIds.add(out);
  return out;
}

export function normalize(doc: any, ctx: ReviewContext): Review {
  if (!doc || typeof doc !== 'object') doc = {};
  const threads = Array.isArray(doc.threads) ? doc.threads : [];
  const viewed = Array.isArray(doc.viewed) ? doc.viewed.map(str).filter(Boolean) : [];
  const r: Review = {
    ...doc,
    repo: str(doc.repo) ?? ctx.repo,
    repo_path: str(doc.repo_path) ?? ctx.repoPath,
    branch: str(doc.branch) ?? ctx.branch,
    commit: str(doc.commit) ?? ctx.sha,
    patch_id: str(doc.patch_id) ?? null,
    subject: str(doc.subject) ?? ctx.subject,
    viewed: [...new Set(viewed as string[])],
    threads: threads.map(normThread),
  };
  if (Array.isArray(doc.previous_commits)) r.previous_commits = doc.previous_commits.map(str).filter(Boolean) as string[];
  else delete r.previous_commits;
  return r;
}

/**
 * Shapes we can't normalise without dropping content (so a later write would lose it). These are treated
 * like invalid YAML: shown as an error, and the file is never overwritten until it's fixed.
 */
function structureError(doc: any): string | undefined {
  if (doc === null || doc === undefined) return undefined;
  if (typeof doc !== 'object' || Array.isArray(doc)) return 'the top level must be a mapping (repo:, commit:, threads: …)';
  if (doc.threads != null && !Array.isArray(doc.threads)) return '`threads` must be a list';
  if (doc.viewed != null && !Array.isArray(doc.viewed)) return '`viewed` must be a list';
  for (const [i, t] of (doc.threads ?? []).entries()) {
    if (t && typeof t === 'object' && !Array.isArray(t) && t.comments != null && !Array.isArray(t.comments) && typeof t.comments !== 'object' && typeof t.comments !== 'string')
      return `threads[${i}].comments must be a list`;
    if (Array.isArray(t)) return `threads[${i}] must be a mapping`;
  }
  return undefined;
}

export function readYaml(file: string): { doc: any; raw: string; error?: string } {
  const raw = fs.readFileSync(file, 'utf8');
  let doc: any;
  try {
    doc = YAML.parse(raw);
  } catch (e) {
    return { doc: null, raw, error: (e as Error).message };
  }
  const bad = structureError(doc);
  if (bad) return { doc: null, raw, error: bad };
  return { doc: doc ?? {}, raw };
}

export function readRaw(file: string | null): string | null {
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function emptyReview(ctx: ReviewContext): Review {
  return { repo: ctx.repo, repo_path: ctx.repoPath, branch: ctx.branch, commit: ctx.sha, patch_id: null, subject: ctx.subject, viewed: [], threads: [] };
}

// ---------------- rebase re-matching ----------------

export interface Orphan {
  sha: string;
  file: string;
  mtime: number;
  patchId?: string;
  changeId?: string;
  subject: string; // normalised
  repoPath?: string; // `repo_path:` of a review file
  landed?: boolean; // a prs file with a `landed:` block: frozen history, never re-matched
}

const orphanCache = new Map<string, { key: string; o: Orphan | null }>();

function readOrphan(file: string, sha: string): Orphan | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = orphanCache.get(file);
  if (hit && hit.key === key) return hit.o;
  let o: Orphan | null = null;
  try {
    const { doc } = readYaml(file);
    if (doc && typeof doc === 'object')
      o = { sha, file, mtime: st.mtimeMs, patchId: str(doc.patch_id), changeId: str(doc.change_id), subject: normalizeSubject(str(doc.subject)), repoPath: str(doc.repo_path), ...(doc.landed != null ? { landed: true } : {}) };
  } catch {
    o = null;
  }
  orphanCache.set(file, { key, o });
  return o;
}

/**
 * Deterministic range-wide assignment of orphaned files (review or PR-override files whose sha is no longer in the range)
 * to live commits that have no file of their own. Levels are tried in order, each over the whole range
 * oldest-first before the next: patch-id, Change-Id trailer, normalised subject (only for subjects that are
 * unique in the range). Each orphan goes to at most one commit; several candidates => newest file wins
 * (mtime), then lowest sha.
 *
 * With `inspect` (git, on the reviewed repo): a file whose commit is still an ancestor of the range end only
 * left the range (base or `from` moved, e.g. it landed upstream); it was not rewritten, so it is never
 * carried to another commit. A file without `patch_id` / `subject` (hand-written) gets them from git, so it
 * still follows a rebase. A review file whose `repo_path` is another repo and whose commit this repo doesn't
 * have (two repos that shared a name) is skipped.
 */
export async function matchOrphans(dir: string, live: LiveCommit[], opts: { inspect?: InspectOrphan; repoPath?: string } = {}): Promise<Map<string, { orphan: Orphan; by: MatchKind }>> {
  const out = new Map<string, { orphan: Orphan; by: MatchKind }>();
  if (!fs.existsSync(dir)) return out;
  const liveSet = new Set(live.map((c) => c.sha));
  const found: Orphan[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    const m = SHA_FILE.exec(f);
    if (!m || liveSet.has(m[1])) continue;
    const o = readOrphan(path.join(dir, f), m[1]);
    if (o && !o.landed) found.push(o);
  }
  if (!found.length) return out;
  const fileless = live.filter((c) => !c.frozen && !fs.existsSync(path.join(dir, `${c.sha}.yaml`)));
  if (!fileless.length) return out;
  const orphans: Orphan[] = [];
  for (const o of found) {
    const facts = opts.inspect ? await opts.inspect(o.sha).catch(() => null) : null;
    if (!facts) {
      orphans.push(o);
      continue;
    }
    if (facts.reachable) continue;
    if (!facts.exists && o.repoPath && opts.repoPath && path.resolve(o.repoPath) !== path.resolve(opts.repoPath)) continue;
    orphans.push({
      ...o, // never mutate the cached orphan
      patchId: o.patchId ?? (facts.getPatchId ? (await facts.getPatchId().catch(() => null)) ?? undefined : undefined),
      changeId: o.changeId ?? facts.changeId ?? undefined,
      subject: o.subject || normalizeSubject(facts.subject),
    });
  }
  if (!orphans.length) return out;
  const subjectCount = new Map<string, number>();
  for (const c of live.filter((x) => !x.frozen)) {
    const s = normalizeSubject(c.subject);
    subjectCount.set(s, (subjectCount.get(s) ?? 0) + 1);
  }
  const taken = new Set<string>();
  const levels: { by: MatchKind; live: (c: LiveCommit) => Promise<string | null | undefined>; orphan: (o: Orphan) => string | undefined }[] = [
    { by: 'patch-id', live: (c) => (orphans.some((o) => o.patchId) ? c.getPatchId() : Promise.resolve(null)), orphan: (o) => o.patchId },
    { by: 'change-id', live: async (c) => c.changeId, orphan: (o) => o.changeId },
    {
      by: 'subject',
      live: async (c) => {
        const s = normalizeSubject(c.subject);
        return s && subjectCount.get(s) === 1 ? s : null;
      },
      orphan: (o) => o.subject || undefined,
    },
  ];
  for (const level of levels) {
    for (const c of fileless) {
      if (out.has(c.sha)) continue;
      const k = await level.live(c);
      if (!k) continue;
      const cands = orphans.filter((o) => !taken.has(o.sha) && level.orphan(o) === k);
      if (!cands.length) continue;
      cands.sort((a, b) => b.mtime - a.mtime || (a.sha < b.sha ? -1 : 1));
      taken.add(cands[0].sha);
      out.set(c.sha, { orphan: cands[0], by: level.by });
    }
  }
  return out;
}

export async function loadReview(ctx: ReviewContext): Promise<LoadedReview> {
  const file = reviewPath(ctx.dir, ctx.sha);
  if (fs.existsSync(file)) {
    const { doc, raw, error } = readYaml(file);
    if (error) return { review: emptyReview(ctx), file, raw, parseError: error };
    return { review: normalize(doc, ctx), file, raw };
  }
  // No file under this sha: try to re-match a file from before a rebase.
  const live = ctx.liveCommits ?? [{ sha: ctx.sha, subject: ctx.subject, changeId: ctx.changeId, getPatchId: ctx.getPatchId }];
  const m = (await matchOrphans(ctx.dir, live, { inspect: ctx.inspectOrphan, repoPath: ctx.repoPath })).get(ctx.sha);
  if (m) {
    const { doc, raw, error } = readYaml(m.orphan.file);
    if (!error) return { review: normalize(doc, ctx), file: m.orphan.file, raw, matchedFrom: m.orphan.sha, matchedBy: m.by };
  }
  return { review: emptyReview(ctx), file: null, raw: null };
}

// ---------------- placing threads on the current commit ----------------

/**
 * Give every inline thread an anchor (if it has none, or if it is anchored on this commit but its
 * location was edited by hand), then place it on ctx.sha: update path/side/line/start_line to where its
 * anchor text is now, or set `outdated: true` (keeping the last known location) if it can't be found.
 * `fileSha` is the commit the file's locations refer to (the old sha for a carried-over file);
 * `fresh` are threads created by this operation (so their locations refer to ctx.sha).
 */
export async function placeThreads(r: Review, ctx: ReviewContext, fileSha: string, fresh: Set<Thread> = new Set()) {
  const inline = r.threads.filter((t) => t.path && t.line);
  if (!inline.length || !ctx.getFiles) return;
  const filesCache = new Map<string, Promise<DiffFile[] | null>>();
  const files = (sha: string) => {
    if (!filesCache.has(sha)) filesCache.set(sha, ctx.getFiles!(sha).catch(() => null));
    return filesCache.get(sha)!;
  };
  const current = await files(ctx.sha);
  if (!current) return;
  for (const t of inline) {
    const a = t.anchor;
    const moved =
      a && a.commit === ctx.sha &&
      (a.path !== t.path || a.side !== t.side || a.line !== t.line || a.start_line !== t.start_line || (a.start_side ?? a.side) !== (t.start_side ?? t.side));
    if (!a || moved) {
      let src = fresh.has(t) || moved ? ctx.sha : fileSha;
      let srcFiles = src === ctx.sha ? current : await files(src);
      if (!srcFiles) {
        src = ctx.sha; // the old commit is gone from the repo: best effort, anchor where it is now
        srcFiles = current;
      }
      const made = makeAnchor(srcFiles, src, { path: t.path!, side: t.side ?? 'right', line: t.line!, start_line: t.start_line, start_side: t.start_side });
      if (made) t.anchor = made;
    }
    const p = placeThread(t, current, ctx.sha);
    if (p.outdated) {
      t.outdated = true;
      continue;
    }
    delete t.outdated;
    t.path = p.path;
    t.side = p.side;
    t.line = p.line;
    if (p.start_line) t.start_line = p.start_line;
    else delete t.start_line;
    if (p.start_line && p.start_side && isMixed(p)) t.start_side = p.start_side;
    else delete t.start_side;
  }
}

/** The review as the UI should show it on ctx.sha: loaded, carried over if needed, threads placed. */
export async function viewReview(ctx: ReviewContext): Promise<LoadedReview> {
  const l = await loadReview(ctx);
  if (!l.parseError) await placeThreads(l.review, ctx, l.matchedFrom ?? ctx.sha);
  return l;
}

// ---------------- writing ----------------

/** The review file can't be written right now (invalid YAML on disk, or it keeps changing). HTTP 409. */
export class ReviewConflictError extends Error {}

// serialise writes per file
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

export { atomicWrite };

const BLOCK_KEYS = new Set(['body', 'text', 'before', 'after']);

export function toYaml(r: Review): string {
  // Fixed key order for readability; unknown keys are kept after the known ones.
  const { repo, repo_path, branch, commit, patch_id, change_id, subject, previous_commits, matched_by, viewed, threads, ...rest } = r;
  const ordered: any = { repo, repo_path, branch, commit, patch_id };
  if (change_id) ordered.change_id = change_id;
  ordered.subject = subject;
  if (previous_commits?.length) ordered.previous_commits = previous_commits;
  if (matched_by) ordered.matched_by = matched_by;
  Object.assign(ordered, rest);
  ordered.viewed = viewed;
  ordered.threads = threads.map((t) => {
    const { id, path: p, side, line, start_line, start_side, resolved, outdated, anchor, comments, ...trest } = t;
    const o: any = { id };
    if (p) o.path = p;
    if (p && side) o.side = side;
    if (p && line) o.line = line;
    if (p && start_line) o.start_line = start_line;
    if (p && start_line && start_side && start_side !== (side ?? 'right')) o.start_side = start_side;
    o.resolved = resolved;
    if (outdated) o.outdated = true;
    Object.assign(o, trest);
    if (anchor) {
      const { commit: ac, path: ap, old_path, side: as, line: al, start_line: asl, start_side: ass, start_text, text, before, after, ...arest } = anchor;
      const ao: any = { commit: ac, path: ap };
      if (old_path) ao.old_path = old_path;
      Object.assign(ao, { side: as, line: al });
      if (asl) ao.start_line = asl;
      if (asl && ass && ass !== as) {
        ao.start_side = ass;
        if (start_text !== undefined) ao.start_text = start_text;
      }
      if (before !== undefined) ao.before = before;
      ao.text = text;
      if (after !== undefined) ao.after = after;
      Object.assign(ao, arest);
      o.anchor = ao;
    }
    o.comments = comments.map((c) => {
      const { id: cid, author, created, body, ...crest } = c;
      const co: any = { id: cid, author };
      if (created) co.created = created;
      Object.assign(co, crest);
      co.body = body;
      return co;
    });
    return o;
  });
  // comment bodies (and multi-line anchor text) are written as block literals, easy to read and append to
  const doc = new YAML.Document(ordered);
  YAML.visit(doc, {
    Pair(_, pair) {
      if (!YAML.isScalar(pair.key) || !YAML.isScalar(pair.value) || typeof pair.value.value !== 'string') return;
      const k = pair.key.value as string;
      if (k === 'body' || (BLOCK_KEYS.has(k) && pair.value.value.includes('\n'))) pair.value.type = 'BLOCK_LITERAL';
    },
  });
  return doc.toString({ lineWidth: 0, blockQuote: 'literal' });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 6;

/**
 * Read-modify-write a review. `fn` is an operation applied to a fresh read of the file from disk (never to
 * a cached copy). If the file changes on disk while we work (an agent saved it), the whole operation is
 * re-applied to the new contents, so concurrent edits are merged rather than overwritten.
 */
export function mutateReview(ctx: ReviewContext, fn: (r: Review) => void): Promise<Review> {
  const target = reviewPath(ctx.dir, ctx.sha);
  return withLock(target, async () => {
    for (let attempt = 1; ; attempt++) {
      const loaded = await loadReview(ctx);
      if (loaded.parseError) {
        // maybe caught a non-atomic save half-way; give it a moment
        if (attempt < MAX_ATTEMPTS) {
          await sleep(40 * attempt);
          continue;
        }
        throw new ReviewConflictError(`refusing to overwrite ${loaded.file}: it is not valid YAML (${loaded.parseError}). Fix the file by hand.`);
      }
      const r = loaded.review;
      const before = new Set(r.threads);
      fn(r);
      const fresh = new Set(r.threads.filter((t) => !before.has(t)));
      // give real ids to anything that came without one (or with a duplicate)
      const seen = new Set<string>();
      for (const t of r.threads) {
        if (autoIds.has(t) || seen.has(t.id)) t.id = randomId('t');
        seen.add(t.id);
        for (const c of t.comments) {
          if (autoIds.has(c) || seen.has(c.id)) c.id = randomId('c');
          seen.add(c.id);
        }
      }
      if (!r.patch_id || loaded.matchedFrom) r.patch_id = await ctx.getPatchId();
      if (ctx.changeId) r.change_id = ctx.changeId;
      await placeThreads(r, ctx, loaded.matchedFrom ?? ctx.sha, fresh);
      r.repo = ctx.repo;
      r.repo_path = ctx.repoPath;
      r.branch = ctx.branch;
      r.subject = ctx.subject;
      if (loaded.matchedFrom && loaded.matchedFrom !== ctx.sha) {
        r.previous_commits = [...new Set([...(r.previous_commits ?? []), loaded.matchedFrom])];
        r.matched_by = loaded.matchedBy;
      }
      r.commit = ctx.sha;
      const text = toYaml(r);
      // optimistic concurrency: did anyone touch the source file (or create the target) since we read it?
      const changed = readRaw(loaded.file) !== loaded.raw || (loaded.file !== target && fs.existsSync(target));
      if (changed) {
        if (attempt < MAX_ATTEMPTS) continue;
        throw new ReviewConflictError(`${loaded.file ?? target} keeps changing on disk; not saving over it. Try again.`);
      }
      atomicWrite(target, text);
      if (loaded.matchedFrom && loaded.file && loaded.file !== target) {
        // keep the pre-rebase file, but out of the way of future matching
        try {
          renameToBak(loaded.file, `superseded-by-${ctx.sha.slice(0, 8)}`); // never over an existing file
        } catch {
          /* ignore */
        }
      }
      return r;
    }
  });
}

export function unresolvedCount(r: Review) {
  return r.threads.filter((t) => !t.resolved && t.comments.length > 0).length;
}
