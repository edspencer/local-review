import fs from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import { BACKUPS_DIR, PROJECTS_DIR } from './config.js';
import { startSnapshots } from './backups.js';
import { headOf } from './commits.js';
import { listProjectSlugs, loadProjectConfig } from './projects.js';

export type ServerEvent =
  | { type: 'review'; project: string; repo: string; sha: string }
  | { type: 'pr'; project: string; repo: string; sha: string }
  | { type: 'project'; project: string; reason: string; repo?: string }
  | { type: 'projects'; reason: string };

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(l: Listener) {
  listeners.add(l);
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

  // poll range ends (branch heads) so new / amended / rebased commits show up
  const heads = new Map<string, string | null>();
  const poll = async () => {
    for (const slug of listProjectSlugs()) {
      const cfg = loadProjectConfig(slug);
      for (const r of cfg?.repos ?? []) {
        const key = `${slug}\0${r.name}\0${r.path}\0${r.to ?? r.branch}`;
        const h = await headOf(r);
        if (heads.has(key) && heads.get(key) !== h) emit({ type: 'project', project: slug, reason: 'head', repo: r.name });
        heads.set(key, h);
      }
    }
  };
  poll().catch(() => {});
  setInterval(() => poll().catch(() => {}), 3000).unref();
}
