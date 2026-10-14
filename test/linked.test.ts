// Linked projects (project.yaml `after: <slug>`): a successor's range, in a repo the predecessor also has, starts
// where the predecessor's ends while that's an ancestor, and at the base again once it isn't; bad links are warnings;
// the predecessor's commits in the range are noticed; plan bases the first PR on the predecessor's top PR. Throwaway
// repos and data directories in the OS temp dir only.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Repo, tmpDir } from './fixture.ts';

const PROJECTS = tmpDir('lr-test-linked-');
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const P = await import('../server/projects.ts');
const PL = await import('../server/plan.ts');

const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(PROJECTS, { recursive: true, force: true });
});

const yaml = (o: unknown) => YAML.stringify(o, { lineWidth: 0 });
function writeProject(slug: string, project: unknown, prs: Record<string, Record<string, unknown>> = {}) {
  const dir = path.join(PROJECTS, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.yaml'), yaml(project));
  for (const [repo, files] of Object.entries(prs)) {
    fs.mkdirSync(path.join(dir, 'prs', repo), { recursive: true });
    for (const [sha, doc] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'prs', repo, `${sha}.yaml`), yaml(doc));
  }
  return dir;
}
const subjects = (p: Awaited<ReturnType<typeof P.loadProject>>, repo = 'svc') => p!.repos.find((r) => r.cfg.name === repo)!.info.commits.map((c) => c.subject);

/** main: I. me/part-1: A, B (the predecessor). me/part-2: C, D on top of it (the successor). */
function tower() {
  const r = Repo.create();
  repos.push(r);
  r.commit('Initial', { 'base.txt': 'base\n' });
  r.git('checkout', '-q', '-b', 'me/part-1');
  const A = r.commit('Add the loader', { 'a.txt': 'a\n' });
  const B = r.commit('Use the loader', { 'b.txt': 'b\n' });
  r.git('checkout', '-q', '-b', 'me/part-2');
  const C = r.commit('Add the cache', { 'c.txt': 'c\n' });
  const D = r.commit('Use the cache', { 'd.txt': 'd\n' });
  r.git('checkout', '-q', 'main');
  return { r, A, B, C, D };
}

