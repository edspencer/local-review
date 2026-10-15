import fs from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import { BACKUPS_DIR, PROJECTS_DIR } from './config.js';
import { startSnapshots } from './backups.js';
import { linkedRepos, listProjectSlugs, loadProjectConfig } from './projects.js';
import { repoState, trustPolled } from './stamps.js';

export type ServerEvent =
  | { type: 'review'; project: string; repo: string; sha: string }
  | { type: 'pr'; project: string; repo: string; sha: string }
  | { type: 'project'; project: string; reason: string; repo?: string }
  | { type: 'projects'; reason: string };

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let onFirstListener: (() => void) | null = null;

/** Listen for changes (the browser's event stream). The branch poll only runs while someone is. */
export function subscribe(l: Listener) {
  listeners.add(l);
  if (listeners.size === 1) onFirstListener?.();
  return () => listeners.delete(l);
}

export function emit(e: ServerEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* ignore broken listener */
    }
  }
}

// debounce per key so a burst of fs events becomes one push
const timers = new Map<string, NodeJS.Timeout>();
function emitSoon(key: string, e: ServerEvent, ms = 150) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { timers.delete(key); emit(e); }, ms));
}

/** Map a changed path under projects/ to the event the browser needs. */
export function eventFor(rel: string[]): ServerEvent | null {
  const [project, kind, repo, name] = rel;
  if (!project) return null;
  if (rel.length === 1) return { type: 'projects', reason: 'dir' };
  if (rel.length === 2) return kind === 'project.yaml' ? { type: 'project', project, reason: 'config' } : null;
  if (rel.length !== 4 || (kind !== 'reviews' && kind !== 'prs')) return null;
  const m = /^([0-9a-f]{40})\.yaml$/.exec(name);
  if (m) return { type: kind === 'reviews' ? 'review' : 'pr', project, repo, sha: m[1] };
  // renamed/backup files can still affect rebase re-matching
  if (name.endsWith('.yaml') || name.endsWith('.bak')) return { type: 'project', project, reason: kind, repo };
  return null;
}

/** Watch projects/ and the branch heads, and take automatic snapshots (backups.ts). Called once on server start. */
export function startWatchers() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  startSnapshots(PROJECTS_DIR, BACKUPS_DIR);
  const onPath = (p: string) => {
    const rel = path.relative(PROJECTS_DIR, p).split(path.sep);
    if (rel[0] === '' || rel[0] === '..') return;
    const e = eventFor(rel);
    if (!e) return;
    const key = e.type === 'review' || e.type === 'pr' ? `${e.type}:${e.project}:${e.repo}:${e.sha}` : e.type === 'project' ? `project:${e.project}` : 'projects';
    emitSoon(key, e);
    if (e.type === 'project' && e.reason === 'config') emitSoon('projects', { type: 'projects', reason: 'config' });
  };
  watch(PROJECTS_DIR, { ignoreInitial: true, depth: 3, awaitWriteFinish: false, ignored: (p) => path.basename(p).endsWith('.tmp') })
    .on('add', onPath)
    .on('change', onPath)
    .on('unlink', onPath)
    .on('addDir', onPath)
    .on('unlinkDir', onPath)
    .on('error', (err) => console.error('[watch projects]', err));

  // poll each range's git state (stamps.ts: its end, base and branches) so new / amended / rebased commits, a moved
  // base and new branch tags show up; requests use what the poll read (trustPolled) rather than asking git again.
  // A round only runs git for repos whose ref files changed (reffiles.ts), and no round runs while no browser is
  // listening: a request then checks for itself.
  const seen = new Map<string, { stamp: string; head: string | null }>();
  const poll = () => {
    const files = new Map<string, string | null>(); // each repo's ref files, stat'd once this round
    return Promise.all(
      listProjectSlugs().flatMap((slug) =>
        (() => {
          const cfg = loadProjectConfig(slug);
          return cfg ? linkedRepos(cfg) : [];
        })().map(async (r) => {
          const key = `${slug}\0${r.name}\0${r.path}\0${r.to ?? r.branch}\0${r.from ?? ''}\0${r.base ?? ''}\0${r.after ?? ''}`;
          const s = await repoState(r, { fresh: true, files });
          const was = seen.get(key);
          if (was && was.stamp !== s.stamp) emit({ type: 'project', project: slug, reason: was.head !== s.refs.head ? 'head' : 'refs', repo: r.name });
          seen.set(key, { stamp: s.stamp, head: s.refs.head });
        }),
      ),
    );
  };
  let polling = false;
  const tick = async () => {
    if (polling || !listeners.size) return; // a slow round (many repos) doesn't stack up; nobody's watching
    polling = true;
    try {
      await poll();
    } catch {
      /* next round */
    } finally {
      polling = false;
    }
  };
  onFirstListener = () => void tick(); // a browser (re)connecting catches up at once, not a round later
  tick();
  setInterval(tick, POLL_MS).unref();
  // a poll round can be late or slow; past this, a request checks for itself (the ref files, then git if they moved)
  trustPolled(POLL_MS * 2 + 1000);
}

const POLL_MS = 2000;
