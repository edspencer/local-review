// Cheap fingerprints of what derived data depends on, so it can be cached and still be right after a rebase, a
// new branch, or an agent's edit to a YAML file:
//
// - a repo range's git state: what its end, `from` and base resolve to (one `git cat-file --batch-check`) and its
//   branches (one `git for-each-ref`). A range's commits, stacks and branch tags follow from these shas.
// - a directory's stat (name, mtime, size, inode of each entry): prs/<repo>/, reviews/<repo>/. (project.yaml is
//   compared by its text: projects.ts.)
//
// The directory stamps are taken on every request (a few stats). The git state costs two processes, so it's only read
// again when the repo's ref files change (reffiles.ts: a few stats, no git), or when it's RECHECK_MS old (a safety net
// for a change those stats somehow missed). While the server runs, the branch-head poll (events.ts) checks every
// range every few seconds and requests use what it saw (trustPolled); a change it sees is also pushed to the browser.
// Without the poll (tests, CLI commands) every read checks the ref files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REF_LIST_ARGS, emptyRefIndex, parseRefs, type RefIndex } from './branches.js';
import { rangeEnd, resolveRange, type RangeRefs, type RepoRange } from './commits.js';
import { git } from './git.js';
import { refFilesStamp } from './reffiles.js';

export interface RepoState {
  refs: RangeRefs; // what the range's refs point at
  refIndex: RefIndex; // every local and remote branch
  stamp: string; // changes whenever either does
  at: number; // when git was read (Date.now())
}

/** How long a range's git state stands, while its ref files are unchanged, before git is asked again anyway. */
export const RECHECK_MS = 10 * 60_000;

interface Entry {
  state?: RepoState;
  files?: string | null; // the ref-file stamp taken just before `state` was read
  checked?: number; // when `state` was last known current (read, or its ref files seen unchanged)
  pending?: Promise<RepoState>;
}
const states = new Map<string, Entry>();
let trustMs = 0;

/** Let reads use a range's git state for up to `ms` after it was last checked (the poll keeps it fresher than that). */
export function trustPolled(ms: number) {
  trustMs = ms;
}

const rangeKey = (cfg: RepoRange) => [cfg.path, rangeEnd(cfg), cfg.from ?? '', cfg.base ?? '', cfg.after ?? ''].join('\0');

// The branch listing is the repo's, not the range's: ranges in one repo share it while the ref files are unchanged.
const listings = new Map<string, { files: string; at: number; p: Promise<string> }>();

function refListing(repo: string, files: string | null): Promise<string> {
  const now = Date.now();
  const hit = files === null ? undefined : listings.get(repo);
  if (hit && hit.files === files && now - hit.at < RECHECK_MS) return hit.p;
  const p: Promise<string> = git(repo, REF_LIST_ARGS).catch(() => {
    if (listings.get(repo)?.p === p) listings.delete(repo); // a failed read isn't kept
    return '';
  });
  if (files !== null) listings.set(repo, { files, at: now, p });
  return p;
}

async function readState(cfg: RepoRange, files: string | null): Promise<RepoState> {
  const at = Date.now();
  if (!fs.existsSync(cfg.path)) return { refs: { head: null, from: null, base: null }, refIndex: emptyRefIndex(), stamp: 'missing', at };
  const [refs, listing] = await Promise.all([resolveRange(cfg), refListing(cfg.path, files)]);
  const stamp = crypto.createHash('sha1').update(JSON.stringify(refs)).update('\0').update(listing).digest('hex');
  return { refs, refIndex: parseRefs(listing), stamp, at };
}

/**
 * A range's git state: the polled one if it was checked recently enough (see trustPolled), the last one read if the
 * repo's ref files haven't changed since (and it's under RECHECK_MS old), else read from git now. `fresh` (the poll)
 * skips the first of those. Concurrent reads of one range share a single git call. `files` lets one poll round stat
 * each repo's ref files once for all its ranges.
 */
export function repoState(cfg: RepoRange, opts: { fresh?: boolean; files?: Map<string, string | null> } = {}): Promise<RepoState> {
  const k = rangeKey(cfg);
  let e = states.get(k);
  if (!e) states.set(k, (e = {}));
  const now = Date.now();
  if (!opts.fresh && e.state && now - (e.checked ?? 0) < trustMs) return Promise.resolve(e.state);
  if (e.pending) return e.pending;
  // stamped before git runs, so a change made while it reads is seen next time
  let files = opts.files?.get(cfg.path);
  if (files === undefined) {
    files = refFilesStamp(cfg.path);
    opts.files?.set(cfg.path, files);
  }
  if (e.state && files !== null && files === e.files && now - e.state.at < RECHECK_MS) {
    e.checked = now;
    return Promise.resolve(e.state);
  }
  const entry = e;
  const stampedFiles = files;
  const p = readState(cfg, files).then((s) => {
    if (!entry.state || entry.state.at <= s.at) {
      entry.state = s;
      entry.files = stampedFiles;
      entry.checked = s.at;
    }
    return s;
  });
  entry.pending = p;
  p.finally(() => {
    if (entry.pending === p) entry.pending = undefined;
  }).catch(() => {});
  return p;
}

function statOf(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return '-';
  }
}

/** A directory's stamp: changes when any file in it is written, added, removed or renamed (one level). */
export function dirStamp(dir: string): string {
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return '-';
  }
  return names.map((n) => `${n}:${statOf(path.join(dir, n))}`).join('|');
}