describe('linked projects: ranges', () => {
  test('a shared repo starts at the predecessor’s end; a repo only the successor has is unaffected', async () => {
    const { r } = tower();
    const other = Repo.create();
    repos.push(other);
    other.commit('Initial');
    other.git('checkout', '-q', '-b', 'me/ui');
    other.commit('A screen');
    writeProject('t1-part-1', { title: 'Part 1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-1', base: 'main' }] });
    writeProject('t1-part-2', { title: 'Part 2', after: 't1-part-1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', base: 'main' }, { name: 'ui', path: other.dir, branch: 'me/ui', base: 'main' }] });
    const p1 = await P.loadProject('t1-part-1');
    const p2 = await P.loadProject('t1-part-2');
    assert.deepEqual(subjects(p1), ['Add the loader', 'Use the loader']);
    assert.deepEqual(subjects(p2), ['Add the cache', 'Use the cache']);
    const svc = p2!.repos[0];
    assert.equal(svc.info.startsAfter, true);
    assert.equal(svc.cfg.after, 'me/part-1');
    assert.equal(svc.info.base, 'main'); // still known, for after the predecessor has merged
    assert.deepEqual(svc.warnings, []);
    assert.deepEqual(subjects(p2, 'ui'), ['A screen']);
    assert.ok(!p2!.repos[1].info.startsAfter);
    assert.deepEqual(p2!.after, { slug: 't1-part-1', title: 'Part 1' });
    assert.deepEqual(p2!.warnings, []);
    assert.equal(p1!.after, null);
    assert.deepEqual(P.successorsOf('t1-part-1'), [{ slug: 't1-part-2', title: 'Part 2' }]);
  });

  test('once the predecessor has merged and the successor is rebased onto main, the range starts at the base again', async () => {
    const { r, D } = tower();
    writeProject('t2-part-1', { title: 'Part 1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-1', base: 'main' }] });
    writeProject('t2-part-2', { title: 'Part 2', after: 't2-part-1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', base: 'main' }] });
    // a fast-forward merge: me/part-1 is now in main, and still an ancestor of me/part-2 (nothing changes)
    r.git('merge', '-q', '--ff-only', 'me/part-1');
    assert.deepEqual(subjects(await P.loadProject('t2-part-2')), ['Add the cache', 'Use the cache']);
    // a squash merge of part 1, then part 2 rebased onto main: me/part-1 still exists but isn't an ancestor any more
    r.git('reset', '-q', '--hard', 'HEAD~2');
    r.git('merge', '-q', '--squash', 'me/part-1');
    r.git('commit', '-q', '-m', 'Part 1 (#1)');
    r.git('checkout', '-q', 'me/part-2');
    r.git('rebase', '-q', '--onto', 'main', 'me/part-1');
    r.git('checkout', '-q', 'main');
    const p2 = await P.loadProject('t2-part-2');
    assert.deepEqual(subjects(p2), ['Add the cache', 'Use the cache']);
    assert.ok(!p2!.repos[0].info.startsAfter);
    assert.notEqual(p2!.repos[0].info.commits[1].sha, D);
    assert.deepEqual(p2!.repos[0].warnings, []);
  });

  test('squash-merged and the branch deleted, before the successor is rebased: its commits are noticed, with what to do', async () => {
    const { r, A, B } = tower();
    writeProject('t3-part-1', { title: 'Part 1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-1', base: 'main' }] }, { svc: { [A]: { title: 'Add the loader' }, [B]: { title: 'Use the loader' } } });
    writeProject('t3-part-2', { title: 'Part 2', after: 't3-part-1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', base: 'main' }] });
    r.git('merge', '-q', '--squash', 'me/part-1');
    r.git('commit', '-q', '-m', 'Part 1 (#1)');
    r.git('branch', '-q', '-D', 'me/part-1');
    const p2 = await P.loadProject('t3-part-2');
    // never dropped: the range is what git says, and the warning explains it
    assert.deepEqual(subjects(p2), ['Add the loader', 'Use the loader', 'Add the cache', 'Use the cache']);
    const w = p2!.repos[0].warnings.join('\n');
    assert.match(w, /includes 2 commits of the project it builds on, t3-part-1/);
    assert.match(w, /doesn't exist \(a deleted branch\?\)/);
  });

  test('a predecessor branch that is gone, with nothing landed and none of its commits here, is a warning too', async () => {
    const { r } = tower();
    writeProject('t4-part-1', { title: 'Part 1', repos: [{ name: 'svc', path: r.dir, branch: 'me/nope', base: 'main' }] });
    writeProject('t4-part-2', { title: 'Part 2', after: 't4-part-1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', base: 'main' }] });
    const p2 = await P.loadProject('t4-part-2');
    assert.equal(subjects(p2).length, 4);
    assert.match(p2!.repos[0].warnings.join('\n'), /builds on t4-part-1, whose range end here, 'me\/nope', doesn't exist/);
  });

  test('`from:` wins over the link; bad links (unknown, itself, a cycle, not a slug) are project warnings and no link', async () => {
    const { r, D } = tower();
    writeProject('t5-part-1', { title: 'Part 1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-1', base: 'main' }] });
    writeProject('t5-from', { title: 'From', after: 't5-part-1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', from: D }] });
    const f = await P.loadProject('t5-from');
    assert.deepEqual(subjects(f), ['Use the cache']);
    assert.equal(f!.repos[0].cfg.after, undefined);

    writeProject('t5-unknown', { title: 'U', after: 'no-such-project', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', base: 'main' }] });
    const u = await P.loadProject('t5-unknown');
    assert.equal(u!.after, null);
    assert.match(u!.warnings.join('\n'), /there's no project 'no-such-project'/);
    assert.equal(subjects(u).length, 4);

    writeProject('t5-self', { title: 'S', after: 't5-self', repos: [] });
    assert.match((await P.loadProject('t5-self'))!.warnings.join('\n'), /names this project itself/);

    writeProject('t5-a', { title: 'A', after: 't5-b', repos: [] });
    writeProject('t5-b', { title: 'B', after: 't5-a', repos: [] });
    const a = await P.loadProject('t5-a');
    assert.equal(a!.after, null);
    assert.match(a!.warnings.join('\n'), /makes a cycle \(t5-a → t5-b → t5-a\)/);
    assert.deepEqual(P.successorsOf('t5-a'), []);

    writeProject('t5-bad', { title: 'Bad', after: '../x', repos: [] });
    assert.match((await P.loadProject('t5-bad'))!.warnings.join('\n'), /must be the slug of another project/);
  });

  test('editing the predecessor’s branch moves the successor’s start, with no restart', async () => {
    const { r } = tower();
    writeProject('t6-part-1', { title: 'Part 1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-1', base: 'main' }] });
    writeProject('t6-part-2', { title: 'Part 2', after: 't6-part-1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', base: 'main' }] });
    assert.equal(subjects(await P.loadProject('t6-part-2')).length, 2);
    // part 1 now ends one commit later (it took "Add the cache")
    writeProject('t6-part-1', { title: 'Part 1', repos: [{ name: 'svc', path: r.dir, to: 'me/part-2~1', base: 'main' }] });
    assert.deepEqual(subjects(await P.loadProject('t6-part-2')), ['Use the cache']);
  });
});

