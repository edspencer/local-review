// What git said about a repo's commits, kept on disk so a restart needn't ask again: each commit's summary and
// changed files, merge-bases, ancestry, patch-ids, rev-lists. Every entry is keyed by full shas, and a sha's commit
// (its tree, parents, message) can't change, so entries never go stale. Only definite answers are stored (not "not
// found", which a fetch can change).
//
// One JSON file per repo in CACHE_DIR, read the first time the repo is asked about and written (atomically) a moment
// after it changes. It's disposable: a file that's missing, unreadable or from another version is simply rebuilt,
// and deleting the directory loses nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './config.js';
import { atomicWrite } from './safefs.js';

const VERSION = 1; // bump when what's stored (or how git is asked for it) changes
const MAX_ENTRIES = 50_000; // per repo; past this the file starts over
const FLUSH_MS = 2000;

interface RepoFile {
  path: string;
  file: string;
  entries: Map<string, unknown>; // `${ns}\0${key}`
  dirty: boolean;
  timer?: NodeJS.Timeout;
}

const repos = new Map<string, RepoFile | null>();
let dir: string | null = CACHE_DIR;

/** Point the cache somewhere else, or turn it off (null), and forget what's loaded (tests). */
export function setCacheDir(d: string | null) {
  flushAll();
  dir = d;
  repos.clear();
}

function open(repo: string): RepoFile | null {
  if (!dir) return null;
  let r = repos.get(repo);
  if (r !== undefined) return r;
  const file = path.join(dir, `${crypto.createHash('sha1').update(repo).digest('hex').slice(0, 16)}.json`);
  const entries = new Map<string, unknown>();
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc?.version === VERSION && doc.repo === repo && doc.entries && typeof doc.entries === 'object')
      for (const [k, v] of Object.entries(doc.entries)) entries.set(k, v);
  } catch {
    /* none yet, or unreadable: start over */
  }
  r = { path: repo, file, entries, dirty: false };
  repos.set(repo, r);
  return r;
}

function flush(r: RepoFile) {
  clearTimeout(r.timer);
  r.timer = undefined;
  if (!r.dirty) return;
  r.dirty = false;
  try {
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    atomicWrite(r.file, JSON.stringify({ version: VERSION, repo: r.path, entries: Object.fromEntries(r.entries) }));
  } catch {
    /* a cache: next time, then */
  }
}

/** Write everything that's pending now (on exit; tests). */
export function flushAll() {
  for (const r of repos.values()) if (r) flush(r);
}

export function diskGet<T>(repo: string, ns: string, key: string): T | undefined {
  return open(repo)?.entries.get(`${ns}\0${key}`) as T | undefined;
}

export function diskSet(repo: string, ns: string, key: string, value: unknown) {
  const r = open(repo);
  if (!r) return;
  if (r.entries.size >= MAX_ENTRIES) r.entries.clear();
  r.entries.set(`${ns}\0${key}`, value);
  r.dirty = true;
  if (!r.timer) {
    r.timer = setTimeout(() => flush(r), FLUSH_MS);
    r.timer.unref();
  }
}

process.on('exit', flushAll);
// Ctrl-C and kill don't run 'exit': write, then let the signal do what it would have
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, () => {
    flushAll();
    process.kill(process.pid, sig);
  });
