// The disk cache (server/diskcache.ts): after a restart, what git said about commits comes from disk, the results are
// the same as asking git, and a damaged cache file is just rebuilt. Each "run" is a fresh process (empty in-memory
// caches) whose git is a wrapper that logs each call, so we can count what it asked.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repo, tmpDir } from './fixture.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = tmpDir('lr-test-diskcache-');
const home = path.join(dir, 'home');
const log = path.join(dir, 'git.log');
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
fs.mkdirSync(path.join(dir, 'bin'));
fs.mkdirSync(home); // the cache makes cache/ in an existing data home, never the home itself
fs.writeFileSync(
  path.join(dir, 'bin', 'git'),
  `#!/bin/sh\nsub=""; skip=""\nfor a in "$@"; do\n  if [ -n "$skip" ]; then skip=""; continue; fi\n  case "$a" in -C|-c) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac\ndone\necho "$sub" >> '${log}'\nexec '${realGit}' "$@"\n`,
  { mode: 0o755 },
);
const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(dir, { recursive: true, force: true });
});

// one "server run": load the range, every commit's detail (file contents use the cached blob ids) and patch-ids
const script = path.join(dir, 'run.mts');
fs.writeFileSync(
  script,
  `const S = await import(${JSON.stringify(path.join(ROOT, 'server/commits.ts'))});
const D = await import(${JSON.stringify(path.join(ROOT, 'server/diskcache.ts'))});
const cfg = JSON.parse(process.argv[2]);
const info = await S.loadRepo(cfg);
const details = [];
for (const c of info.commits) {
  const d = await S.commitDetail(cfg.path, c.sha);
  details.push({ sha: d.sha, subject: d.subject, files: d.files.map((f) => [f.path, f.status, f.additions, f.deletions, f.oldContent, f.newContent]) });
}
const ids = await Promise.all(info.commits.map((c) => S.patchId(cfg.path, c.sha)));
const anc = [
  await S.isAncestor(cfg.path, info.commits[0].sha, info.head), // yes
  await S.isAncestor(cfg.path, info.head, info.commits[0].sha), // a definite no (git exits 1)
  await S.isAncestor(cfg.path, '1'.repeat(40), info.head), // unknown object (exits 128): may be fetched later
];
D.flushAll();
console.log(JSON.stringify({ commits: info.commits, details, ids, anc }));
`,
);

function run(cfg: object, lrHome = home): { out: any; git: string[] } {
  fs.writeFileSync(log, '');
  const env: NodeJS.ProcessEnv = { ...process.env, LOCAL_REVIEW_HOME: lrHome, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}` };
  delete env.LOCAL_REVIEW_PROJECTS_DIR;
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', script, JSON.stringify(cfg)], { cwd: ROOT, env, encoding: 'utf8' });
  return { out: JSON.parse(stdout.trim().split('\n').at(-1)!), git: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test("no data home: nothing is written (a deleted home isn't brought back)", () => {
  const repo = Repo.create();
  repos.push(repo);
  repo.commit('Initial', { 'README.md': 'x\n' });
  repo.git('checkout', '-q', '-b', 'feature');
  repo.commit('One', { 'a.txt': 'a\n' });
  const gone = path.join(dir, 'no-such-home');
  run({ name: 'r', path: repo.dir, branch: 'feature', base: 'main' }, gone);
  assert.equal(fs.existsSync(gone), false);
});

test('a restart reads commits from disk: same results, only the refs asked of git; a damaged file is rebuilt', () => {
  const repo = Repo.create();
  repos.push(repo);
  repo.commit('Initial', { 'README.md': 'x\n', 'old.txt': 'one\ntwo\nthree\n' });
  repo.git('checkout', '-q', '-b', 'feature');
  repo.commit('Add parser', { 'a.txt': 'a\nb\n' });
  repo.git('mv', 'old.txt', 'new.txt');
  repo.commit('Rename and edit', { 'new.txt': 'one\ntwo\nthree\nfour\n' });
  repo.commit('Docs', { 'README.md': 'x\ny\n' });
  const cfg = { name: 'r', path: repo.dir, branch: 'feature', base: 'main' };

  const first = run(cfg);
  assert.ok(first.git.length > 10, `the first run asks git about every commit (${first.git.length} calls)`);
  const files = fs.readdirSync(path.join(home, 'cache'));
  assert.equal(files.length, 1, 'one cache file for the repo');

  const entries = JSON.parse(fs.readFileSync(path.join(home, 'cache', files[0]), 'utf8')).entries;
  const ancestry = Object.entries(entries).filter(([k]) => k.startsWith('ancestor\0'));
  assert.deepEqual(ancestry.map(([, v]) => v).sort(), [false, true], 'yes and a definite no are kept; an unknown object is not');
  assert.ok(!ancestry.some(([k]) => k.includes('1'.repeat(40))));

  const second = run(cfg);
  assert.deepEqual(second.out, first.out, 'the same results as asking git');
  // left: resolving the refs (cat-file), and the commit messages / blobs a detail view reads, which aren't cached
  const summaryCalls = second.git.filter((s) => s === 'diff' || s === 'merge-base' || s === 'rev-list' || s === 'patch-id');
  // the one merge-base: the unknown object's ancestry, which isn't kept (it could be fetched later)
  assert.deepEqual(summaryCalls, ['merge-base'], `no per-commit diff, merge-base, rev-list or patch-id after a restart (git: ${second.git.join(' ')})`);
  assert.ok(second.git.length < first.git.length / 2, `${second.git.length} calls vs ${first.git.length}`);

  fs.writeFileSync(path.join(home, 'cache', files[0]), '{ not json');
  const third = run(cfg);
  assert.deepEqual(third.out, first.out, 'a damaged cache file: asked git again, same results');
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, 'cache', files[0]), 'utf8')).entries, 'and rewritten');

  // a new commit: only it is asked about
  repo.commit('More docs', { 'README.md': 'x\ny\nz\n' });
  const fourth = run(cfg);
  assert.equal(fourth.out.commits.length, 4);
  assert.equal(fourth.git.filter((s) => s === 'diff').length, 3, "only the new commit's diffs: its file list and numstat, and its patch-id's");
});