describe('linked projects: plan', () => {
  test('the successor’s first PR is based on the predecessor’s top PR branch, with a warning until that is published', async () => {
    const { r, A, B } = tower();
    r.git('branch', 'me/part-1-b', B);
    r.git('branch', 'me/part-2-c', 'me/part-2~1');
    writeProject('t7-part-1', { title: 'Part 1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-1', base: 'main' }] }, { svc: { [A]: { branch: 'me/part-1-a' }, [B]: { branch: 'me/part-1-b' } } });
    writeProject('t7-part-2', { title: 'Part 2', after: 't7-part-1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', base: 'main' }] });
    const plan = await PL.buildPlan((await P.loadProject('t7-part-2'))!);
    assert.equal(plan.prs[0].base, 'me/part-1-b');
    assert.equal(plan.prs[0].base_from, 'predecessor');
    assert.equal(plan.prs[1].base_from, 'previous-pr');
    assert.match(plan.prs[0].warnings.join('\n'), /isn't published yet: publish t7-part-1 first/);
    assert.match(PL.planMarkdown(plan), /Base: `me\/part-1-b` \(the top PR of the project this builds on\)/);
    // published: no warning
    writeProject('t7-part-1', { title: 'Part 1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-1', base: 'main' }] }, { svc: { [B]: { branch: 'me/part-1-b', github: { number: 2, url: 'https://github.com/o/r/pull/2' } } } });
    const again = await PL.buildPlan((await P.loadProject('t7-part-2'))!);
    assert.deepEqual(again.prs[0].warnings.filter((w) => /publish/.test(w)), []);
    // the predecessor's own plan is unchanged
    const p1 = await PL.buildPlan((await P.loadProject('t7-part-1'))!);
    assert.equal(p1.prs[0].base, 'main');
    assert.equal(p1.prs[0].base_from, 'repo-base');
  });

  test('after the predecessor has merged and the successor is rebased: the repo base again', async () => {
    const { r } = tower();
    writeProject('t8-part-1', { title: 'Part 1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-1', base: 'main' }] });
    writeProject('t8-part-2', { title: 'Part 2', after: 't8-part-1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', base: 'main' }] });
    r.git('merge', '-q', '--squash', 'me/part-1');
    r.git('commit', '-q', '-m', 'Part 1 (#1)');
    r.git('checkout', '-q', 'me/part-2');
    r.git('rebase', '-q', '--onto', 'main', 'me/part-1');
    r.git('checkout', '-q', 'main');
    const plan = await PL.buildPlan((await P.loadProject('t8-part-2'))!);
    assert.equal(plan.prs[0].base, 'main');
    assert.equal(plan.prs[0].base_from, 'repo-base');
  });
});

