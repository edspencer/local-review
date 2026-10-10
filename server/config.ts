import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function expandHome(p: string) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * User data lives outside the app repo, in ~/.local-review (or $LOCAL_REVIEW_HOME):
 *   projects/<slug>/{project.yaml, prs/, reviews/}
 *   backups/<ISO timestamp>/   automatic snapshots of projects/ (server/backups.ts)
 */
export const HOME = path.resolve(expandHome(process.env.LOCAL_REVIEW_HOME || path.join(os.homedir(), '.local-review')));
/**
 * LOCAL_REVIEW_PROJECTS_DIR points just the projects at another directory (the tests use it). It's not a data
 * home, so automatic snapshots are off unless LOCAL_REVIEW_HOME is set too (then they go to $LOCAL_REVIEW_HOME/backups).
 */
const projectsOverride = process.env.LOCAL_REVIEW_PROJECTS_DIR;
export const PROJECTS_DIR = projectsOverride ? path.resolve(expandHome(projectsOverride)) : path.join(HOME, 'projects');
export const BACKUPS_DIR: string | null = !projectsOverride || process.env.LOCAL_REVIEW_HOME ? path.join(HOME, 'backups') : null;
export const PORT = Number(process.env.PORT ?? 5000);

/** A name we use as a directory and a URL segment: [A-Za-z0-9._-], no leading dot. */
export const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
export function safeName(s: string, fallback: string) {
  return s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '_') || fallback;
}
