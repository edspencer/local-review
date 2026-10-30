// The GitHub sync: what GitHub says about each published PR (approvals, checks, review threads and their text, the
// PR's comments), kept as a cache on disk and shown beside Local Review's own data. It only reads GitHub, through a
// GithubSource (server/gh.ts), and only for PRs a prs file records (`github: {url}`), and it never writes anything
// but its own cache: <home>/github/<owner>/<repo>/<number>.json, one per PR, and sync.json, one per GitHub repo.
//
// It's a cache with a maximum age. One GitHub repo is one query (all its PRs, from every project that records them,
// batched), and a repo is due once its last fetch is older than `max_age` (server/settings.ts), whoever made it:
// the server's poll (only while a Local Review page is open), a page coming back into view (if over a minute old),
// the Refresh button or `local-review github refresh` (always). Merged and closed PRs are fetched once more and then
// left alone. A failed fetch backs off: 1, 2, 4… minutes, up to max_age.
//
// The CLI, the API and the poll all call refresh() here; none has its own way of fetching.
import fs from 'node:fs';
import path from 'node:path';
import { GITHUB_DIR } from './config.js';
import { atomicWrite } from './safefs.js';
import { listProjectSlugs, loadProjectConfig, type ProjectConfig } from './projects.js';
import { readPrFile } from './prs.js';
import { loadSettings, type GithubSettings } from './settings.js';
import { ghSource, type GithubSource } from './gh.js';
import { prKey, prRef, prsQuery, repoKey, snapshotOf, summaryOf, type GhPrSnapshot, type GhSummary, type PrRef } from '../shared/github.js';

/** How many PRs one query asks for (GitHub limits a query's size). */
const BATCH = 20;
/** A page coming back into view refreshes what's older than this. */
export const FOCUS_MIN_AGE_MS = 60_000;
const BACKOFF_MS = 60_000;

export interface RepoGroup {
  key: string; // owner/repo, lower-cased
  host: string;
  owner: string;
  repo: string;
  numbers: number[];
  projects: string[];
}

export interface RepoSync {
  version: 1;
  host: string;
  owner: string;
  repo: string;
  fetched_at: string | null; // the last fetch that worked
  tried_at: string | null; // the last attempt, worked or not
  error: string | null; // the last attempt's error (null once one works)
  failures: number;
  viewer: string | null;
  missing: number[]; // PRs GitHub didn't find (deleted, or a typo in the prs file)
}

// ---------------- where the PRs are: every project's prs files ----------------
/** The prs files' GitHub PRs of one project, per local repo. A PR recorded by number only takes its repo's URL. */
function projectPrs(cfg: ProjectConfig): { repo: string; ref: PrRef }[] {
  const out: { repo: string; ref: PrRef }[] = [];
  for (const rc of cfg.repos) {
    const dir = path.join(cfg.dir, 'prs', rc.name);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{40}\.yaml$/.test(n));
    } catch {
      continue;
    }
    const refs: PrRef[] = [];
    const bare: number[] = [];
    for (const n of names) {
      let gh;
      try {
        gh = readPrFile(path.join(dir, n)).override.github;
      } catch {
        continue;
      }
      if (!gh) continue;
      const r = prRef(gh.url);
      if (r) refs.push(r);
      else bare.push(gh.number);
    }
    const repos = new Set(refs.map((r) => `${r.host}/${repoKey(r)}`));
    if (bare.length && repos.size === 1) for (const number of bare) refs.push({ ...refs[0], number });
    for (const ref of refs) out.push({ repo: rc.name, ref });
  }
  return out;
}

/** Whether a project takes part: the sync is on and the project hasn't opted out (`github: {sync: off}`). */
export function projectSyncs(cfg: ProjectConfig | null, s: GithubSettings = loadSettings().github): boolean {
  return !!cfg && !cfg.error && s.sync && cfg.github_sync !== false;
}

/**
 * The GitHub repos to ask about, each with its PRs: from one project, or from every project that takes part (one
 * group per GitHub repo, however many projects or local repos record its PRs).
 */