describe('linked projects: the predecessor’s stacks in the picture', () => {
  test('?context: drawn first in a shared repo, greyed, unnumbered, left out of the totals; follow-on ones left out', async () => {
    const V = await import('../server/stackviz.ts');
    const { r } = tower();
    writeProject('t9-part-1', { title: 'Part one', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-1', base: 'main', stacks: [{ title: 'Loader' }] }] });
    writeProject('t9-part-2', { title: 'Part two', after: 't9-part-1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', base: 'main', stacks: [{ title: 'Cache' }] }] });
    const p2 = (await P.loadProject('t9-part-2'))!;
    const plain = await V.vizModel(p2, null);
    const m = await V.withPredecessor(plain, p2);
    assert.deepEqual(m.repos[0].stacks.map((s) => [s.label, !!s.context]), [['Part one · Stack 1 · Loader', true], ['Stack 1 · Cache', false]]);
    const svg = V.renderStackSvg(m);
    assert.ok(svg.includes('PART ONE · STACK 1 · LOADER') && svg.includes('Use the loader'));
    assert.ok(svg.includes('1 repo · 1 stack · 2 PRs'), 'the totals are the successor’s own');
    assert.match(svg, /<g opacity="0\.5">/);
    // the predecessor itself, or a project without one: unchanged
    const p1 = (await P.loadProject('t9-part-1'))!;
    const m1 = await V.vizModel(p1, null);
    assert.equal(await V.withPredecessor(m1, p1), m1);
    // the thumbnail: grey ghosts first in the lane
    const thumb = V.renderThumbSvg(m);
    assert.match(thumb, /<g class="s-gray" opacity="0\.45">/);
  });
});

describe('linked projects: `hidden: true`', () => {
  test('a hidden project still links both ways (ranges unchanged), but is marked as a hidden successor', async () => {
    const { r } = tower();
    writeProject('t10-part-1', { title: 'Part 1', hidden: true, repos: [{ name: 'svc', path: r.dir, branch: 'me/part-1', base: 'main' }] });
    writeProject('t10-part-2', { title: 'Part 2', hidden: 'yes', after: 't10-part-1', repos: [{ name: 'svc', path: r.dir, branch: 'me/part-2', base: 'main' }] });
    assert.equal(P.loadProjectConfig('t10-part-1')!.hidden, true);
    assert.equal(P.parseProject('x', '/x', 'title: X\nhidden: false\n').hidden, undefined);
    assert.equal(P.parseProject('x', '/x', 'title: X\n').hidden, undefined);
    const p2 = (await P.loadProject('t10-part-2'))!;
    assert.deepEqual(subjects(p2), ['Add the cache', 'Use the cache']); // still starts where hidden part 1 ends
    assert.deepEqual(p2.after, { slug: 't10-part-1', title: 'Part 1' });
    assert.deepEqual(p2.warnings, []);
    // part 2 is hidden: marked, so part 1's page leaves out its "Next" link
    assert.deepEqual(P.successorsOf('t10-part-1'), [{ slug: 't10-part-2', title: 'Part 2', hidden: true }]);
  });

  test('visibleProjects: hidden ones left out, a chain closes over them, the open one is kept', async () => {
    const { chainGroups, visibleProjects } = await import('../shared/chains.ts');
    const ps = [
      { slug: 'a', after: null },
      { slug: 'b', after: 'a', hidden: true },
      { slug: 'c', after: 'b' },
      { slug: 'd', after: 'c', hidden: true },
      { slug: 'x', after: null, hidden: true },
      { slug: 'y', after: 'x' },
      { slug: 'z', after: null },
    ];
    const slugs = (gs: { slug: string }[][]) => gs.map((g) => g.map((p) => p.slug));
    const v = visibleProjects(ps);
    assert.deepEqual(v.map((p) => [p.slug, p.after]), [['a', null], ['c', 'a'], ['y', null], ['z', null]]);
    assert.deepEqual(slugs(chainGroups(v)), [['a', 'c'], ['y'], ['z']]);
    assert.equal(v[0], ps[0], 'an unchanged project is the same object');
    // `keep`: the open project is listed even though it's hidden, where it is in its chain
    const k = visibleProjects(ps, 'b');
    assert.deepEqual(slugs(chainGroups(k)), [['a', 'b', 'c'], ['y'], ['z']]);
    assert.deepEqual(visibleProjects([{ slug: 'a', after: null, hidden: true }]), []);
  });
});
