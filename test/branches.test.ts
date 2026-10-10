// Branch tagging (prs/ `branch:` and `github:`, reconciled with git's branches), the read-only plan, the `lr`
// CLI, and the API fields. Everything runs against throwaway repos and data directories in the OS temp dir.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Repo, tmpDir } from './fixture.ts';

const PROJECTS = tmpDir('lr-test-branches-');
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const B = await import('../server/branches.ts');
const PR = await import('../server/prs.ts');
const S = await import('../server/commits.ts');
const P = await import('../server/projects.ts');
const PL = await import('../server/plan.ts');
const { prContextFor } = await import('../server/context.ts');
const { fullPrBody } = await import('../shared/prText.ts');
const RD = await import('../shared/readiness.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(PROJECTS, { recursive: true, force: true });
});

/** main (+ a fake origin/main and origin/HEAD), then feature: A, B, C; plain branches tag-a at A, tag-b at B. */
function stackRepo() {
  const r = Repo.create();
  repos.push(r);
  r.commit('Initial', { 'base.txt': 'base\n' });
  r.git('update-ref', 'refs/remotes/origin/main', 'main');
  r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  r.git('checkout', '-q', '-b', 'feature');
  const a = r.commit('Add A', { 'a.txt': 'a\n' });
  const b = r.commit('Add B', { 'b.txt': 'b\n' });
  const c = r.commit('Add C', { 'c.txt': 'c\n' });
  r.git('branch', 'tag-a', a);
  r.git('branch', 'tag-b', b);
  r.git('update-ref', 'refs/remotes/origin/tag-b', b); // as if pushed
  return { r, a, b, c };
}

/** Fixup A and autosquash onto the stack's own merge-base, with or without --update-refs. */
function fixupA(r: Repo, a: string, updateRefs: boolean) {
  r.write('a.txt', r.read('a.txt') + 'fixed\n');
  r.git('add', '-A');
  r.git('commit', '-q', `--fixup=${a}`);
  const mb = r.git('merge-base', 'main', 'feature');
  r.git('rebase', '-q', '-i', '--autosquash', ...(updateRefs ? ['--update-refs'] : ['--no-update-refs']), mb);
}

async function load(r: Repo, dir: string) {
  const cfg = { name: 'r', path: r.dir, branch: 'feature', base: 'origin/main' };
  const info = await S.loadRepo(cfg);
  assert.equal(info.error, undefined, String(info.error));
  const ctxs = info.commits.map((c) => prContextFor(dir, cfg, info, c));
  const prs = await PR.loadPrs(dir, ctxs[0].liveCommits!, ctxs[0].inspectOrphan);
  const refs = await B.loadRefs(r.dir);
  const branch = (i: number) => B.reconcileBranch(refs, info.commits[i].sha, prs.get(info.commits[i].sha)?.override, 'feature');
  return { info, ctxs, prs, refs, branch };
}

