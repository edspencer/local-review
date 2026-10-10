// PR title/description overrides: projects/<project>/prs/<repo>/<full-sha>.yaml
// A commit's PR title and description default to its subject and body. Changing them must never touch the
// reviewed repo, so overrides live here. Like review files they follow rebases (patch-id, Change-Id, subject;
// only from files whose commit has left the range), tolerate hand edits, and are written atomically.
import fs from 'node:fs';
import YAML from 'yaml';
import { atomicWrite, renameToBak } from './safefs.js';
import { storedStatus } from '../shared/readiness.js';
import { ReviewConflictError, matchOrphans, readRaw, reviewPath, str, withLock, type InspectOrphan, type LiveCommit, type MatchKind } from './reviews.js';

export interface PrContext {
  repo: string;
  dir: string; // projects/<project>/prs/<repo>
  sha: string;
  subject: string;
  changeId?: string | null;
  getPatchId: () => Promise<string | null>;
  liveCommits?: LiveCommit[];
  inspectOrphan?: InspectOrphan;
}

/** A PR created on GitHub from this commit (recorded by the agent that created it). */
export interface GithubPr {
  number: number;
  url: string; // '' if the file only gives a number
  branch?: string;
  base?: string;
  created?: string;
}

export interface PrOverride {
  title?: string;
  body?: string;
  branch?: string; // the branch an agent tagged this commit with (a plain git branch name)
  github?: GithubPr;
  status?: 'draft' | 'ready'; // the reviewer's readiness call (absent: draft); published is derived from `github`
}

export interface LoadedPr {
  override: PrOverride;
  doc: Record<string, unknown> | null; // the file's content as parsed (null = no file)
  file: string | null;
  raw: string | null;
  matchedFrom?: string;
  matchedBy?: MatchKind;
  parseError?: string;
}

export const prPath = reviewPath; // same `<dir>/<40-hex>.yaml` rule

function parse(raw: string): { doc: Record<string, unknown> | null; error?: string } {
  let doc: any;
  try {
    doc = YAML.parse(raw);
  } catch (e) {
    return { doc: null, error: (e as Error).message };
  }
  if (doc === null || doc === undefined) return { doc: {} };
  if (typeof doc !== 'object' || Array.isArray(doc)) return { doc: null, error: 'the top level must be a mapping (title:, body: …)' };
  return { doc };
}

/** What the file overrides. A blank title doesn't count; `description:` is accepted as an alias of `body:`. */
export function overrideOf(doc: Record<string, unknown> | null): PrOverride {
  if (!doc) return {};
  const o: PrOverride = {};
  const title = str(doc.title)?.replace(/\s+/g, ' ').trim();
  if (title) o.title = title;
  const body = str(doc.body) ?? str(doc.description);
  if (body !== undefined) o.body = body.replace(/\r\n/g, '\n').trimEnd();
  const branch = branchName(doc.branch);
  if (branch) o.branch = branch;
  const gh = githubOf(doc.github);
  if (gh) o.github = gh;
  const status = storedStatus(doc.status);
  if (status) o.status = status;
  return o;
}

