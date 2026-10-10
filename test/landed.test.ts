// Landed (merged) PRs: prs/ `landed:` records listed in project.yaml's `landed:`, shown first with GitHub's diff of
// the PR, kept in their stacks, status `merged`, left out of totals and plans, and never re-matched. Throwaway repos
// and data directories in the OS temp dir only.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Repo, tmpDir } from './fixture.ts';

const PROJECTS = tmpDir('lr-test-landed-');
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const P = await import('../server/projects.ts');
const S = await import('../server/commits.ts');
const PR = await import('../server/prs.ts');
const PL = await import('../server/plan.ts');
const RV = await import('../server/reviews.ts');
const B = await import('../server/branches.ts');
const { contextFor, prContextFor, liveCommits, inspectOrphan } = await import('../server/context.ts');
const { aggregate, mergeAggregates, summary } = await import('../shared/totals.ts');
const { prStatus } = await import('../shared/readiness.ts');

const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(PROJECTS, { recursive: true, force: true });
});

const yaml = (o: unknown) => YAML.stringify(o, { lineWidth: 0 });
function writeProject(slug: string, project: unknown, prs: Record<string, unknown> = {}, repo = 'my-service') {
  const dir = path.join(PROJECTS, slug);
  fs.mkdirSync(path.join(dir, 'prs', repo), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.yaml'), yaml(project));
  for (const [sha, doc] of Object.entries(prs)) fs.writeFileSync(path.join(dir, 'prs', repo, `${sha}.yaml`), yaml(doc));
  return dir;
}

/**
 * main: I. The stack, as reviewed locally: A (PR 1), B1 + B2 (one two-commit PR, PR 2), C, D on me/my-feature.
 * PR 1 merged with a merge commit (M1). GitHub then rebased PR 2 onto main (B1', B2') and it was squash-merged (S2).
 * Locally, C and D were rebased onto the new main (C', D'): the live range.
 */
function mergedStack() {
  const r = Repo.create();
  repos.push(r);
  const I = r.commit('Initial', { 'base.txt': 'base\n' });
  r.git('checkout', '-q', '-b', 'me/my-feature');
  const A = r.commit('Add the config loader', { 'a.txt': 'a\n' });
  r.commit('Add the flag parser', { 'b.txt': 'b\n' });
  const B2 = r.commit('Test the flag parser', { 'b-test.txt': 'test b\n' });
  r.commit('Add the feature flag', { 'c.txt': 'c\n' });
  r.commit('Polish the feature', { 'd.txt': 'd\n' });
  // PR 1: a merge commit on main
  r.git('checkout', '-q', 'main');
  r.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #1 from me/config-loader', A);
  const M1 = r.git('rev-parse', 'HEAD');
  // PR 2: rebased by GitHub onto main (its base at merge is M1), then squash-merged
  r.git('checkout', '-q', '--detach', M1);
  r.git('cherry-pick', `${A}..${B2}`);
  const B2r = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-q', 'main');
  r.git('merge', '-q', '--squash', B2r);
  r.git('commit', '-q', '-m', 'Flag parser (#2)');
  const S2 = r.git('rev-parse', 'HEAD');
  // locally: what's left, onto the new main (me/old-tip keeps the stack as it was before)
  r.git('branch', 'me/old-tip', 'me/my-feature');
  r.git('rebase', '-q', '--onto', 'main', B2, 'me/my-feature');
  r.git('checkout', '-q', 'main');
  const [Cr, Dr] = r.git('rev-list', '--reverse', 'main..me/my-feature').split('\n');
  return { r, I, A, B2, M1, B2r, S2, Cr, Dr };
}

describe('landed PRs', () => {
  let f: ReturnType<typeof mergedStack>;
  let dir: string;
  const slug = 'landed-stack';
  before(() => {
    f = mergedStack();
    dir = writeProject(
      slug,
      {
        title: 'My feature',
        repos: [
          {
            name: 'my-service',
            path: f.r.dir,
            branch: 'me/my-feature',
            base: 'main',
            github_stack: 12,
            landed: [f.A.slice(0, 8), f.B2.slice(0, 10)],
            stacks: [
              { title: 'Groundwork', starts_at: 'Add the config loader' }, // PR 1's subject (from its head)
              { title: 'Flags', starts_at: 'Flag parser' }, // PR 2's title: a two-commit PR has no single subject
              { title: 'Feature', starts_at: 'Feature flag, on' }, // a live PR's title override
            ],
          },
        ],
      },
      {
        [f.A]: {
          commit: f.A,
          branch: 'me/config-loader',
          github: { number: 1, url: 'https://github.com/me/my-service/pull/1', branch: 'me/config-loader', base: 'main', stack: 12 },
          landed: { head: f.A, base: f.I, commit: f.M1, method: 'merge', at: '2026-10-01T10:00:00Z' },
        },
        // keyed by the local sha it was reviewed as; GitHub's head (after its rebase) is another sha
        [f.B2]: {
          commit: f.B2,
          subject: 'Test the flag parser',
          title: 'Flag parser',
          github: { number: 2, url: 'https://github.com/me/my-service/pull/2', branch: 'me/flag-parser', base: 'main', stack: 12, stacked_on: 'me/config-loader' },
          landed: { head: f.B2r, base: f.M1, commit: f.S2, method: 'Squash', at: '2026-10-02T10:00:00Z' },
        },
        [f.Cr]: { commit: f.Cr, title: 'Feature flag, on', branch: 'me/feature-flag', github: { number: 3, base: 'me/flag-parser' } },
        // an older published PR that merged with its sha intact, but nobody froze it
        [f.I]: { commit: f.I, github: { number: 9 } },
      },
    );
  });

  test('numbering: landed PRs first, in list order, then the live range', async () => {
    const p = (await P.loadProject(slug))!;
    const r = p.repos[0];
    assert.equal(r.info.error, undefined);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.info.commits.map((c) => c.sha), [f.A, f.B2, f.Cr, f.Dr]);
    assert.deepEqual(r.info.commits.map((c) => !!c.landed), [true, true, false, false]);
    assert.equal(r.cfg.github_stack, 12);
  });

  test('a merge-commit PR: merge-base(base, head)...head', async () => {
    const c = (await P.loadProject(slug))!.repos[0].info.commits[0];
    assert.equal(c.landed!.diff, 'merge-base');
    assert.equal(c.subject, 'Add the config loader');
    assert.deepEqual((await S.filesOf(f.r.dir, c)).map((x) => x.path), ['a.txt']);
    assert.equal(c.additions, 1);
  });

  test('a squash-merged multi-commit PR whose head GitHub rebased: only its own two commits', async () => {
    const c = (await P.loadProject(slug))!.repos[0].info.commits[1];
    assert.equal(c.sha, f.B2); // the key, not the head
    assert.equal(c.tip, f.B2r);
    assert.equal(c.parent, f.M1);
    assert.equal(c.landed!.method, 'squash');
    assert.equal(c.subject, 'Test the flag parser'); // the stored subject
    assert.deepEqual((await S.filesOf(f.r.dir, c)).map((x) => x.path).sort(), ['b-test.txt', 'b.txt']);
    const d = await S.detailOf(f.r.dir, c);
    assert.deepEqual(d.files.map((x) => [x.path, x.oldContent, x.newContent]).sort(), [['b-test.txt', null, 'test b\n'], ['b.txt', null, 'b\n']]);
  });

  test('a deleted branch (head object missing): falls back to the merge commit; nothing at all: no diff, a warning', async () => {
    const gone = 'f'.repeat(40);
    const fb = await S.landedSummary(f.r.dir, f.A, { head: gone, base: f.I, commit: f.M1, method: 'merge' }, { title: 'Config loader' });
    assert.equal(fb.landed!.diff, 'merge-commit');
    assert.equal(fb.tip, f.M1);
    assert.deepEqual((await S.filesOf(f.r.dir, fb)).map((x) => x.path), ['a.txt']);
    assert.equal(fb.subject, 'Add the config loader'); // from the key commit, still in the repo
    const none = await S.landedSummary(f.r.dir, 'e'.repeat(40), { head: gone, commit: 'd'.repeat(40) }, { title: 'Config loader' });
    assert.equal(none.landed!.diff, 'none');
    assert.equal(none.tip, null);
    assert.equal(none.subject, 'Config loader');
    assert.deepEqual(await S.filesOf(f.r.dir, none), []);
    assert.deepEqual((await S.detailOf(f.r.dir, none)).files, []);
  });

  test('a part-merged stack keeps its shape: starts_at matches landed subjects and PR titles', async () => {
    const r = (await P.loadProject(slug))!.repos[0];
    assert.deepEqual(r.stacks.map((g) => [g.title, g.shas]), [['Groundwork', [f.A]], ['Flags', [f.B2]], ['Feature', [f.Cr, f.Dr]]]);
  });

  test('status merged, branch merged (never a warning), github.stack kept', async () => {
    const p = (await P.loadProject(slug))!;
    const r = p.repos[0];
    const prs = await PR.loadPrs(r.prsDir, liveCommits(r.cfg, r.info), inspectOrphan(r.cfg, r.info));
    const refs = await B.loadRefs(f.r.dir);
    const o = prs.get(f.B2)!.override;
    assert.equal(prStatus(o), 'merged');
    assert.deepEqual(o.github, { number: 2, url: 'https://github.com/me/my-service/pull/2', branch: 'me/flag-parser', base: 'main', stack: 12, stacked_on: 'me/config-loader' });
    assert.deepEqual(B.reconcileBranch(refs, f.B2, o, 'me/my-feature'), { name: 'me/flag-parser', status: 'merged', discovered: [] });
    assert.equal(prStatus(prs.get(f.Cr)!.override), 'published');
  });

  test('totals and archived', async () => {
    const p = (await P.loadProject(slug))!;
    assert.equal(P.isArchived(p), false);
    const r = p.repos[0];
    const by = new Map(r.info.commits.map((c) => [c.sha, c]));
    const a = aggregate(
      r.stacks.map((g) => {
        const cs = g.shas.map((s) => by.get(s)!);
        const m = cs.filter((c) => c.landed);
        const t = (xs: typeof cs) => ({ prs: xs.length, additions: xs.reduce((n, c) => n + c.additions, 0), deletions: xs.reduce((n, c) => n + c.deletions, 0) });
        return { ...t(cs), merged: t(m) };
      }),
    );
    assert.deepEqual(summary(a, 1), { counts: '1 repo · 1 stack · 2 PRs', additions: 2, deletions: 0, note: null, merged: '+2 merged' });
  });

  test('writing to a landed PR (title, reviews) keeps its landed record; threads are placed on its own diff', async () => {
    const r = (await P.loadProject(slug))!.repos[0];
    const c = r.info.commits[1];
    await PR.writePr(prContextFor(r.prsDir, r.cfg, r.info, c), { title: 'Flag parser, tested' });
    const doc = YAML.parse(fs.readFileSync(path.join(r.prsDir, `${f.B2}.yaml`), 'utf8'));
    assert.equal(doc.title, 'Flag parser, tested');
    assert.equal(doc.subject, 'Test the flag parser');
    assert.deepEqual(doc.landed, { head: f.B2r, base: f.M1, commit: f.S2, method: 'Squash', at: '2026-10-02T10:00:00Z' });
    assert.equal(doc.github.stack, 12);
    const ctx = contextFor(r.reviewsDir, r.cfg, r.info, c);
    await RV.mutateReview(ctx, (rv) => rv.threads.push({ id: 't-1', path: 'b.txt', side: 'right', line: 1, resolved: false, comments: [{ id: 'c-1', author: 'ada', created: null, body: 'Fine.' }] }));
    const v = await RV.viewReview(ctx);
    assert.equal(v.review.threads[0].outdated, undefined);
    assert.equal(v.review.threads[0].anchor?.commit, f.B2);
    assert.equal(v.review.threads[0].anchor?.text, 'b');
    // put the title back for the other tests
    await PR.writePr(prContextFor(r.prsDir, r.cfg, r.info, c), { title: 'Flag parser' });
  });

  test('plan: landed PRs skipped, the first live PR on the repo base; GitHub base and unfrozen warnings', async () => {
    const plan = await PL.buildPlan((await P.loadProject(slug))!);
    assert.deepEqual(plan.prs.map((p) => [p.number, p.commit, p.base, p.base_from]), [
      [3, f.Cr, 'main', 'repo-base'],
      [4, f.Dr, 'me/feature-flag', 'previous-pr'],
    ]);
    assert.deepEqual(plan.excluded_landed, [{ repo: 'my-service', prs: [1, 2] }]);
    assert.ok(plan.notes.some((n) => /Skipped 2 landed \(merged\) PRs in my-service: PR #1, PR #2/.test(n)), plan.notes.join('\n'));
    assert.ok(plan.warnings.some((w) => /PR #3 .*GitHub PR #3 has base 'me\/flag-parser', but the plan's base is 'main'/.test(w)), plan.warnings.join('\n'));
    assert.ok(plan.warnings.some((w) => new RegExp(`prs file ${f.I.slice(0, 8)} \\(GitHub PR #9\\) has landed upstream .* isn't frozen`).test(w)), plan.warnings.join('\n'));
    // landed PRs give no warnings of their own (no branch, drafts, …)
    assert.ok(!plan.warnings.some((w) => /PR #[12] /.test(w)), plan.warnings.join('\n'));
    const only = await PL.buildPlan((await P.loadProject(slug))!, { stack: 1 });
    assert.deepEqual(only.prs, []);
    assert.ok(!only.warnings.some((w) => /empty/.test(w)));
  });

  test('a fully landed project with no (or a deleted) branch: no error, archived, its own totals', async () => {
    for (const branch of [undefined, 'me/deleted-after-merge']) {
      const s = `landed-only-${branch ? 'deleted' : 'none'}`;
      const d = writeProject(s, { title: 'Done', repos: [{ name: 'my-service', path: f.r.dir, base: 'main', ...(branch ? { branch } : {}), landed: [f.A.slice(0, 7), f.B2] }] }, {});
      for (const sha of [f.A, f.B2]) fs.copyFileSync(path.join(dir, 'prs', 'my-service', `${sha}.yaml`), path.join(d, 'prs', 'my-service', `${sha}.yaml`));
      const p = (await P.loadProject(s))!;
      assert.equal(p.repos[0].info.error, undefined);
      assert.deepEqual(p.repos[0].warnings, []);
      assert.deepEqual(p.repos[0].info.commits.map((c) => c.sha), [f.A, f.B2]);
      assert.equal(p.repos[0].stacks.length, 1); // no stacks: one, named after the branch or repo
      assert.equal(P.isArchived(p), true);
    }
    const only = aggregate([{ prs: 2, additions: 3, deletions: 0, merged: { prs: 2, additions: 3, deletions: 0 } }]);
    assert.deepEqual(summary(only, 1), { counts: '1 repo · 1 stack · 2 merged PRs', additions: 3, deletions: 0, note: null, merged: null });
    assert.deepEqual(summary(mergeAggregates([only, aggregate([])])), { counts: '2 merged PRs', additions: 3, deletions: 0, note: null, merged: null });
  });

  test('frozen before the rebase: a landed PR still in the live range is shown once, as landed', async () => {
    const s = 'landed-not-rebased';
    const d = writeProject(s, { title: 'Before', repos: [{ name: 'my-service', path: f.r.dir, branch: 'me/old-tip', from: f.A, landed: [f.A] }] }, {});
    fs.copyFileSync(path.join(dir, 'prs', 'my-service', `${f.A}.yaml`), path.join(d, 'prs', 'my-service', `${f.A}.yaml`));
    const r = (await P.loadProject(s))!.repos[0];
    assert.equal(r.info.commits.length, 5);
    assert.equal(r.info.commits.filter((c) => c.sha === f.A).length, 1);
    assert.ok(r.info.commits[0].landed);
    assert.ok(!r.info.commits[1].landed);
  });

  test('bad landed: entries are warnings, never errors', async () => {
    const s = 'landed-bad';
    const d = writeProject(s, { title: 'Bad', repos: [{ name: 'my-service', path: f.r.dir, base: 'main', landed: [f.A.slice(0, 8), 'abc', 'deadbeef', 12345678, f.A, f.Cr.slice(0, 8)] }] }, { [f.Cr]: { title: 'Not landed' } });
    fs.copyFileSync(path.join(dir, 'prs', 'my-service', `${f.A}.yaml`), path.join(d, 'prs', 'my-service', `${f.A}.yaml`));
    const r = (await P.loadProject(s))!.repos[0];
    assert.equal(r.info.error, undefined);
    assert.deepEqual(r.info.commits.map((c) => c.sha), [f.A]);
    const w = r.warnings.join('\n');
    assert.match(w, /"abc" is not a sha or sha prefix/);
    assert.match(w, /"deadbeef" has no prs file/);
    assert.match(w, /"12345678" has no prs file/);
    assert.match(w, /listed twice/);
    assert.match(w, new RegExp(`prs file ${f.Cr.slice(0, 8)} has no usable \`landed:\` block`));
    assert.equal(PR.landedOf({ head: 'nope', commit: 'NOT' }), null);
    assert.deepEqual(PR.landedOf({ head: f.A.toUpperCase(), method: 'Rebase', at: 'x' }), { head: f.A, method: 'rebase', at: 'x' });
  });
});

describe('landed files are never stolen by rebase re-matching', () => {
  test('a landed prs file is no orphan, and a frozen (landed) entry takes nothing', async () => {
    const d = tmpDir('lr-test-landed-orphans-');
    try {
      const [landedSha, liveSha, orphanSha, frozenSha] = ['1', '2', '3', '4'].map((x) => x.repeat(40));
      // a landed prs file whose subject equals a live commit's: it stays where it is
      fs.writeFileSync(path.join(d, `${landedSha}.yaml`), yaml({ commit: landedSha, subject: 'Add the feature flag', landed: { head: landedSha } }));
      // an ordinary orphan whose subject equals the frozen entry's: only a live commit could take it
      fs.writeFileSync(path.join(d, `${orphanSha}.yaml`), yaml({ commit: orphanSha, subject: 'Polish the feature' }));
      const live = [
        { sha: liveSha, subject: 'Add the feature flag', getPatchId: async () => null },
        { sha: frozenSha, subject: 'Polish the feature', getPatchId: async () => null, frozen: true },
      ];
      const m = await RV.matchOrphans(d, live);
      assert.equal(m.size, 0);
      // without the frozen flag the same entry would take it (the rule above is what stops it)
      const m2 = await RV.matchOrphans(d, live.map((c) => ({ ...c, frozen: false })));
      assert.deepEqual([...m2.entries()].map(([k, v]) => [k, v.orphan.sha, v.by]), [[frozenSha, orphanSha, 'subject']]);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
