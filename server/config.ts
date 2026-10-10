import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package root: the directory holding Local Review's own package.json. This file runs from server/ (from
 * source, via tsx: dev and tests) or from dist/server/ (the compiled, installed package), so walk up to it rather
 * than assume a depth.
 */
export function packageRoot(from = path.dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'local-review') return dir;
    } catch {
      /* no package.json here (or not ours): keep going */
    }
    if (path.dirname(dir) === dir) throw new Error(`can't find Local Review's package.json above ${from}`);
  }
}
export const ROOT = packageRoot();
/** The built UI (`npm run build`), the bundled fonts and the files `local-review init` / `guide` use. */
export const WEB_DIST = path.join(ROOT, 'dist', 'web');
export const FONT_DIR = path.join(ROOT, 'server', 'fonts');
export const EXAMPLE_PROJECT = path.join(ROOT, 'examples', 'project.example.yaml');
export const AGENT_GUIDE = path.join(ROOT, 'AGENT-GUIDE.md');

export function expandHome(p: string) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * User data lives outside the app repo, in ~/.local-review (or $LOCAL_REVIEW_HOME):
 *   projects/<slug>/{project.yaml, prs/, reviews/, assets/}   (assets/: images, server/assets.ts)
 *   backups/<ISO timestamp>/   automatic snapshots of projects/ (server/backups.ts)
 *   examples/orchard-<id>/     the example projects' repos, if you added them (server/examples.ts)
 */
export const HOME = path.resolve(expandHome(process.env.LOCAL_REVIEW_HOME || path.join(os.homedir(), '.local-review')));
/**
 * LOCAL_REVIEW_PROJECTS_DIR points just the projects at another directory (the tests use it). It's not a data
 * home, so automatic snapshots are off unless LOCAL_REVIEW_HOME is set too (then they go to $LOCAL_REVIEW_HOME/backups).
 */
const projectsOverride = process.env.LOCAL_REVIEW_PROJECTS_DIR;
export const PROJECTS_DIR = projectsOverride ? path.resolve(expandHome(projectsOverride)) : path.join(HOME, 'projects');
/** The example projects' git repos (server/examples.ts): created by Local Review, never anyone's work. */
export const EXAMPLES_DIR = path.join(HOME, 'examples');
export const BACKUPS_DIR: string | null = !projectsOverride || process.env.LOCAL_REVIEW_HOME ? path.join(HOME, 'backups') : null;
/** The default port. The one place it's set: the CLI's help, the startup line and `npm run dev` all derive from it. */
export { DEFAULT_PORT } from './port.js';
/** A port number from the command line or $PORT: an integer 0–65535 (0 picks any free port), else null. */
export function parsePort(v: string): number | null {
  return /^[0-9]{1,5}$/.test(v) && Number(v) <= 65535 ? Number(v) : null;
}

/** A name we use as a directory and a URL segment: [A-Za-z0-9._-], no leading dot. */
export const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
export function safeName(s: string, fallback: string) {
  return s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '_') || fallback;
}