export function collectRepos(opts: { project?: string; all?: boolean } = {}): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  const slugs = opts.project ? [opts.project] : listProjectSlugs();
  for (const slug of slugs) {
    const cfg = loadProjectConfig(slug);
    if (!cfg || cfg.error) continue;
    // a named project is asked about even with the sync off (an explicit refresh), unless it opted out
    if (opts.project || opts.all ? cfg.github_sync === false : !projectSyncs(cfg)) continue;
    for (const { ref } of projectPrs(cfg)) {
      const key = `${ref.host}/${repoKey(ref)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key: repoKey(ref), host: ref.host, owner: ref.owner, repo: ref.repo, numbers: [], projects: [] }));
      if (!g.numbers.includes(ref.number)) g.numbers.push(ref.number);
      if (!g.projects.includes(slug)) g.projects.push(slug);
    }
  }
  for (const g of groups.values()) g.numbers.sort((a, b) => a - b);
  return [...groups.values()];
}

// ---------------- the cache on disk ----------------
function repoDir(r: { owner: string; repo: string }): string | null {
  if (!GITHUB_DIR) return null;
  const [owner, repo] = repoKey(r).split('/');
  return path.join(GITHUB_DIR, owner, repo);
}

function readJson<T>(file: string | null): T | null {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function snapshotFile(r: PrRef): string | null {
  const d = repoDir(r);
  return d && path.join(d, `${r.number}.json`);
}

export function readSnapshot(r: PrRef): GhPrSnapshot | null {
  const s = readJson<GhPrSnapshot>(snapshotFile(r));
  return s?.version === 1 ? s : null;
}

export function readRepoSync(r: { owner: string; repo: string }): RepoSync | null {
  const d = repoDir(r);
  const s = readJson<RepoSync>(d && path.join(d, 'sync.json'));
  return s?.version === 1 ? s : null;
}

function writeRepoSync(s: RepoSync) {
  const d = repoDir(s);
  if (d) atomicWrite(path.join(d, 'sync.json'), JSON.stringify(s, null, 2) + '\n');
}

/** A stamp of every repo's sync.json: it changes whenever any fetch (the server's or the CLI's) finishes. */
export function cacheStamp(): string {
  if (!GITHUB_DIR) return '';
  const parts: string[] = [];
  let owners: string[] = [];
  try {
    owners = fs.readdirSync(GITHUB_DIR);
  } catch {
    return '';
  }
  for (const o of owners.sort()) {
    let repos: string[] = [];
    try {
      repos = fs.readdirSync(path.join(GITHUB_DIR, o));
    } catch {
      continue;
    }
    for (const r of repos.sort()) {
      try {
        parts.push(`${o}/${r}:${fs.statSync(path.join(GITHUB_DIR, o, r, 'sync.json')).mtimeMs}`);
      } catch {
        /* none yet */
      }
    }
  }
  return parts.join('|');
}

// ---------------- fetching ----------------
export interface RepoResult {
  key: string;
  host: string;
  fetched: number; // PRs fetched
  skipped?: 'fresh' | 'backoff' | 'closed'; // not asked: fresh enough, backing off after an error, or nothing open
  error?: string;
  missing?: number[];
}

export interface RefreshOptions {
  project?: string; // only this project's PRs (else every project that takes part)
  all?: boolean; // every project that hasn't opted out, even with the sync off (an explicit refresh)
  force?: boolean; // ask now, whatever the age, every PR (merged and closed ones too)
  minAgeMs?: number; // ask if older than this (default: max_age)
  source?: GithubSource;
  now?: () => number;
}

const inflight = new Map<string, Promise<RepoResult>>();

/** When a repo is next due (ms since the epoch), given its sync state; 0 = now. */
export function dueAt(s: RepoSync | null, minAgeMs: number, maxAgeMs: number): number {
  if (!s) return 0;
  const tried = s.tried_at ? Date.parse(s.tried_at) || 0 : 0;
  if (s.error && s.failures > 0) return tried + Math.min(maxAgeMs, BACKOFF_MS * 2 ** Math.min(s.failures - 1, 10));
  const fetched = s.fetched_at ? Date.parse(s.fetched_at) || 0 : 0;
  return fetched + minAgeMs;
}

async function fetchRepo(g: RepoGroup, numbers: number[], source: GithubSource, settings: GithubSettings, now: () => number): Promise<RepoResult> {
  const prev = readRepoSync(g);
  const at = new Date(now()).toISOString();
  const base: RepoSync = { version: 1, host: g.host, owner: g.owner, repo: g.repo, fetched_at: prev?.fetched_at ?? null, tried_at: at, error: null, failures: 0, viewer: prev?.viewer ?? null, missing: [] };
  try {
    let viewer = settings.me ?? prev?.viewer ?? null;
    for (let i = 0; i < numbers.length; i += BATCH) {
      const chunk = numbers.slice(i, i + BATCH);
      const res = await source.graphql(g.host, prsQuery(chunk), { owner: g.owner, name: g.repo });
      if (!res.data?.repository) throw new Error(res.errors?.[0]?.message ?? `GitHub has no repository ${g.owner}/${g.repo} (or this login can't see it)`);
      viewer = settings.me ?? res.data.viewer?.login ?? viewer;
      if (!viewer) throw new Error("couldn't tell who's logged in to GitHub");
      for (const n of chunk) {
        const node = res.data.repository[`pr${n}`];
        if (!node) {
          base.missing.push(n);
          continue;
        }
        const ref = { host: g.host, owner: g.owner, repo: g.repo, number: n };
        const file = snapshotFile(ref);
        if (file) atomicWrite(file, JSON.stringify(snapshotOf(node, ref, viewer, at), null, 2) + '\n');
      }
    }
    writeRepoSync({ ...base, fetched_at: at, viewer });
    return { key: g.key, host: g.host, fetched: numbers.length - base.missing.length, ...(base.missing.length ? { missing: base.missing } : {}) };
  } catch (e) {
    const error = (e as Error).message;
    writeRepoSync({ ...base, error, failures: (prev?.error ? prev.failures : 0) + 1, missing: prev?.missing ?? [] });
    return { key: g.key, host: g.host, fetched: 0, error };
  }
}