/** A hand-written branch name: trimmed, `refs/heads/` dropped. Blank or not a string: none. */
export function branchName(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim().replace(/^refs\/heads\//, '') : undefined;
  return s || undefined;
}

const PR_URL = /^https?:\/\/\S+\/pull\/(\d+)\/?(?:[#?]\S*)?$/;

function prNumber(v: unknown): number | undefined {
  const s = str(v)?.trim().replace(/^#/, '');
  if (!s || !/^\d{1,9}$/.test(s)) return undefined;
  const n = Number(s);
  return n > 0 ? n : undefined;
}

/**
 * The `github:` field, tolerantly: `{number, url, branch?, base?, created?}` with the number as a number or a
 * string (`"123"`, `"#123"`), or derived from a `.../pull/123` url; or just a number or a PR url on its own.
 * Anything without a usable PR number is ignored (null).
 */
export function githubOf(v: unknown): GithubPr | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    const s = str(v)?.trim() ?? '';
    const m = PR_URL.exec(s);
    if (m) return { number: Number(m[1]), url: s };
    const n = prNumber(s);
    return n ? { number: n, url: '' } : null;
  }
  const o = v as Record<string, unknown>;
  const url = str(o.url)?.trim() ?? '';
  const number = prNumber(o.number) ?? (PR_URL.exec(url) ? Number(PR_URL.exec(url)![1]) : undefined);
  if (!number) return null;
  const gh: GithubPr = { number, url };
  const branch = branchName(o.branch);
  if (branch) gh.branch = branch;
  const base = branchName(o.base);
  if (base) gh.base = base;
  const created = str(o.created)?.trim();
  if (created) gh.created = created;
  return gh;
}

function readFile(file: string): Omit<LoadedPr, 'matchedFrom' | 'matchedBy'> {
  const raw = fs.readFileSync(file, 'utf8');
  const { doc, error } = parse(raw);
  return { override: overrideOf(doc), doc, file, raw, ...(error ? { parseError: error } : {}) };
}

const none = (): LoadedPr => ({ override: {}, doc: null, file: null, raw: null });

export async function loadPr(ctx: PrContext): Promise<LoadedPr> {
  const file = prPath(ctx.dir, ctx.sha);
  if (fs.existsSync(file)) return readFile(file);
  const live = ctx.liveCommits ?? [{ sha: ctx.sha, subject: ctx.subject, changeId: ctx.changeId, getPatchId: ctx.getPatchId }];
  const m = (await matchOrphans(ctx.dir, live, { inspect: ctx.inspectOrphan })).get(ctx.sha);
  if (m) {
    const l = readFile(m.orphan.file);
    if (!l.parseError) return { ...l, matchedFrom: m.orphan.sha, matchedBy: m.by };
  }
  return none();
}

/** Overrides for every commit of a repo at once (one directory scan), for the sidebar. */
export async function loadPrs(dir: string, live: LiveCommit[], inspect?: InspectOrphan): Promise<Map<string, LoadedPr>> {
  const out = new Map<string, LoadedPr>();
  if (!fs.existsSync(dir)) return out;
  const matched = await matchOrphans(dir, live, { inspect });
  for (const c of live) {
    const file = prPath(dir, c.sha);
    try {
      if (fs.existsSync(file)) out.set(c.sha, readFile(file));
      else {
        const m = matched.get(c.sha);
        if (m) {
          const l = readFile(m.orphan.file);
          if (!l.parseError) out.set(c.sha, { ...l, matchedFrom: m.orphan.sha, matchedBy: m.by });
        }
      }
    } catch {
      /* unreadable: no override */
    }
  }
  return out;
}

function toYaml(doc: Record<string, unknown>): string {
  const { commit, patch_id, change_id, subject, previous_commits, matched_by, title, body, status, branch, github, updated, ...rest } = doc;
  const o: Record<string, unknown> = { commit, patch_id: patch_id ?? null };
  if (change_id) o.change_id = change_id;
  o.subject = subject;
  if (Array.isArray(previous_commits) && previous_commits.length) o.previous_commits = previous_commits;
  if (matched_by) o.matched_by = matched_by;
  if (title !== undefined) o.title = title;
  if (body !== undefined) o.body = body;
  if (status !== undefined) o.status = status;
  if (branch !== undefined) o.branch = branch;
  if (github !== undefined) o.github = github;
  if (updated !== undefined) o.updated = updated;
  Object.assign(o, rest);
  const d = new YAML.Document(o);
  YAML.visit(d, {
    Pair(_, pair) {
      if (YAML.isScalar(pair.key) && pair.key.value === 'body' && YAML.isScalar(pair.value) && typeof pair.value.value === 'string') pair.value.type = 'BLOCK_LITERAL';
    },
  });
  return d.toString({ lineWidth: 0, blockQuote: 'literal' });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 6;

/**
 * Set or clear the PR title / body / branch / github / status. `undefined` leaves a field as it is, `null` clears it (the
 * title and body go back to the commit message), a value sets it. Re-reads the file and retries if it changes underneath us; refuses to
 * overwrite a file that isn't valid YAML.
 */
export interface PrChange {
  title?: string | null;
  body?: string | null;
  branch?: string | null;
  github?: GithubPr | null;
  status?: 'draft' | 'ready' | null; // draft and null both remove the key (absent means draft)
}

export function writePr(ctx: PrContext, change: PrChange, now = new Date()): Promise<LoadedPr> {
  const target = prPath(ctx.dir, ctx.sha);
  return withLock(target, async () => {
    for (let attempt = 1; ; attempt++) {
      const loaded = await loadPr(ctx);
      if (loaded.parseError) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(40 * attempt);
          continue;
        }
        throw new ReviewConflictError(`refusing to overwrite ${loaded.file}: it is not valid YAML (${loaded.parseError}). Fix the file by hand.`);
      }
      const doc: Record<string, unknown> = { ...(loaded.doc ?? {}) };
      if (change.title !== undefined) {
        if (change.title === null || !change.title.trim()) delete doc.title;
        else doc.title = change.title.replace(/\s+/g, ' ').trim();
      }
      if (change.body !== undefined) {
        delete doc.description; // the alias, if an agent used it
        if (change.body === null) delete doc.body;
        else doc.body = change.body.replace(/\r\n/g, '\n').trimEnd() + '\n';
      }
      if (change.branch !== undefined) {
        const b = change.branch === null ? undefined : branchName(change.branch);
        if (b) doc.branch = b;
        else delete doc.branch;
      }
      if (change.github !== undefined) {
        if (change.github === null) delete doc.github;
        else {
          const { number, url, branch, base, created } = change.github;
          doc.github = { number, url, ...(branch ? { branch } : {}), ...(base ? { base } : {}), ...(created ? { created } : {}) };
        }
      }
      if (change.status !== undefined) {
        if (change.status === 'ready') doc.status = 'ready';
        else delete doc.status;
      }
      doc.commit = ctx.sha;
      doc.patch_id = (!loaded.matchedFrom && str(doc.patch_id)) || (await ctx.getPatchId());
      if (ctx.changeId) doc.change_id = ctx.changeId;
      doc.subject = ctx.subject;
      if (loaded.matchedFrom) {
        const prev = Array.isArray(doc.previous_commits) ? doc.previous_commits.map(str).filter(Boolean) : [];
        doc.previous_commits = [...new Set([...prev, loaded.matchedFrom])];
        doc.matched_by = loaded.matchedBy;
      }
      doc.updated = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const text = toYaml(doc);
      const changed = readRaw(loaded.file) !== loaded.raw || (loaded.file !== target && fs.existsSync(target));
      if (changed) {
        if (attempt < MAX_ATTEMPTS) continue;
        throw new ReviewConflictError(`${loaded.file ?? target} keeps changing on disk; not saving over it. Try again.`);
      }
      atomicWrite(target, text);
      if (loaded.matchedFrom && loaded.file && loaded.file !== target) {
        try {
          renameToBak(loaded.file, `superseded-by-${ctx.sha.slice(0, 8)}`); // never over an existing file
        } catch {
          /* ignore */
        }
      }
      return readFile(target);
    }
  });
}

/** The PR as shown: override where present, else the commit message. */
export function prView(l: LoadedPr | undefined, commit: { subject: string; body?: string }) {
  const o = l?.override ?? {};
  return {
    title: o.title ?? commit.subject,
    body: o.body ?? commit.body ?? '',
    title_source: (o.title !== undefined ? 'override' : 'commit') as 'override' | 'commit',
    body_source: (o.body !== undefined ? 'override' : 'commit') as 'override' | 'commit',
    commit_subject: commit.subject,
    commit_body: commit.body ?? '',
  };
}
