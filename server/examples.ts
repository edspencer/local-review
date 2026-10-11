// The example projects: "Orchard", the made-up booking app from the demo test bed (demo/), so a new user can click
// around a realistic review (four repos, several stacks, threads) before setting up their own.
//
// Adding them creates, and only ever creates:
//   - four brand-new git repos under examples/orchard-<id>/ in the data home. They're Local Review's own data, made
//     here from the in-memory history in demo/world (git init + one fast-import, deterministic: the same shas
//     everywhere). They aren't anyone's work, and once made they're only ever read, like any reviewed repo.
//   - projects/example-<name>/: project.yaml (with `example: true`), prs/ and reviews/ files, all written
//     create-only through safefs (a file that's already there is kept, never replaced).
//
// The git work is asynchronous (execFile), so the server keeps serving, and its event stream keeps flowing, while
// they're made. Adding while an add is running joins it; removing while one is running is refused (409).
//
// Removing them deletes nothing: each example project.yaml is renamed (no-clobber) to
// project.example-removed.yaml.bak, so the project drops out of the list with every file still there, including any
// comments the user wrote on it. Adding them again renames it back. The repos stay in examples/; the docs say how to
// reclaim the space by hand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXAMPLES_DIR, PROJECTS_DIR } from './config.js';
import { ExistsError, atomicWrite, renameNoClobber, renameToBak } from './safefs.js';
import { parseProject } from './projects.js';
import { buildApi } from '../demo/world/api.js';
import { buildInfra } from '../demo/world/infra.js';
import { buildSdk } from '../demo/world/sdk.js';
import { buildWeb } from '../demo/world/web.js';
import { PROJECTS, buildDataHome, patchIds, type Repos } from '../demo/world/review.js';
import type { RepoBuilder } from '../demo/lib/gitworld.js';

export const EXAMPLE_PREFIX = 'example-';
export const EXAMPLE_SLUGS = PROJECTS.map((p) => EXAMPLE_PREFIX + p);
const REMOVED_TAG = 'example-removed';
const EXAMPLE_HEADER = `# An example project: made up, for trying Local Review. "Remove examples" in the UI (or
# \`local-review examples remove\`) hides it again by renaming this file; nothing is deleted.
example: true
`;
/** The branch the example repos have checked out, as the demo's. */
const CHECKOUT = 'maya/waitlists';

export class ExamplesConflictError extends Error {
  status = 409;
}

export type ExamplesState = 'none' | 'present' | 'removed';

export interface ExamplesResult {
  created: string[];
  restored: string[];
  existing: string[];
  removed: string[];
}

const yamlOf = (slug: string) => path.join(PROJECTS_DIR, slug, 'project.yaml');

/** Is this project.yaml one of ours (`example: true`)? */
function isExampleYaml(file: string): boolean {
  try {
    return !!parseProject(path.basename(path.dirname(file)), path.dirname(file), fs.readFileSync(file, 'utf8')).example;
  } catch {
    return false;
  }
}

/** The removed copies of an example's project.yaml, newest last. */
function removedCopies(slug: string): string[] {
  const dir = path.join(PROJECTS_DIR, slug);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const n = (f: string) => Number(/\.(\d+)\.yaml\.bak$/.exec(f)?.[1] ?? 1);
  return names
    .filter((f) => f.startsWith(`project.${REMOVED_TAG}.`) && f.endsWith('.yaml.bak'))
    .sort((a, b) => n(a) - n(b))
    .map((f) => path.join(dir, f));
}

/** 'present' if any example project is listed, 'removed' if they were removed (and can be restored), else 'none'. */
export function examplesState(): ExamplesState {
  if (EXAMPLE_SLUGS.some((s) => fs.existsSync(yamlOf(s)) && isExampleYaml(yamlOf(s)))) return 'present';
  if (EXAMPLE_SLUGS.some((s) => removedCopies(s).length > 0)) return 'removed';
  return 'none';
}

/**
 * Example projects this version ships that aren't in the list yet and weren't removed: new in an update (a fresh
 * install has all or none). Adding the examples again creates just these, leaving the others as they are.
 */
export function newExamples(): string[] {
  if (examplesState() !== 'present') return [];
  return EXAMPLE_SLUGS.filter((s) => !fs.existsSync(yamlOf(s)) && !removedCopies(s).length);
}

function world(): Repos {
  return { api: buildApi(), sdk: buildSdk(), web: buildWeb(), infra: buildInfra() };
}

/**
 * A short id for this version of the example history: the repos live in examples/orchard-<id>, so a Local Review
 * whose examples changed makes fresh repos next to the old ones instead of touching them.
 */
function worldId(repos: Repos): string {
  const h = crypto.createHash('sha256');
  for (const r of Object.values(repos) as RepoBuilder[]) {
    h.update(`${r.name}\0${r.remoteUrl}\0`);
    for (const c of r.commits) {
      h.update(`${c.mark}\0${c.key}\0${c.message}\0${c.author.email}\0${c.authorAt}\0${c.committer.email}\0${c.committedAt}\0${c.parent?.mark ?? ''}\0${c.merge?.mark ?? ''}\0`);
      for (const [p, content] of [...c.files].sort(([a], [b]) => a.localeCompare(b))) h.update(`${p}\0${content}\0`);
    }
    for (const [ref, c] of r.refs) h.update(`${ref}\0${c.mark}\0`);
  }
  return h.digest('hex').slice(0, 10);
}

