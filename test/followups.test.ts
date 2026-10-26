// pr_model: follow-ups: commits added on top of a published PR's branch (instead of fixup + autosquash) are part of
// that PR, not PRs of their own. Throwaway repos and data directories in the OS temp dir only.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Repo, tmpDir } from './fixture.ts';

const PROJECTS = tmpDir('lr-test-followups-');
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const P = await import('../server/projects.ts');
const S = await import('../server/commits.ts');
const PL = await import('../server/plan.ts');

const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(PROJECTS, { recursive: true, force: true });
});

const yaml = (o: unknown) => YAML.stringify(o, { lineWidth: 0 });
function writeProject(slug: string, repo: Partial<Record<string, unknown>>, prs: Record<string, unknown>) {
  const dir = path.join(PROJECTS, slug);
  fs.mkdirSync(path.join(dir, 'prs', 'svc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.yaml'), yaml({ title: slug, repos: [{ name: 'svc', branch: 'pr2', base: 'main', ...repo }] }));
  for (const [sha, doc] of Object.entries(prs)) fs.writeFileSync(path.join(dir, 'prs', 'svc', `${sha}.yaml`), yaml(doc));
}

/** main: I. pr1: A (published), pr2: B on top. Then a follow-up F on pr1, and pr2 rebased onto it: A F B'. */
function followUpStack() {
  const r = Repo.create();
  repos.push(r);
  r.commit('Initial', { 'base.txt': 'base\n' });
  r.git('checkout', '-q', '-b', 'pr1');
  const A = r.commit('Add the config loader', { 'a.txt': 'a\n' });
  r.git('checkout', '-q', '-b', 'pr2');
  const B = r.commit('Add the flag parser', { 'b.txt': 'b\n' });
  const prs = { [A]: { commit: A, subject: 'Add the config loader', branch: 'pr1', github: { number: 1, url: 'https://github.com/o/r/pull/1', branch: 'pr1' } }, [B]: { commit: B, subject: 'Add the flag parser', branch: 'pr2' } };
  r.git('checkout', '-q', 'pr1');
  const F = r.commit('Review: handle an empty config', { 'a.txt': 'a\nempty\n', 'a-test.txt': 'test\n' });
  r.git('checkout', '-q', 'pr2');
  r.git('rebase', '-q', '--update-refs', 'pr1');
  return { r, A, B, F, B2: r.git('rev-parse', 'pr2'), prs };
}

describe('pr_model: follow-ups', () => {
  test('a follow-up on a PR branch is folded into that PR', async () => {
    const f = followUpStack();
    writeProject('fold', { path: f.r.dir, pr_model: 'follow-ups' }, f.prs);
    const r = (await P.loadProject('fold'))!.repos[0];
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.info.commits.map((c) => c.sha), [f.A, f.B2]);
    const [a, b] = r.info.commits;
    assert.deepEqual(a.members!.map((m) => m.sha), [f.A, f.F]);
    assert.equal(a.tip, f.F);
    assert.equal(a.parent, (await S.summarize(f.r.dir, f.A)).parent);
    // the diff covers the root and its follow-up
    assert.deepEqual((await S.filesOf(f.r.dir, a)).map((x) => x.path).sort(), ['a-test.txt', 'a.txt']);
    assert.deepEqual([a.additions, a.filesChanged], [3, 2]);
    const d = await S.detailOf(f.r.dir, a);
    assert.equal(d.files.find((x) => x.path === 'a.txt')?.newContent, 'a\nempty\n');
    assert.equal(d.subject, 'Add the config loader');
    assert.equal(b.members, undefined);
    // the plan: two PRs, PR 1's branch ok at its head, PR 2 based on it, no "moved" warnings
    const plan = await PL.buildPlan((await P.loadProject('fold'))!);
    assert.deepEqual(plan.prs.map((p) => [p.number, p.branch?.name, p.branch?.status, p.base]), [[1, 'pr1', 'ok', 'main'], [2, 'pr2', 'ok', 'pr1']]);
    assert.equal(plan.prs[0].branch?.follow_ups, 1);
    assert.deepEqual(plan.prs[0].follow_ups, [{ sha: f.F, subject: 'Review: handle an empty config' }]);
    assert.deepEqual(plan.prs.flatMap((p) => p.warnings), []);
    assert.match(PL.planMarkdown(plan), /`pr1` \(ok, \+1 follow-up\)/);
  });

  test('without pr_model, nothing changes: the follow-up is a PR of its own and the branch has moved', async () => {
    const f = followUpStack();
    writeProject('plain', { path: f.r.dir }, f.prs);
    const r = (await P.loadProject('plain'))!.repos[0];
    assert.deepEqual(r.info.commits.map((c) => c.sha), [f.A, f.F, f.B2]);
    assert.ok(r.info.commits.every((c) => !c.members));
    const plan = await PL.buildPlan((await P.loadProject('plain'))!);
    assert.equal(plan.prs[0].branch?.status, 'moved');
  });

  test("nothing is folded across a commit that's a PR of its own", async () => {
    const f = followUpStack();
    // pr1 moved up onto PR 2 (a mistake, not a follow-up): B' has its own branch, so it stays a PR
    f.r.git('branch', '-f', 'pr1', f.B2);
    writeProject('own', { path: f.r.dir, pr_model: 'follow-ups' }, { ...f.prs, [f.F]: { commit: f.F, subject: 'Review: handle an empty config', branch: 'pr-f' } });
    const r = (await P.loadProject('own'))!.repos[0];
    assert.deepEqual(r.info.commits.map((c) => c.sha), [f.A, f.F, f.B2]);
    const plan = await PL.buildPlan((await P.loadProject('own'))!);
    assert.equal(plan.prs[0].branch?.status, 'moved');
  });

  test('a bad pr_model is a warning, and today\'s model applies', async () => {
    const f = followUpStack();
    writeProject('bad', { path: f.r.dir, pr_model: 'stacked' }, f.prs);
    const r = (await P.loadProject('bad'))!.repos[0];
    assert.match(r.warnings.join('\n'), /pr_model` must be follow-ups or commit/);
    assert.equal(r.info.commits.length, 3);
  });
});