describe('the prs/ file: branch and github', () => {
  test('hand-written github forms are tolerated; junk is ignored', () => {
    assert.deepEqual(PR.githubOf({ number: '42', url: 'https://github.com/o/r/pull/42', branch: 'refs/heads/x', base: 'main', created: '2026-10-09T10:00:00Z' }), {
      number: 42, url: 'https://github.com/o/r/pull/42', branch: 'x', base: 'main', created: '2026-10-09T10:00:00Z',
    });
    assert.deepEqual(PR.githubOf({ url: 'https://github.com/o/r/pull/7/' }), { number: 7, url: 'https://github.com/o/r/pull/7/' });
    assert.deepEqual(PR.githubOf({ number: '#9' }), { number: 9, url: '' });
    assert.deepEqual(PR.githubOf(12), { number: 12, url: '' });
    assert.deepEqual(PR.githubOf('https://github.com/o/r/pull/5#issuecomment-1'), { number: 5, url: 'https://github.com/o/r/pull/5#issuecomment-1' });
    for (const bad of [null, undefined, 'soon', { url: 'https://example.com' }, { number: 0 }, { number: -3 }, [1], { number: '1.5' }]) assert.equal(PR.githubOf(bad), null, JSON.stringify(bad));
    assert.deepEqual(PR.overrideOf({ branch: '  refs/heads/me/x ', github: { number: 3 } }), { branch: 'me/x', github: { number: 3, url: '' } });
    assert.deepEqual(PR.overrideOf({ branch: '   ', github: 'n/a' }), {});
  });

  test('set and clear branch / github; other fields and order kept', async () => {
    const { r } = stackRepo();
    const dir = tmpDir('lr-test-prs-');
    const { ctxs } = await load(r, dir);
    await PR.writePr(ctxs[0], { title: 'T', branch: 'refs/heads/me/a' });
    await PR.writePr(ctxs[0], { github: { number: 11, url: 'https://github.com/o/r/pull/11', branch: 'me/a', base: 'main' } });
    const f = PR.prPath(dir, ctxs[0].sha);
    const raw = fs.readFileSync(f, 'utf8');
    const doc = YAML.parse(raw);
    assert.deepEqual([doc.title, doc.branch, doc.github], ['T', 'me/a', { number: 11, url: 'https://github.com/o/r/pull/11', branch: 'me/a', base: 'main' }]);
    assert.ok(raw.indexOf('title:') < raw.indexOf('branch:') && raw.indexOf('branch:') < raw.indexOf('github:') && raw.indexOf('github:') < raw.indexOf('updated:'));
    await PR.writePr(ctxs[0], { branch: null, github: null });
    const after = YAML.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual([after.title, 'branch' in after, 'github' in after], ['T', false, false]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('readiness: status (draft / ready / published) and progress', () => {
  test('status is read tolerantly; published is derived from github, whatever status says', () => {
    for (const v of ['ready', 'Ready', ' READY ']) assert.equal(RD.storedStatus(v), 'ready', v);
    for (const v of ['draft', 'DRAFT']) assert.equal(RD.storedStatus(v), 'draft', v);
    for (const v of [undefined, null, '', 'done', true, 1, ['ready']]) assert.equal(RD.storedStatus(v), undefined, JSON.stringify(v));
    assert.deepEqual(PR.overrideOf({ status: 'Ready' }), { status: 'ready' });
    assert.deepEqual(PR.overrideOf({ status: 'sure' }), {});
    assert.equal(RD.prStatus(undefined), 'draft');
    assert.equal(RD.prStatus(PR.overrideOf({})), 'draft');
    assert.equal(RD.prStatus(PR.overrideOf({ status: 'ready' })), 'ready');
    assert.equal(RD.prStatus(PR.overrideOf({ status: 'draft', github: 12 })), 'published');
    assert.equal(RD.prStatus(PR.overrideOf({ github: 'n/a' })), 'draft'); // an unusable github record doesn't count
  });

  test('progress: resolved threads + viewed files over all threads + files; empty threads ignored', () => {
    const threads = [
      { resolved: true, comments: [1] },
      { resolved: true, outdated: true, comments: [1, 2] }, // outdated still counts
      { resolved: false, comments: [1] },
      { resolved: true, comments: [] }, // no comments: ignored
    ];
    const p = RD.progressOf(threads, ['a', 'b', 'c'], ['a', 'gone-after-rebase']);
    assert.deepEqual(p, { threads: 3, resolved: 2, files: 3, viewed: 1 });
    assert.equal(RD.progressFraction(p), 0.5);
    assert.equal(RD.progressText(p), '3 of 6 done: 2/3 conversations resolved, 1/3 files viewed');
    // PR 2: 9 files, none viewed, 6 threads all resolved: 6/15 = 40%
    const p2 = RD.progressOf(Array.from({ length: 6 }, () => ({ resolved: true, comments: [1] })), Array.from({ length: 9 }, (_, i) => `f${i}`), []);
    assert.equal(RD.progressFraction(p2), 0.4);
    assert.equal(RD.statusTooltip('draft', p2), 'Draft · 6 of 15 done: 6/6 conversations resolved, 0/9 files viewed');
    assert.equal(RD.statusTooltip('published', p2, { number: 7 }).split(' · ')[0], 'Published as #7');
    assert.equal(RD.progressFraction(RD.progressOf([], [], [])), 1);
  });

  test('writePr: ready sets status, draft / null remove it; other fields kept', async () => {
    const { r } = stackRepo();
    const dir = tmpDir('lr-test-prs-');
    const { ctxs } = await load(r, dir);
    const f = PR.prPath(dir, ctxs[0].sha);
    await PR.writePr(ctxs[0], { title: 'T', branch: 'me/a' });
    let l = await PR.writePr(ctxs[0], { status: 'ready' });
    assert.equal(l.override.status, 'ready');
    const raw = fs.readFileSync(f, 'utf8');
    assert.match(raw, /^status: ready$/m);
    assert.ok(raw.indexOf('title:') < raw.indexOf('status:') && raw.indexOf('status:') < raw.indexOf('branch:'));
    l = await PR.writePr(ctxs[0], { status: 'draft' });
    assert.equal('status' in YAML.parse(fs.readFileSync(f, 'utf8')), false);
    assert.deepEqual([l.override.title, l.override.branch, l.override.status], ['T', 'me/a', undefined]);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + 'status: READY\n'); // hand-written
    assert.equal((await PR.loadPr(ctxs[0])).override.status, 'ready');
    await PR.writePr(ctxs[0], { status: null });
    assert.equal('status' in YAML.parse(fs.readFileSync(f, 'utf8')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('branch reconciliation', () => {
  test('ok / missing / discovered, the tip branch last, remotes after locals', async () => {
    const { r, a, b, c } = stackRepo();
    const dir = tmpDir('lr-test-prs-');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PR.prPath(dir, a), 'branch: tag-a\n'); // hand-written, recorded
    fs.writeFileSync(PR.prPath(dir, c), 'branch: gone\n'); // recorded, never created
    const { branch, refs } = await load(r, dir);
    assert.deepEqual(branch(0), { name: 'tag-a', status: 'ok', discovered: ['tag-a'] });
    assert.deepEqual(branch(1), { name: 'tag-b', status: 'discovered', discovered: ['tag-b', 'origin/tag-b'] });
    assert.deepEqual(branch(2), { name: 'gone', status: 'missing', discovered: ['feature'] }); // recorded wins over the tip
    fs.writeFileSync(PR.prPath(dir, c), 'title: no branch recorded\n');
    assert.deepEqual((await load(r, dir)).branch(2), { name: 'feature', status: 'discovered', discovered: ['feature'] });
    // github.branch beats branch:
    fs.writeFileSync(PR.prPath(dir, b), 'branch: tag-a\ngithub: {number: "4", branch: tag-b}\n');
    assert.deepEqual((await load(r, dir)).branch(1)?.status, 'ok');
    // a recorded name only on the remote
    fs.writeFileSync(PR.prPath(dir, b), 'branch: origin/tag-b\n');
    assert.deepEqual((await load(r, dir)).branch(1)?.status, 'ok');
    assert.equal(B.stripRemote(refs, 'origin/main'), 'main');
    assert.equal(B.stripRemote(refs, 'origin/HEAD'), 'main');
    assert.equal(B.stripRemote(refs, 'main'), 'main');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a rebase without --update-refs leaves the branch behind (moved); with it, the branch follows (ok)', async () => {
    const { r, a, b } = stackRepo();
    const dir = tmpDir('lr-test-prs-');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PR.prPath(dir, a), 'branch: tag-a\n');
    fs.writeFileSync(PR.prPath(dir, b), 'branch: tag-b\n');

    fixupA(r, a, false);
    let l = await load(r, dir);
    assert.notEqual(l.info.commits[0].sha, a);
    // the prs files followed the rebase (A by subject, B by patch-id), the branches didn't
    assert.deepEqual([l.prs.get(l.info.commits[0].sha)?.matchedBy, l.prs.get(l.info.commits[1].sha)?.matchedBy], ['subject', 'patch-id']);
    assert.deepEqual(l.branch(0), { name: 'tag-a', status: 'moved', points_at: a, discovered: [] });
    assert.deepEqual(l.branch(1), { name: 'tag-b', status: 'moved', points_at: b, discovered: [] });

    // fix the branches by hand, then a second fixup with --update-refs keeps them on their commits
    r.git('branch', '-f', 'tag-a', l.info.commits[0].sha);
    r.git('branch', '-f', 'tag-b', l.info.commits[1].sha);
    fixupA(r, l.info.commits[0].sha, true);
    l = await load(r, dir);
    assert.deepEqual([l.branch(0)?.status, l.branch(1)?.status], ['ok', 'ok']);
    assert.equal(r.git('rev-parse', 'tag-a'), l.info.commits[0].sha);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- plan + CLI + API
describe('plan, CLI and API', () => {
  let fx: ReturnType<typeof stackRepo>;
  const slug = 'plan-demo';
  const pdir = path.join(PROJECTS, slug);
  let server: ChildProcess;
  let port = 0;

  before(async () => {
    fx = stackRepo();
    const prs = path.join(pdir, 'prs', 'r');
    fs.mkdirSync(prs, { recursive: true });
    fs.writeFileSync(
      path.join(pdir, 'project.yaml'),
      YAML.stringify({
        title: 'Plan demo',
        description: 'Project intro.\n',
        repos: [{ name: 'r', path: fx.r.dir, branch: 'feature', base: 'origin/main', stacks: [{ title: 'First', starts_at: 'Add A', description: 'Stack note.' }, { title: 'Second', starts_at: 'Add B' }, { title: 'Ghost', starts_at: 'No such commit' }] }],
      }),
    );
    fs.writeFileSync(path.join(prs, `${fx.a}.yaml`), 'branch: tag-a\ntitle: Better A\nbody: |\n  Why A.\n');
    fs.writeFileSync(path.join(prs, `${fx.b}.yaml`), 'github:\n  number: "12"\n  url: https://github.com/o/r/pull/12\n  branch: tag-b\n  base: tag-a\n');
    fs.writeFileSync(path.join(prs, `${fx.c}.yaml`), 'branch: gone\n');
  });
  after(() => server?.kill());

  test('buildPlan: order, branches, bases, full bodies, github, warnings', async () => {
    const plan = await PL.buildPlan((await P.loadProject(slug))!);
    assert.deepEqual(plan.prs.map((p) => [p.number, p.stack.number, p.branch?.name ?? null, p.branch?.status ?? null, p.base]), [
      [1, 1, 'tag-a', 'ok', 'main'], // origin/main, remote prefix stripped
      [2, 2, 'tag-b', 'ok', 'tag-a'],
      [3, 2, 'gone', 'missing', 'tag-b'],
    ]);
    assert.equal(plan.prs[0].title, 'Better A');
    assert.equal(plan.prs[0].body, fullPrBody({ intro: 'Project intro.\n', stackNote: 'Stack note.', body: 'Why A.' }));
    assert.equal(plan.prs[0].body, 'Project intro.\n\nStack note.\n\n---\n\nWhy A.');
    assert.equal(plan.prs[1].body, 'Project intro.'); // no note, empty commit body: just the intro
    assert.deepEqual(plan.prs[1].github, { number: 12, url: 'https://github.com/o/r/pull/12', branch: 'tag-b', base: 'tag-a' });
    assert.ok(plan.warnings.some((w) => /Ghost.*doesn't match/.test(w)), 'unresolved selector');
    assert.ok(plan.warnings.some((w) => /PR #3.*'gone' is recorded but doesn't exist/.test(w)), 'missing branch');
    // status: B is published (github), A and C are drafts
    assert.deepEqual(plan.prs.map((p) => p.status), ['draft', 'published', 'draft']);
    assert.ok(plan.warnings.includes('r stack 1 "First": 1 of 1 PR is still draft (PR #1); only the reviewer marks PRs ready'), plan.warnings.join('\n'));
    assert.ok(plan.warnings.includes('r stack 2 "Second": 1 of 2 PRs are still draft (PR #3); only the reviewer marks PRs ready'), plan.warnings.join('\n'));

    const s2 = await PL.buildPlan((await P.loadProject(slug))!, { stack: 2 });
    assert.deepEqual(s2.prs.map((p) => [p.number, p.base]), [[2, 'tag-a'], [3, 'tag-b']]); // the base still comes from the previous stack
    await assert.rejects(PL.buildPlan((await P.loadProject(slug))!, { stack: 9 }), /no stack 9/);
    await assert.rejects(PL.buildPlan((await P.loadProject(slug))!, { repo: 'nope' }), /no repo 'nope'/);
  });

  const lr = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
      execFile(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), ...args], { env: { ...process.env, LOCAL_REVIEW_PROJECTS_DIR: PROJECTS }, cwd: ROOT }, (err, stdout, stderr) =>
        res({ code: err ? Number((err as any).code ?? 1) : 0, stdout, stderr }),
      );
    });

  const listing = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listing(path.join(d, e.name)).map((x) => `${e.name}/${x}`) : [`${e.name}:${fs.statSync(path.join(d, e.name)).mtimeMs}`]));

  test('lr plan: md, json and yaml; usage errors; writes nothing', async () => {
    const before = listing(pdir);
    const refsBefore = fx.r.git('for-each-ref');
    const md = await lr('plan', slug);
    assert.equal(md.code, 0, md.stderr);
    assert.match(md.stdout, /^# Plan: Plan demo \(plan-demo\)/);
    assert.match(md.stdout, /### PR #1 \(1 of 1\): Better A/);
    assert.match(md.stdout, /- Branch: `tag-a` \(ok\)/);
    assert.match(md.stdout, /- Base: `main` \(repo base\)/);
    assert.match(md.stdout, /- Status: draft/);
    assert.match(md.stdout, /- Status: published/);
    assert.match(md.stdout, /still draft \(PR #1\)/);
    assert.match(md.stdout, /- GitHub: #12 https:\/\/github.com\/o\/r\/pull\/12/);
    assert.match(md.stdout, /## Warnings/);
    const json = JSON.parse((await lr('plan', slug, '--repo', 'r', '--stack', '2', '--format', 'json')).stdout);
    assert.deepEqual(json.prs.map((p: any) => p.number), [2, 3]);
    const yaml = YAML.parse((await lr('plan', slug, '--format=yaml')).stdout);
    assert.equal(yaml.prs[0].body, 'Project intro.\n\nStack note.\n\n---\n\nWhy A.');
    const bad = await lr('plan', slug, '--format', 'xml');
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--format must be/);
    assert.equal((await lr('plan', 'nope')).code, 1);
    assert.deepEqual(listing(pdir), before, 'nothing in the project directory changed');
    assert.equal(fx.r.git('for-each-ref'), refsBefore, 'no refs changed');
  });

  test('follow-on stacks: left out of the plan by default, with a note; --include-follow-on and --stack N plan them', async () => {
    const fslug = 'plan-follow-on';
    const fdir = path.join(PROJECTS, fslug);
    fs.mkdirSync(path.join(fdir, 'prs', 'r'), { recursive: true });
    fs.writeFileSync(
      path.join(fdir, 'project.yaml'),
      YAML.stringify({ title: 'Follow-on demo', repos: [{ name: 'r', path: fx.r.dir, branch: 'feature', base: 'origin/main', stacks: [{ title: 'Now', starts_at: 'Add A' }, { title: 'Later', starts_at: 'Add C', follow_on: 'yes' }] }] }),
    );
    // C (the follow-on) has a missing branch: a warning only when it's planned
    fs.writeFileSync(path.join(fdir, 'prs', 'r', `${fx.c}.yaml`), 'branch: gone\n');
    const load = async () => (await P.loadProject(fslug))!;

    const def = await PL.buildPlan(await load());
    assert.deepEqual(def.prs.map((p) => p.number), [1, 2]);
    assert.equal(def.scope.include_follow_on, false);
    assert.deepEqual(def.excluded_follow_on, [{ repo: 'r', stack: 2, title: 'Later', prs: [3] }]);
    assert.deepEqual(def.notes, ['Excluded 1 follow-on stack (1 PR: r stack 2 "Later"); use --include-follow-on']);
    assert.ok(!def.warnings.some((w) => /Later|gone|PR #3/.test(w)), def.warnings.join('\n'));

    const inc = await PL.buildPlan(await load(), { includeFollowOn: true });
    assert.deepEqual(inc.prs.map((p) => [p.number, p.base, p.stack.follow_on]), [[1, 'main', false], [2, 'tag-a', false], [3, 'tag-b', true]]); // based on the previous PR's branch
    assert.deepEqual([inc.excluded_follow_on, inc.notes, inc.scope.include_follow_on], [[], [], true]);
    assert.ok(inc.warnings.some((w) => /stack 2 "Later" \(follow-on\) PR #3.*'gone'/.test(w)), inc.warnings.join('\n'));
    assert.ok(inc.warnings.some((w) => /"Later" \(follow-on\): 1 of 1 PR is still draft/.test(w)), inc.warnings.join('\n'));

    const named = await PL.buildPlan(await load(), { stack: 2 });
    assert.deepEqual(named.prs.map((p) => [p.number, p.base]), [[3, 'tag-b']]);
    assert.deepEqual(named.notes, ['r stack 2 "Later" is a follow-on stack (parked work, held back from the stacks going up now)']);
    assert.deepEqual(named.excluded_follow_on, []);
    // naming a regular stack: no follow-on note at all
    assert.deepEqual((await PL.buildPlan(await load(), { stack: 1 })).notes, []);

    const md = await lr('plan', fslug);
    assert.equal(md.code, 0, md.stderr);
    assert.match(md.stdout, /^Note: Excluded 1 follow-on stack \(1 PR: r stack 2 "Later"\); use --include-follow-on\.$/m);
    assert.doesNotMatch(md.stdout, /PR #3/);
    const mdInc = await lr('plan', fslug, '--include-follow-on');
    assert.match(mdInc.stdout, /including follow-on stacks/);
    assert.match(mdInc.stdout, /## r · Stack 2: Later \(follow-on\)/);
    const json = JSON.parse((await lr('plan', fslug, '--include-follow-on', '--format', 'json')).stdout);
    assert.equal(json.scope.include_follow_on, true);
    assert.deepEqual(json.prs.map((p: any) => p.number), [1, 2, 3]);
    assert.equal(JSON.parse((await lr('plan', fslug, '--format=json')).stdout).scope.include_follow_on, false);
    fs.rmSync(fdir, { recursive: true, force: true });
  });

  test('API: branch and github on every commit; PUT …/pr sets and clears them', async () => {
    port = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    server = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), 'serve'], {
      env: { ...process.env, PORT: String(port), LOCAL_REVIEW_DEV: '1', LOCAL_REVIEW_PROJECTS_DIR: PROJECTS },
      stdio: 'ignore',
    });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try {
        up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
      } catch { /* not up yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(up, 'server started');
    const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}/api/projects/${slug}${p}`, init);
    const put = (sha: string, b: unknown) => api(`/repos/r/commits/${sha}/pr`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

    const proj = await (await api('')).json();
    const cs = proj.repos[0].commits;
    assert.deepEqual(cs.map((c: any) => [c.branch?.name, c.branch?.status]), [['tag-a', 'ok'], ['tag-b', 'ok'], ['gone', 'missing']]);
    assert.deepEqual(cs[1].github, { number: 12, url: 'https://github.com/o/r/pull/12', branch: 'tag-b', base: 'tag-a' });
    assert.equal(cs[0].github, null);
    assert.deepEqual(cs[1].branch.discovered, ['tag-b', 'origin/tag-b']);

    const detail = await (await api(`/repos/r/commits/${fx.c}`)).json();
    assert.deepEqual([detail.commit.branch.name, detail.commit.branch.status, detail.commit.github], ['gone', 'missing', null]);

    // clear the recorded name: the tip branch is discovered
    let res = await put(fx.c, { branch: null });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).branch, { name: 'feature', status: 'discovered', discovered: ['feature'] });
    res = await put(fx.c, { branch: 'tag-a', github: { number: '13', url: 'https://github.com/o/r/pull/13' } });
    const j = await res.json();
    assert.deepEqual([j.branch.status, j.branch.points_at, j.github], ['moved', fx.a, { number: 13, url: 'https://github.com/o/r/pull/13' }]);
    assert.deepEqual(YAML.parse(fs.readFileSync(path.join(pdir, 'prs', 'r', `${fx.c}.yaml`), 'utf8')).github, { number: 13, url: 'https://github.com/o/r/pull/13' });
    res = await put(fx.c, { github: null });
    assert.equal((await res.json()).github, null);
    // status: on every commit and on the PR payload; PUT sets and clears it; github wins (published)
    assert.deepEqual((await (await api('')).json()).repos[0].commits.map((c: any) => c.status), ['draft', 'published', 'draft']);
    assert.deepEqual(cs[0].progress, { threads: 0, resolved: 0, files: 1, viewed: 0 });
    res = await put(fx.c, { status: 'Ready' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ready');
    assert.equal(YAML.parse(fs.readFileSync(path.join(pdir, 'prs', 'r', `${fx.c}.yaml`), 'utf8')).status, 'ready');
    assert.equal((await (await api(`/repos/r/commits/${fx.c}`)).json()).commit.status, 'ready');
    assert.equal((await (await put(fx.c, { github: 14 })).json()).status, 'published');
    assert.equal((await (await put(fx.c, { github: null })).json()).status, 'ready');
    assert.equal((await (await put(fx.c, { status: 'draft' })).json()).status, 'draft');
    assert.equal('status' in YAML.parse(fs.readFileSync(path.join(pdir, 'prs', 'r', `${fx.c}.yaml`), 'utf8')), false);
    for (const bad of [{ status: 'done' }, { status: true }]) assert.equal((await put(fx.c, bad)).status, 400, JSON.stringify(bad));
    for (const bad of [{ branch: '-x' }, { branch: 'a..b' }, { branch: 5 }, { github: { url: 'nope' } }, { github: { number: 1, url: 'javascript:alert(1)' } }, { github: { number: 1, branch: 'x y' } }]) {
      assert.equal((await put(fx.c, bad)).status, 400, JSON.stringify(bad));
    }
  });
});
