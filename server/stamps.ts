// Cheap fingerprints of what derived data depends on, so it can be cached and still be right after a rebase, a
// new branch, or an agent's edit to a YAML file:
//
// - a repo range's git state: what its end, `from` and base resolve to (one `git cat-file --batch-check`) and its
//   branches (one `git for-each-ref`). A range's commits, stacks and branch tags follow from these shas.
// - a directory's stat (name, mtime, size, inode of each entry): prs/<repo>/, reviews/<repo>/. (project.yaml is
//   compared by its text: projects.ts.)
//
// The directory stamps are taken on every request (a few stats). The git state costs a process or two, so while the
// server runs, the branch-head poll (events.ts) re-reads every range's state every few seconds and requests use that
// (trustPolled); a change it sees is also pushed to the browser. Without the poll (tests, CLI commands) every read
// checks git.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REF_LIST_ARGS, emptyRefIndex, parseRefs, type RefIndex } from './branches.js';
import { rangeEnd, resolveRange, type RangeRefs, type RepoRange } from './commits.js';
import { git } from './git.js';

export interface RepoState {
  refs: RangeRefs; // what the range's refs point at
  refIndex: RefIndex; // every local and remote branch
  stamp: string; // changes whenever either does
  at: number; // when git was read (Date.now())
}

const states = new Map<string, { state?: RepoState; pending?: Promise<RepoState> }>();
let trustMs = 0;

/** Let reads use a range's git state for up to `ms` after it was read (the poll keeps it fresher than that). */
export function trustPolled(ms: number) {
  trustMs = ms;
}

const rangeKey = (cfg: RepoRange) => [cfg.path, rangeEnd(cfg), cfg.from ?? '', cfg.base ?? ''].join('\0');

async function readState(cfg: RepoRange): Promise<RepoState> {
  const at = Date.now();
  if (!fs.existsSync(cfg.path)) return { refs: { head: null, from: null, base: null }, refIndex: emptyRefIndex(), stamp: 'missing', at };
  const [refs, listing] = await Promise.all([
    resolveRange(cfg),
    git(cfg.path, REF_LIST_ARGS).catch(() => ''),
  ]);
  const stamp = crypto.createHash('sha1').update(JSON.stringify(refs)).update('\0').update(listing).digest('hex');
  return { refs, refIndex: parseRefs(listing), stamp, at };
}

/**
 * A range's git state: the polled one if it's recent enough (see trustPolled), else read now. `fresh` always reads
 * (the poll). Concurrent reads of one range share a single git call.
 */
export function repoState(cfg: RepoRange, opts: { fresh?: boolean } = {}): Promise<RepoState> {
  const k = rangeKey(cfg);
  let e = states.get(k);
  if (!e) states.set(k, (e = {}));
  if (!opts.fresh && e.state && Date.now() - e.state.at < trustMs) return Promise.resolve(e.state);
  if (e.pending) return e.pending;
  const entry = e;
  const p = readState(cfg).then((s) => {
    if (!entry.state || entry.state.at <= s.at) entry.state = s;
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
