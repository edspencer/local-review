// The PR pages the browser has loaded, kept in memory so moving between PRs paints straight away: a page already
// seen (or prefetched: the previous and next PR, a sidebar row you hover) shows at once, and is refreshed in the
// background if a server event said it may have changed. Bounded, and only ever ahead of the server by what this
// tab itself just saved.
import { useSyncExternalStore } from 'react';
import { api, type CommitResponse, type Loc, type ServerEvent } from './api';

export interface Entry {
  data: CommitResponse;
  /** a server event may have changed it since: show it, but fetch it again */
  stale: boolean;
}

const MAX_ENTRIES = 40;
const PREFETCH_PARALLEL = 2;

const entries = new Map<string, Entry>(); // `project\0repo\0full sha`, least recently used first
const inflight = new Map<string, Promise<CommitResponse>>(); // by the sha as asked (a URL's short sha)
let active: string | null = null; // the entry on screen: refreshed on events rather than just marked stale
const subs = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  subs.forEach((f) => f());
};

const keyOf = (l: Loc, fullSha: string) => `${l.project}\0${l.repo}\0${fullSha}`;
const askKey = (l: Loc, sha: string) => `${l.project}\0${l.repo}\0${sha.toLowerCase()}`;

/** The entry for a URL's (possibly short) sha, if loaded. */
export function peek(l: Loc, sha: string): Entry | undefined {
  const s = sha.toLowerCase();
  const prefix = `${l.project}\0${l.repo}\0`;
  for (const [k, e] of entries) if (k.startsWith(prefix) && k.slice(prefix.length).startsWith(s)) return e;
  return undefined;
}

/** `next`, but with each of its keys whose value is unchanged from `prev` taken from `prev` (`prev` itself if all are). */
function keep<T extends object>(prev: T, next: T): T {
  const out = { ...next };
  let all = Object.keys(prev).length === Object.keys(next).length;
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (prev[k] === next[k] || JSON.stringify(prev[k]) === JSON.stringify(next[k])) out[k] = prev[k];
    else all = false;
  }
  return all ? prev : out;
}

/** Reuse the parts of a refreshed page that didn't change, so they don't re-render (the files: or re-diff). */
function share(prev: CommitResponse | undefined, next: CommitResponse): CommitResponse {
  if (!prev || prev.commit.sha !== next.commit.sha) return next;
  return keep(prev, { ...next, commit: keep(prev.commit, next.commit) });
}

function put(l: Loc, data: CommitResponse) {
  const k = keyOf(l, data.commit.sha);
  const prev = entries.get(k);
  entries.delete(k); // most recently used last
  entries.set(k, { data: share(prev?.data, data), stale: false });
  for (const old of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break;
    if (old !== active) entries.delete(old);
  }
  changed();
}

/** Fetch a PR page (once, however many ask) and keep it. */
export function load(l: Loc, sha: string): Promise<CommitResponse> {
  const ak = askKey(l, sha);
  let p = inflight.get(ak);
  if (!p) {
    p = api.commit(l, sha).then((d) => {
      put(l, d);
      return d;
    });
    inflight.set(ak, p);
    const done = () => inflight.delete(ak);
    p.then(done, done);
  }
  return p;
}

/** Load it if it isn't loaded, or may be out of date. */
export function ensure(l: Loc, sha: string): Promise<CommitResponse> | null {
  const e = peek(l, sha);
  return e && !e.stale ? null : load(l, sha);
}

// prefetches run a couple at a time, newest wish first, and never hold up what's on screen
const queue: { l: Loc; sha: string }[] = [];
let running = 0;
function pump() {
  while (running < PREFETCH_PARALLEL && queue.length) {
    const { l, sha } = queue.pop()!;
    const e = peek(l, sha);
    if ((e && !e.stale) || inflight.has(askKey(l, sha))) continue;
    running++;
    load(l, sha)
      .catch(() => {})
      .finally(() => {
        running--;
        pump();
      });
  }
}

/** Warm the cache for a PR the reviewer is likely to open next. */
export function prefetch(l: Loc, sha: string) {
  const e = peek(l, sha);
  if ((e && !e.stale) || inflight.has(askKey(l, sha))) return;
  const i = queue.findIndex((q) => q.l.project === l.project && q.l.repo === l.repo && q.sha === sha);
  if (i >= 0) queue.splice(i, 1);
  queue.push({ l, sha });
  if (queue.length > 8) queue.shift();
  pump();
}

let hoverTimer: ReturnType<typeof setTimeout> | undefined;
/** Props for a link to a PR: prefetch it when the pointer rests on it (or it gets focus). */
export function hoverPrefetch(l: Loc, sha: string) {
  return {
    onMouseEnter: () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => prefetch(l, sha), 60);
    },
    onMouseLeave: () => clearTimeout(hoverTimer),
    onFocus: () => prefetch(l, sha),
  };
}

/** Change a loaded entry in place (what this tab just saved: a comment, Viewed, the PR title). */
export function patch(l: Loc, fullSha: string, fn: (d: CommitResponse) => CommitResponse) {
  const k = keyOf(l, fullSha);
  const e = entries.get(k);
  if (!e) return;
  entries.set(k, { ...e, data: fn(e.data) });
  changed();
}

/** The entry on screen (or none): server events refresh it straight away instead of just marking it stale. */
export function setActive(l: Loc | null, fullSha?: string) {
  active = l && fullSha ? keyOf(l, fullSha) : null;
}

/** A server event: mark what it may have changed; refresh the part of the page on screen it's about. */
export function onServerEvent(e: ServerEvent) {
  let touched = false;
  for (const [k, entry] of entries) {
    const [project, repo, sha] = k.split('\0');
    if (e.type !== 'projects' && e.project !== project) continue;
    const exact = (e.type === 'review' || e.type === 'pr') && e.repo === repo && e.sha === sha;
    if ((e.type === 'review' || e.type === 'pr') && !exact) continue;
    const l = { project, repo };
    if (k === active) {
      // only the part that changed: a new review keeps the files (and their rendered diffs) as they are
      if (e.type === 'review') api.review(l, sha).then((r) => patch(l, sha, (d) => ({ ...d, review: r }))).catch(() => {});
      else if (e.type === 'pr') api.pr(l, sha).then((pr) => patch(l, sha, (d) => ({ ...d, pr }))).catch(() => {});
      else load(l, sha).catch(() => {}); // stacks, prev / next or branches may have moved; keeps what's on screen if it fails
    } else if (!entry.stale) {
      entries.set(k, { ...entry, stale: true });
      touched = true;
    }
  }
  if (touched) changed();
}

/** Everything may be out of date (the event stream dropped, so events may have been missed). */
export function invalidateAll() {
  for (const [k, e] of entries) entries.set(k, { ...e, stale: true });
  changed();
}

/** The entry for a URL's sha, re-rendering when the cache changes. */
export function useCommitEntry(l: Loc, sha: string): Entry | undefined {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
  return peek(l, sha);
}