interface RepoManifest {
  id: string;
  /** every commit's sha, by repo and key: the repos are complete once this file exists */
  repos: Record<string, Record<string, string>>;
}

/** `~/…` when under the home directory, so the project.yaml reads like one a person wrote. */
function displayPath(p: string): string {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + path.sep) ? `~/${path.relative(home, p).split(path.sep).join('/')}` : p;
}

/**
 * Make (or find, already made) this version's repos; fills in every commit's sha. They're complete once their
 * manifest.json exists. A folder left incomplete by an interrupted attempt is left alone (never cleared): the repos
 * go to the next free name, orchard-<id>-2, … instead.
 */
async function ensureRepos(repos: Repos): Promise<string> {
  const id = worldId(repos);
  const all = Object.values(repos) as RepoBuilder[];
  for (let n = 1; n < 100; n++) {
    const root = path.join(EXAMPLES_DIR, n === 1 ? `orchard-${id}` : `orchard-${id}-${n}`);
    if (!fs.existsSync(root)) {
      // fails if the directory exists: never builds over anything
      await Promise.all(all.map((r) => r.buildAsync(path.join(root, r.name), CHECKOUT)));
      const manifest: RepoManifest = { id, repos: Object.fromEntries(all.map((r) => [r.name, Object.fromEntries(r.commits.map((c) => [c.key, c.sha!]))])) };
      atomicWrite(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { createOnly: true });
      return root;
    }
    let manifest: RepoManifest | null = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    } catch {
      continue; // incomplete: try the next name
    }
    if (manifest?.id !== id || all.some((r) => !fs.existsSync(path.join(root, r.name, '.git')))) continue;
    for (const r of all) for (const c of r.commits) c.sha = manifest.repos[r.name]?.[c.key];
    if (all.every((r) => r.commits.every((c) => c.sha))) return root;
  }
  throw new ExamplesConflictError(`no usable folder for the example repos in ${EXAMPLES_DIR}`);
}

/** The add in progress, if any: a second add joins it, a remove is refused until it's done. */
let adding: Promise<ExamplesResult> | null = null;

/**
 * Add the example projects: create the ones that aren't there, restore removed ones, leave existing ones alone.
 * Refuses (ExamplesConflictError, nothing written) if a project of the same name exists that isn't an example.
 */
export function addExamples(): Promise<ExamplesResult> {
  adding ??= add().finally(() => {
    adding = null;
  });
  return adding;
}

async function add(): Promise<ExamplesResult> {
  const res: ExamplesResult = { created: [], restored: [], existing: [], removed: [] };
  for (const slug of EXAMPLE_SLUGS) {
    const file = yamlOf(slug);
    if (fs.existsSync(file) && !isExampleYaml(file))
      throw new ExamplesConflictError(`there's already a project named '${slug}' (${file}) that isn't an example; not touching it. Rename it to add the examples.`);
  }
  const repos = world();
  const root = await ensureRepos(repos);
  const repoDir = (name: string) => path.join(root, name);
  const files = buildDataHome(repos, repoDir, { patchIds: await patchIds(repos, repoDir), repoPath: (name) => displayPath(path.join(root, name)), slug: (p) => EXAMPLE_PREFIX + p });
  for (const slug of EXAMPLE_SLUGS) {
    const file = yamlOf(slug);
    if (fs.existsSync(file)) {
      res.existing.push(slug);
      continue;
    }
    const removed = removedCopies(slug).pop();
    if (removed) {
      renameNoClobber(removed, file);
      res.restored.push(slug);
      continue;
    }
    // project.yaml last: the project shows up only once all its files are there
    const mine = files.filter((f) => f.path.startsWith(`projects/${slug}/`)).sort((a, b) => Number(a.path.endsWith('/project.yaml')) - Number(b.path.endsWith('/project.yaml')));
    for (const f of mine) {
      const p = path.join(PROJECTS_DIR, f.path.slice('projects/'.length));
      const content = f.path.endsWith("/project.yaml") ? EXAMPLE_HEADER + f.content : f.content;
      try {
        atomicWrite(p, content, { createOnly: true });
      } catch (e) {
        if (!(e instanceof ExistsError)) throw e;
        continue; // left from an earlier attempt, or edited since: keep it
      }
      const t = new Date(f.mtime);
      fs.utimesSync(p, t, t); // the demo's file times: your own projects stay the most recent
    }
    res.created.push(slug);
  }
  return res;
}

/** Remove the example projects from the list, deleting nothing: each project.yaml is renamed to a `.bak`. */
export async function removeExamples(): Promise<ExamplesResult> {
  if (adding) throw new ExamplesConflictError('the example projects are still being added; try again in a moment');
  const res: ExamplesResult = { created: [], restored: [], existing: [], removed: [] };
  for (const slug of EXAMPLE_SLUGS) {
    const file = yamlOf(slug);
    if (!fs.existsSync(file) || !isExampleYaml(file)) continue; // never a project the user made
    renameToBak(file, REMOVED_TAG);
    res.removed.push(slug);
  }
  return res;
}