/** Bring what's cached up to date: each due repo is one query (or a few, past BATCH PRs). */
export async function refresh(opts: RefreshOptions = {}): Promise<RepoResult[]> {
  const settings = loadSettings().github;
  const source = opts.source ?? ghSource;
  const now = opts.now ?? Date.now;
  const minAge = opts.minAgeMs ?? settings.maxAgeMs;
  const groups = collectRepos({ project: opts.project, all: opts.all });
  return Promise.all(
    groups.map((g) => {
      const id = `${g.host}/${g.key}`;
      const running = inflight.get(id);
      if (running) return running; // a fetch is under way: this one joins it
      const sync = readRepoSync(g);
      // ask about open PRs, and any not fetched yet (or not found last time: a fixed prs file); all of them if forced
      const numbers = g.numbers.filter((n) => {
        if (opts.force) return true;
        const s = readSnapshot({ ...g, number: n });
        return !s || s.state === 'open';
      });
      if (!numbers.length) return Promise.resolve<RepoResult>({ key: g.key, host: g.host, fetched: 0, skipped: 'closed' });
      const unseen = numbers.some((n) => !readSnapshot({ ...g, number: n }) && !sync?.missing.includes(n));
      if (!opts.force && !(unseen && !sync?.error) && dueAt(sync, minAge, settings.maxAgeMs) > now())
        return Promise.resolve<RepoResult>({ key: g.key, host: g.host, fetched: 0, skipped: sync?.error ? 'backoff' : 'fresh' });
      const p = fetchRepo(g, numbers, source, settings, now).finally(() => inflight.delete(id));
      inflight.set(id, p);
      return p;
    }),
  );
}

// ---------------- what the UI shows ----------------
export interface ProjectGithub {
  enabled: boolean; // the sync is on and this project takes part
  optedOut: boolean; // the project said `github: {sync: off}`
  source: string;
  maxAgeMs: number;
  fetchedAt: string | null; // the oldest of its repos' last good fetches (what's shown is at least this fresh)
  error: string | null;
  repos: { key: string; host: string; fetched_at: string | null; error: string | null; prs: number }[];
  prs: Record<string, GhSummary>; // by prKey (owner/repo#n)
  aliases: Record<string, string>; // `<local repo>#<n>` → prKey, for PRs a prs file records by number only
}

/** One project's GitHub state, from the cache (no network): summaries for the sidebar, and how fresh they are. */
export function projectGithub(slug: string): ProjectGithub | null {
  const cfg = loadProjectConfig(slug);
  if (!cfg) return null;
  const settings = loadSettings().github;
  const out: ProjectGithub = { enabled: projectSyncs(cfg, settings), optedOut: cfg.github_sync === false, source: settings.source, maxAgeMs: settings.maxAgeMs, fetchedAt: null, error: null, repos: [], prs: {}, aliases: {} };
  if (cfg.error || out.optedOut) return out;
  const repos = new Map<string, ProjectGithub['repos'][number]>();
  for (const { repo, ref } of projectPrs(cfg)) {
    const key = prKey(ref);
    out.aliases[`${repo}#${ref.number}`] = key;
    const s = readSnapshot(ref);
    if (s) out.prs[key] = summaryOf(s);
    const rk = `${ref.host}/${repoKey(ref)}`;
    let r = repos.get(rk);
    if (!r) {
      const sync = readRepoSync(ref);
      repos.set(rk, (r = { key: repoKey(ref), host: ref.host, fetched_at: sync?.fetched_at ?? null, error: sync?.error ?? null, prs: 0 }));
    }
    r.prs++;
  }
  out.repos = [...repos.values()];
  out.fetchedAt = out.repos.map((r) => r.fetched_at).filter((t): t is string => !!t).sort()[0] ?? null;
  out.error = out.repos.find((r) => r.error)?.error ?? null;
  return out;
}

/** One PR's full snapshot (threads and comments with their text), from the cache; null if it hasn't been fetched. */
export function prSnapshot(url: string): GhPrSnapshot | null {
  const r = prRef(url);
  return r ? readSnapshot(r) : null;
}

// ---------------- the server's poll ----------------
/**
 * While someone's watching (a Local Review page is open), refresh what's due, and tell the pages when the cache
 * changes (the server's own fetches and the CLI's alike). Called once on server start.
 */
export function startGithubSync(o: { watching: () => boolean; changed: () => void }) {
  let stamp = cacheStamp();
  let lastDueCheck = 0;
  let busy = false;
  const tick = async () => {
    if (busy || !o.watching()) return;
    busy = true;
    try {
      // the due check reads every project's prs files, so not on every tick
      if (loadSettings().github.sync && Date.now() - lastDueCheck >= DUE_CHECK_MS) {
        lastDueCheck = Date.now();
        await refresh();
      }
      const now = cacheStamp();
      if (now !== stamp) {
        stamp = now;
        o.changed();
      }
    } catch (e) {
      console.error('[github sync]', e);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

const TICK_MS = 5000;
const DUE_CHECK_MS = 15_000;
