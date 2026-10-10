// The demo test bed: four fake but convincing repos for "Orchard", a booking app for fitness studios, plus a Local
// Review data home with three projects reviewing them. Deterministic: the same shas and files on every run and
// machine (demo/shas.json is the lock; `npm run demo:check` compares against it).
//
//   npm run demo:seed [-- <outdir>] [--force]     default outdir: demo/out (git-ignored)
//   npm run demo:check [-- --update]              seed into a temp dir and compare with demo/shas.json
//
// Layout of <outdir>:
//   home/                     a throwaway $HOME for the server (so `~/code/...` in project.yaml resolves here)
//     code/orchard-{api,sdk,web,infra}/
//     .local-review/          $LOCAL_REVIEW_HOME: projects/<slug>/{project.yaml, prs/, reviews/}
//   manifest.json             every commit's sha, by repo and key, plus how to run the server on it
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi } from './world/api.ts';
import { buildInfra } from './world/infra.ts';
import { buildSdk } from './world/sdk.ts';
import { buildWeb } from './world/web.ts';
import { buildDataHome } from './world/review.ts';
import { DEMO_NOW, REVIEWER } from './world/people.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = path.join(HERE, 'out');
export const LOCK = path.join(HERE, 'shas.json');
const MARKER = 'manifest.json';

export interface Manifest {
  generator: 'local-review demo';
  now: string; // freeze the browser clock here
  reviewer: string; // LOCAL_REVIEW_USER
  home: string; // HOME for the server
  localReviewHome: string; // LOCAL_REVIEW_HOME
  /** what must stay identical across runs and machines: commit shas, and a hash of every data home file */
  lock: { repos: Record<string, Record<string, string>>; data: Record<string, string> };
}

export function seed(out: string, opts: { force?: boolean } = {}): Manifest {
  out = path.resolve(out);
  if (fs.existsSync(out) && fs.readdirSync(out).length) {
    // only ever clear a directory this script made
    if (!opts.force) throw new Error(`${out} is not empty (pass --force to replace an earlier seed)`);
    if (!fs.existsSync(path.join(out, MARKER))) throw new Error(`${out} has no ${MARKER}: not a demo seed, refusing to delete it`);
    fs.rmSync(out, { recursive: true, force: true });
  }
  const home = path.join(out, 'home');
  const lrHome = path.join(home, '.local-review');
  const repoDir = (name: string) => path.join(home, 'code', name);

  const repos = { api: buildApi(), sdk: buildSdk(), web: buildWeb(), infra: buildInfra() };
  for (const r of Object.values(repos)) r.build(repoDir(r.name), 'maya/waitlists');

  const lock: Manifest['lock'] = { repos: {}, data: {} };
  for (const r of Object.values(repos)) {
    lock.repos[r.name] = {};
    for (const c of r.commits) lock.repos[r.name][c.key] = c.sha!;
  }
  for (const f of buildDataHome(repos, repoDir)) {
    const p = path.join(lrHome, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    // file times matter: "/" opens the most recently modified project
    const t = new Date(f.mtime);
    fs.utimesSync(p, t, t);
    lock.data[f.path] = crypto.createHash('sha256').update(f.content).digest('hex').slice(0, 16);
  }
  const manifest: Manifest = { generator: 'local-review demo', now: DEMO_NOW, reviewer: REVIEWER, home, localReviewHome: lrHome, lock };
  fs.writeFileSync(path.join(out, MARKER), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Seed into a temp dir and compare with the lock. Returns the differences (empty: identical). */
export function check(update = false): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-demo-check-'));
  try {
    const { lock } = seed(tmp);
    if (update) {
      fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
      return [];
    }
    const want: Manifest['lock'] = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    const diffs: string[] = [];
    const cmp = (label: string, a: Record<string, string>, b: Record<string, string>) => {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) diffs.push(`${label} ${k}: ${b[k] ?? '(none)'} → ${a[k] ?? '(none)'}`);
    };
    for (const repo of new Set([...Object.keys(lock.repos), ...Object.keys(want.repos)])) cmp(repo, lock.repos[repo] ?? {}, want.repos[repo] ?? {});
    cmp('data', lock.data, want.data);
    return diffs;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === 'check') {
    const update = args.includes('--update');
    const diffs = check(update);
    if (update) console.log(`wrote ${path.relative(process.cwd(), LOCK)}`);
    else if (diffs.length) {
      console.error(`The demo seed differs from demo/shas.json (${diffs.length}):\n  ${diffs.slice(0, 40).join('\n  ')}`);
      console.error('If you changed the demo content on purpose, run `npm run demo:check -- --update` and commit demo/shas.json.');
      process.exit(1);
    } else console.log('demo seed matches demo/shas.json');
  } else {
    const force = args.includes('--force');
    const out = args.find((a) => !a.startsWith('--')) ?? DEFAULT_OUT;
    const m = seed(out, { force });
    console.log(`Seeded the demo into ${out}
  repos: ${Object.keys(m.lock.repos).join(', ')} (${Object.values(m.lock.repos).reduce((n, r) => n + Object.keys(r).length, 0)} commits)
  projects: ${[...new Set(Object.keys(m.lock.data).map((f) => f.split('/')[1]))].join(', ')}

Run Local Review on it:
  HOME=${m.home} LOCAL_REVIEW_HOME=${m.localReviewHome} LOCAL_REVIEW_USER=${m.reviewer} npm start -- --port 5050`);
  }
}
