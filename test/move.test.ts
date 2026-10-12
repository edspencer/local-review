// `local-review move` (server/move.ts): PRs' prs / reviews files copied into another project, create-only, and the
// originals renamed to .bak (never deleted); images copied; nothing written on a dry run or when anything would be
// replaced; then the CLI, with a snapshot first. Throwaway repos and data directories in the OS temp dir only.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Repo, tmpDir } from './fixture.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = tmpDir('lr-test-move-');
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const M = await import('../server/move.ts');

const repos: Repo[] = [];
const dirs: string[] = [PROJECTS];
after(() => {
  for (const r of repos) r.rm();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const yaml = (o: unknown) => YAML.stringify(o, { lineWidth: 0 });
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

/** Every file under a directory, with its contents: what a move may add to, but never lose from. */
function files(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p), fs.readFileSync(p, 'latin1'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
const contents = (m: Map<string, string>) => [...m.values()].sort();

/** A repo with A, B (stack 1) and C (stack 2) on me/feature; project `whole` reviews all three, `part-2` nothing yet. */
function setup(prefix: string, projects = PROJECTS) {
  const r = Repo.create();
  repos.push(r);
  r.commit('Initial', { 'x.txt': 'x\n' });
  r.git('checkout', '-q', '-b', 'me/feature');
  const A = r.commit('Add A', { 'a.txt': 'a\n' });
  const B = r.commit('Add B', { 'b.txt': 'b\n' });
  const C = r.commit('Add C', { 'c.txt': 'c\n' });
  const whole = path.join(projects, `${prefix}-whole`);
  const part2 = path.join(projects, `${prefix}-part-2`);
  fs.mkdirSync(path.join(whole, 'prs', 'svc'), { recursive: true });
  fs.mkdirSync(path.join(whole, 'reviews', 'svc'), { recursive: true });
  fs.mkdirSync(path.join(whole, 'assets'), { recursive: true });
  fs.mkdirSync(part2, { recursive: true });
  fs.writeFileSync(path.join(whole, 'project.yaml'), yaml({ title: 'Whole', repos: [{ name: 'svc', path: r.dir, branch: 'me/feature', base: 'main', stacks: [{ title: 'One', starts_at: 'Add A' }, { title: 'Two', starts_at: 'Add C' }] }] }));
  fs.writeFileSync(path.join(part2, 'project.yaml'), yaml({ title: 'Part 2', after: `${prefix}-whole`, repos: [{ name: 'svc', path: r.dir, branch: 'me/feature', base: 'main' }] }));
  fs.writeFileSync(path.join(whole, 'assets', '0123456789abcdef.png'), PNG);
  fs.writeFileSync(path.join(whole, 'assets', '0123456789abcdef.png.yaml'), 'url: https://example.com/c.png\n');
  fs.writeFileSync(path.join(whole, 'prs', 'svc', `${B}.yaml`), yaml({ title: 'B, edited', status: 'ready' }));
  fs.writeFileSync(path.join(whole, 'prs', 'svc', `${C}.yaml`), yaml({ title: 'C', body: 'See ![diagram](assets/0123456789abcdef.png)\n' }));
  fs.writeFileSync(path.join(whole, 'reviews', 'svc', `${C}.yaml`), yaml({ threads: [{ id: 't-1', resolved: false, comments: [{ id: 'c-1', author: 'ed', created: '2026-10-01T10:00:00Z', body: 'Why?' }] }], viewed: ['c.txt'] }));
  return { r, A, B, C, whole, part2, from: `${prefix}-whole`, to: `${prefix}-part-2` };
}

describe('move', () => {
  test('copies each prs and reviews file create-only, renames the original to .bak, copies the images it shows', async () => {
    const s = setup('m1');
    const before = files(s.whole);
    const res = await M.movePrs({ from: s.from, to: s.to, repo: 'svc', shas: [s.C.slice(0, 8)] });
    assert.deepEqual(res.steps.map((x) => [x.sha, x.kind]), [[s.C, 'prs'], [s.C, 'reviews']]);
    for (const kind of ['prs', 'reviews']) {
      const was = before.get(`${kind}/svc/${s.C}.yaml`);
      assert.equal(fs.readFileSync(path.join(s.part2, kind, 'svc', `${s.C}.yaml`), 'utf8'), was, `${kind}: the same bytes`);
      assert.ok(!fs.existsSync(path.join(s.whole, kind, 'svc', `${s.C}.yaml`)));
      assert.equal(fs.readFileSync(path.join(s.whole, kind, 'svc', `${s.C}.moved-to-${s.to}.yaml.bak`), 'utf8'), was, `${kind}: the original kept as .bak`);
    }
    assert.deepEqual(fs.readFileSync(path.join(s.part2, 'assets', '0123456789abcdef.png')), PNG);
    assert.equal(fs.readFileSync(path.join(s.part2, 'assets', '0123456789abcdef.png.yaml'), 'utf8'), 'url: https://example.com/c.png\n');
    assert.ok(fs.existsSync(path.join(s.whole, 'assets', '0123456789abcdef.png')), 'the original image stays');
    // nothing lost: every file there was is still somewhere, with the same contents
    const now = new Map([...files(s.whole), ...[...files(s.part2)].map(([k, v]) => [`part2/${k}`, v] as [string, string])]);
    for (const c of contents(before)) assert.ok(contents(now).includes(c));
    assert.match(M.moveReport(res, { from: s.from, to: s.to, repo: 'svc' }), /Then: check both project\.yaml files/);
  });

  test('a dry run writes nothing; --stack picks a stack’s commits; commits with nothing recorded are reported', async () => {
    const s = setup('m2');
    const before = [files(s.whole), files(s.part2)];
    const dry = await M.movePrs({ from: s.from, to: s.to, repo: 'svc', stack: 1, dryRun: true });
    assert.deepEqual([files(s.whole), files(s.part2)], before);
    assert.deepEqual(dry.steps.map((x) => x.sha), [s.B]);
    assert.deepEqual(dry.missing, [s.A]);
    assert.match(M.moveReport(dry, { from: s.from, to: s.to, repo: 'svc' }), /^Dry run: nothing written/);
    const real = await M.movePrs({ from: s.from, to: s.to, repo: 'svc', stack: 1 });
    assert.equal(real.steps.length, 1);
    assert.ok(fs.existsSync(path.join(s.part2, 'prs', 'svc', `${s.B}.yaml`)));
  });

  test('never replaces a file in the other project: the whole move is refused, nothing written', async () => {
    const s = setup('m3');
    fs.mkdirSync(path.join(s.part2, 'reviews', 'svc'), { recursive: true });
    fs.writeFileSync(path.join(s.part2, 'reviews', 'svc', `${s.C}.yaml`), 'threads: []\n');
    const before = [files(s.whole), files(s.part2)];
    await assert.rejects(M.movePrs({ from: s.from, to: s.to, repo: 'svc', shas: [s.B, s.C] }), /already exists; not replacing it \(nothing was moved\)/);
    assert.deepEqual([files(s.whole), files(s.part2)], before);
  });

  test('a file that is only on disk (the commit is no longer in the range) can be moved by its sha', async () => {
    const s = setup('m4');
    const gone = 'f'.repeat(40);
    fs.writeFileSync(path.join(s.whole, 'prs', 'svc', `${gone}.yaml`), 'title: Old\n');
    const res = await M.movePrs({ from: s.from, to: s.to, repo: 'svc', shas: ['fffffff'] });
    assert.deepEqual(res.steps.map((x) => x.sha), [gone]);
  });

  test('after a rebase, the data still in the old sha\'s files moves too (by --stack or by the new sha), under its own name', async () => {
    for (const how of ['stack', 'sha'] as const) {
      const s = setup(`m7${how}`);
      // a rebase onto a newer main: every sha changes, the patches don't, and nothing has been written since
      s.r.git('checkout', '-q', 'main');
      s.r.commit('Newer main', { 'y.txt': 'y\n' });
      s.r.git('checkout', '-q', 'me/feature');
      s.r.git('rebase', '-q', 'main');
      const newC = s.r.git('rev-parse', 'HEAD').trim();
      assert.notEqual(newC, s.C);
      const before = files(s.whole);
      const res = await M.movePrs({ from: s.from, to: s.to, repo: 'svc', ...(how === 'stack' ? { stack: 2 } : { shas: [newC.slice(0, 8)] }) });
      assert.deepEqual(res.missing, [], how);
      assert.deepEqual(res.steps.map((x) => [x.sha, x.kind, x.matchedFrom]), [[newC, 'prs', s.C], [newC, 'reviews', s.C]], how);
      for (const kind of ['prs', 'reviews']) {
        // the old file as it was, under its own name: the other project re-matches it, as this one did
        assert.equal(fs.readFileSync(path.join(s.part2, kind, 'svc', `${s.C}.yaml`), 'utf8'), before.get(`${kind}/svc/${s.C}.yaml`));
        assert.ok(fs.existsSync(path.join(s.whole, kind, 'svc', `${s.C}.moved-to-${s.to}.yaml.bak`)));
      }
      assert.deepEqual(contents(files(s.whole)), contents(before), `${how}: nothing lost from the old project`);
      assert.match(M.moveReport(res, { from: s.from, to: s.to, repo: 'svc' }), new RegExp(`${newC.slice(0, 8)} reviews \\(carried over from ${s.C.slice(0, 8)}\\)`));
    }
  });

  test('refuses: unknown or ambiguous shas, missing projects and repos, the same project, nothing to say what', async () => {
    const s = setup('m5');
    const o = { from: s.from, to: s.to, repo: 'svc' };
    await assert.rejects(M.movePrs({ ...o, shas: ['1234567'] }), /no commit or prs \/ reviews file '1234567'/);
    await assert.rejects(M.movePrs({ ...o, shas: ['xyz'] }), /isn't a commit sha/);
    await assert.rejects(M.movePrs({ ...o, to: 'nope', shas: [s.C] }), /no project 'nope'/);
    await assert.rejects(M.movePrs({ ...o, repo: 'web', shas: [s.C] }), /no repo 'web' in project/);
    await assert.rejects(M.movePrs({ ...o, toRepo: 'web', shas: [s.C] }), /no repo 'web' in project 'm5-part-2'/);
    await assert.rejects(M.movePrs({ ...o, to: s.from, shas: [s.C] }), /the same/);
    await assert.rejects(M.movePrs({ ...o, stack: 9 }), /no stack 9/);
    await assert.rejects(M.movePrs({ ...o }), /say which PRs/);
    await assert.rejects(M.movePrs({ ...o, from: '../x', shas: [s.C] }), /directory names/);
  });

  test('the CLI: a snapshot first, the report, and usage errors', async () => {
    const home = tmpDir('lr-test-move-home-');
    dirs.push(home);
    const projects = path.join(home, '.local-review', 'projects');
    const s = setup('m6', projects);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, LOCAL_REVIEW_HOME: path.join(home, '.local-review') };
    delete env.LOCAL_REVIEW_PROJECTS_DIR;
    const lr = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((res) =>
        execFile(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), ...args], { env, cwd: ROOT, timeout: 60000 }, (err, stdout, stderr) => res({ code: err ? Number((err as any).code ?? 1) : 0, stdout, stderr })),
      );
    const dry = await lr(['move', s.from, s.to, 'svc', s.C.slice(0, 7), '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run: nothing written/);
    assert.ok(!fs.existsSync(path.join(home, '.local-review', 'backups')), 'no snapshot on a dry run');
    const r = await lr(['move', s.from, s.to, 'svc', s.C.slice(0, 7)]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Moved from m6-whole to m6-part-2:\n {2}\(snapshot first: backups\/\d{4}-/);
    const snaps = fs.readdirSync(path.join(home, '.local-review', 'backups'));
    assert.equal(snaps.length, 1);
    // the snapshot has the files as they were before the move
    assert.ok(fs.existsSync(path.join(home, '.local-review', 'backups', snaps[0], 'm6-whole', 'reviews', 'svc', `${s.C}.yaml`)));
    assert.equal((await lr(['move', s.from, s.to])).code, 2);
    assert.equal((await lr(['move', s.from, s.to, 'svc', s.C, '--stack', '1'])).code, 2);
    const again = await lr(['move', s.from, s.to, 'svc', s.C.slice(0, 7)]);
    // its files were moved: the commit is still in the range, with nothing recorded here now, so nothing to do
    assert.equal(again.code, 0);
    assert.match(again.stdout, /\(no prs or reviews files to move\)\nNothing recorded yet for /);
  });
});
