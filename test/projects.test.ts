// Projects: project.yaml parsing, splitting a repo's commits into PR stacks, commit ranges (base / from / to),
// and PR title/description overrides (read, write, follow a rebase).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { Repo, tmpDir } from './fixture.ts';

const PROJECTS = tmpDir('lr-test-projects-');
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const P = await import('../server/projects.ts');
const S = await import('../server/commits.ts');
const PR = await import('../server/prs.ts');
const { prContextFor } = await import('../server/context.ts');
const { eventFor } = await import('../server/events.ts');

const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(PROJECTS, { recursive: true, force: true });
});
function newRepo() {
  const r = Repo.create();
  repos.push(r);
  return r;
}

// ---------------------------------------------------------------- project.yaml
describe('project.yaml', () => {
  test('parses repos, defaults and colours; never throws', () => {
    const p = P.parseProject(
      'demo',
      '/tmp/demo',
      YAML.stringify({
        title: 'Demo',
        description: 'About *this*',
        repos: [
          { path: '~/code/my-service', branch: 'me/x', base: 'origin/main', stacks: [{ title: 'A', starts_at: 'First' }, { title: 'B', color: 'Green' }, { title: 'C', color: '#AbC' }, { title: 'D', color: 'mauve' }] },
          { path: '/r/my-service', to: 'abc1234', from: 'def5678', name: 'second' },
          { path: '/r/my-service', branch: 'y' }, // same basename: gets a distinct name
          { branch: 'no path' }, // skipped
          'junk',
        ],
      }),
    );
    assert.equal(p.error, undefined);
    // the skipped entries are said so, not silently dropped
    assert.deepEqual(p.warnings, [
      'repo 4 in `repos` ({"branch":"no path"}) has no `path`, so it\'s skipped. Give it the path of a git checkout.',
      'repo 5 in `repos` ("junk") isn\'t a mapping (path:, branch: …), so it\'s skipped.',
    ]);
    assert.deepEqual([p.title, p.description], ['Demo', 'About *this*']);
    assert.deepEqual(p.repos.map((r) => r.name), ['my-service', 'second', 'my-service-2']);
    const [r0, r1] = p.repos;
    assert.equal(r0.path, path.join(os.homedir(), 'code/my-service'));
    assert.deepEqual(r0.stacks.map((s) => [s.title, s.color, s.starts_at ?? null]), [['A', 'blue', 'First'], ['B', 'green', null], ['C', '#AbC', null], ['D', 'orange', null]]);
    assert.match(r0.warnings[0], /unknown colour 'mauve'/);
    assert.ok(!r0.warnings[0].includes('yellow'), 'yellow is not offered');
    assert.deepEqual([r1.to, r1.from, r1.branch], ['abc1234', 'def5678', undefined]);
    assert.ok(P.parseProject('bad', '/tmp/bad', 'repos: [unclosed').error?.includes('invalid YAML'));
    assert.ok(P.parseProject('bad', '/tmp/bad', '- a list').error);
    assert.equal(P.parseProject('t', '/tmp/t', '').title, 't'); // title defaults to the slug
  });

  test('colours: yellow is reserved for follow-on stacks, which are always yellow; auto colours never pick it', () => {
    assert.ok(!(P.PALETTE as readonly string[]).includes('yellow'));
    const titles = Array.from({ length: 9 }, (_, i) => ({ title: `S${i + 1}` }));
    const auto = P.parseProject('c', '/tmp/c', YAML.stringify({ repos: [{ path: '/r/a', branch: 'x', stacks: titles }] })).repos[0];
    assert.deepEqual(auto.stacks.map((s) => s.color), ['blue', 'green', 'purple', 'orange', 'pink', 'teal', 'red', 'blue', 'green']);
    assert.deepEqual(auto.warnings, []);
    const p = P.parseProject(
      'c',
      '/tmp/c',
      YAML.stringify({
        repos: [
          {
            path: '/r/a',
            branch: 'x',
            stacks: [
              { title: 'A', color: 'Yellow' }, // a regular stack: warned, falls back to its default colour
              { title: 'B', color: '#d4a72c' }, // hexes aren't classified
              { title: 'C', color: 'teal', follow_on: true }, // follow-on: yellow, the colour ignored silently
              { title: 'D', follow_on: true },
              { title: 'E', color: 'mauve', follow_on: 'yes' },
            ],
          },
        ],
      }),
    ).repos[0];
    assert.deepEqual(p.stacks.map((s) => s.color), ['blue', '#d4a72c', 'yellow', 'yellow', 'yellow']);
    assert.equal(p.warnings.length, 1, p.warnings.join('\n'));
    assert.match(p.warnings[0], /stack "A": yellow is reserved for follow-on stacks; using blue/);
    // a spec built in code: partitionStacks makes a follow-on group yellow too
    const g = P.partitionStacks([{ sha: 'a'.repeat(40), subject: 'One' }], [{ title: 'F', color: 'teal', follow_on: true }]).stacks;
    assert.deepEqual(g.map((x) => [x.color, x.follow_on]), [['yellow', true]]);
  });

  test('follow_on: true / false, "yes" / "no"; anything else is a warning, not a crash', () => {
    const p = P.parseProject(
      'f',
      '/tmp/f',
      [
        'repos:',
        '  - path: /r/x',
        '    stacks:',
        '      - { title: A, follow_on: false }',
        '      - { title: B, follow_on: true }',
        '      - { title: C, follow_on: "yes" }',
        '      - { title: D, follow_on: "No" }',
        '      - { title: E, follow_on: maybe }',
        '      - { title: F, follow_on: [1] }',
        '      - { title: G }',
      ].join('\n'),
    );
    assert.equal(p.error, undefined);
    assert.deepEqual(p.repos[0].stacks.map((s) => [s.title, s.follow_on ?? false]), [['A', false], ['B', true], ['C', true], ['D', false], ['E', false], ['F', false], ['G', false]]);
    assert.equal(p.repos[0].warnings.length, 2);
    assert.match(p.repos[0].warnings[0], /stack "E": follow_on must be true or false .* not "maybe"; ignored/);
    assert.match(p.repos[0].warnings[1], /stack "F": follow_on must be/);
  });

  test('project names must be plain directory names', () => {
    for (const bad of ['..', '.hidden', 'a/b', '../x', '']) assert.throws(() => P.projectDir(bad), bad);
    assert.equal(P.projectDir('my-feature'), path.join(PROJECTS, 'my-feature'));
  });

  test('watcher events map to review / pr / project changes', () => {
    const sha = 'a'.repeat(40);
    assert.deepEqual(eventFor(['p', 'project.yaml']), { type: 'project', project: 'p', reason: 'config' });
    assert.deepEqual(eventFor(['p', 'reviews', 'r', `${sha}.yaml`]), { type: 'review', project: 'p', repo: 'r', sha });
    assert.deepEqual(eventFor(['p', 'prs', 'r', `${sha}.yaml`]), { type: 'pr', project: 'p', repo: 'r', sha });
    assert.equal(eventFor(['p', 'reviews', 'r', 'notes.txt']), null);
  });
});

// ---------------------------------------------------------------- stack partitioning (pure)
describe('stack partitioning', () => {
  const commits = ['Add config loader', 'Add parser', 'Add lexer', 'Wire up the CLI', 'Add the feature flag', 'Cache results', 'Warm the cache'].map((subject, i) => ({
    sha: `${String(i + 1).repeat(8)}${'0'.repeat(32)}`,
    subject,
  }));
  const sha = (i: number) => commits[i].sha;
  const view = (r: ReturnType<typeof P.partitionStacks>) => r.stacks.map((s) => [s.number, s.title, s.shas.map((x) => commits.findIndex((c) => c.sha === x) + 1)]);

  test('subject and sha-prefix selectors; each stack runs to the next one', () => {
    const r = P.partitionStacks(commits, [
      { title: 'One', color: 'blue', starts_at: 'Add config loader' },
      { title: 'Two', color: 'green', starts_at: sha(3).slice(0, 7) },
      { title: 'Three', color: 'purple', starts_at: '  fixup!  Cache results ' }, // normalised like the rebase matcher
    ]);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(view(r), [[1, 'One', [1, 2, 3]], [2, 'Two', [4, 5]], [3, 'Three', [6, 7]]]);
    assert.deepEqual(r.stacks.map((s) => s.index), [0, 1, 2]);
  });

  test('commits before the first stack go into "Unstacked"', () => {
    const r = P.partitionStacks(commits, [{ title: 'Later', color: 'blue', starts_at: 'Add the feature flag' }]);
    assert.deepEqual(view(r), [[null, 'Unstacked', [1, 2, 3, 4]], [1, 'Later', [5, 6, 7]]]);
    assert.equal(r.stacks[0].implicit, 'unstacked');
    assert.equal(r.stacks[0].color, 'gray');
  });

  test('unresolved and out-of-order selectors: a warning and an empty stack, no crash', () => {
    const r = P.partitionStacks(commits, [
      { title: 'One', color: 'blue', starts_at: 'Add lexer' },
      { title: 'Gone', color: 'green', starts_at: 'Rebased away' },
      { title: 'Back', color: 'teal', starts_at: 'Add config loader' }, // before One's start
      { title: 'Tail', color: 'red', starts_at: 'Cache results' },
      { title: 'No selector', color: 'pink' },
    ]);
    assert.deepEqual(view(r), [[null, 'Unstacked', [1, 2]], [1, 'One', [3, 4, 5]], [2, 'Gone', []], [3, 'Back', []], [4, 'Tail', [6, 7]], [5, 'No selector', []]]);
    assert.equal(r.warnings.length, 3);
    assert.match(r.stacks[2].warning!, /doesn't match any commit/);
    assert.match(r.stacks[3].warning!, /out of order/);
    assert.match(r.stacks[5].warning!, /no starts_at/);
  });

  test('a short hex selector that is not a sha prefix is tried as a subject; the first stack may omit starts_at', () => {
    const cs = [{ sha: 'f'.repeat(40), subject: 'Init' }, { sha: 'e'.repeat(40), subject: 'deadbeef' }];
    const r = P.partitionStacks(cs, [{ title: 'A', color: 'blue' }, { title: 'B', color: 'green', starts_at: 'deadbeef' }]);
    assert.deepEqual(r.stacks.map((s) => s.shas.length), [1, 1]);
    assert.deepEqual(r.warnings, []);
  });

  test('duplicate subjects: the first match after the previous stack wins', () => {
    const cs = ['WIP', 'WIP', 'WIP'].map((subject, i) => ({ sha: String(i + 1).repeat(40), subject }));
    const r = P.partitionStacks(cs, [{ title: 'A', color: 'blue', starts_at: 'WIP' }, { title: 'B', color: 'green', starts_at: 'WIP' }]);
    assert.deepEqual(r.stacks.map((s) => s.shas.length), [1, 2]);
  });

  test('follow-on stacks: carried into the groups; a regular stack after one gets a warning', () => {
    const ok = P.partitionStacks(commits, [
      { title: 'One', color: 'blue', starts_at: 'Add config loader' },
      { title: 'Later', color: 'teal', starts_at: 'Cache results', follow_on: true },
    ]);
    assert.deepEqual(ok.warnings, []);
    assert.deepEqual(ok.stacks.map((s) => s.follow_on ?? false), [false, true]);
    assert.equal('follow_on' in ok.stacks[0], false, 'absent, not false, on a regular stack');
    const bad = P.partitionStacks(commits, [
      { title: 'One', color: 'blue', starts_at: 'Add config loader' },
      { title: 'Parked', color: 'teal', starts_at: 'Add the feature flag', follow_on: true },
      { title: 'Oops', color: 'red', starts_at: 'Cache results' },
      { title: 'Gone', color: 'red', starts_at: 'Rebased away' }, // also unresolved: both warnings
    ]);
    assert.equal(bad.warnings.length, 3, bad.warnings.join('\n'));
    assert.match(bad.stacks[2].warning!, /^stack 3 "Oops" comes after follow-on stack 2 "Parked" but isn't a follow-on itself/);
    assert.equal(bad.stacks[1].warning, undefined);
    assert.deepEqual(bad.stacks[3].warning!.split('\n').map((w) => /doesn't match/.test(w) || /after follow-on/.test(w)), [true, true]);
  });

  test('no stacks: one implicit stack named after the branch; no commits: no warnings', () => {
    const r = P.partitionStacks(commits, [], 'me/branch');
    assert.deepEqual([r.stacks.length, r.stacks[0].title, r.stacks[0].implicit, r.stacks[0].shas.length], [1, 'me/branch', 'branch', 7]);
    const e = P.partitionStacks([], [{ title: 'A', color: 'blue', starts_at: 'x' }]);
    assert.deepEqual([e.warnings, e.stacks[0].shas], [[], []]);
  });
});

// ---------------------------------------------------------------- ranges + loading a project from disk
describe('loading a project', () => {
  test('base / from / to ranges, stacks and dirs from a project.yaml on disk', async () => {
    const repo = newRepo();
    repo.commit('Initial', { 'a.txt': 'a\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    const c1 = repo.commit('One', { 'b.txt': 'b\n' });
    const c2 = repo.commit('Two', { 'c.txt': 'c\n' });
    const c3 = repo.commit('Three', { 'd.txt': 'd\n' });
    const dir = path.join(PROJECTS, 'loaded');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'project.yaml'),
      YAML.stringify({
        title: 'Loaded',
        repos: [
          { name: 'all', path: repo.dir, branch: 'feature', base: 'main', stacks: [{ title: 'S1', starts_at: 'One' }, { title: 'S2', starts_at: c3.slice(0, 9) }] },
          { name: 'from-to', path: repo.dir, from: c2, to: c2 },
          { name: 'bad-from', path: repo.dir, branch: 'main', from: c3 },
        ],
      }),
    );
    assert.ok(P.listProjectSlugs().includes('loaded'));
    const lp = (await P.loadProject('loaded'))!;
    const [all, ft, bad] = lp.repos;
    assert.deepEqual(all.info.commits.map((c) => c.sha), [c1, c2, c3]);
    assert.deepEqual(all.stacks.map((s) => s.shas), [[c1, c2], [c3]]);
    assert.equal(all.stackOf.get(c3), 1);
    assert.equal(all.reviewsDir, path.join(dir, 'reviews', 'all'));
    assert.equal(all.prsDir, path.join(dir, 'prs', 'all'));
    assert.deepEqual(ft.info.commits.map((c) => c.sha), [c2]);
    assert.match(bad.info.error!, /not an ancestor/);
    assert.equal(await P.loadProject('no-such-project'), null);
  });
});

describe('refs outside the safe character set', () => {
  test('are reported as unsafe, naming the field, not as "not found"', async () => {
    const repo = newRepo();
    repo.commit('Initial', { 'a.txt': 'a\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('Add b', { 'b.txt': 'b\n' });
    const cfg = { name: 'r', path: repo.dir, branch: 'feature', base: 'main' };
    const err = async (o: object) => (await S.loadRepo({ ...cfg, ...o })).error;
    assert.equal(await err({}), undefined);
    assert.match((await err({ branch: 'me/my feature' }))!, /^branch 'me\/my feature' has characters Local Review won't pass to git/);
    assert.match((await err({ to: '--output=x' }))!, /^'to' ref '--output=x' has characters/);
    assert.match((await err({ from: 'main..feature' }))!, /^'from' commit 'main\.\.feature' has characters/);
    assert.match((await err({ base: 'main;rm' }))!, /^base ref 'main;rm' has characters/);
    // a repo with landed PRs: a warning, not silently no range
    const opt = await S.loadRepo({ ...cfg, branch: 'gone:branch' }, { optional: true });
    assert.match(opt.warning!, /live range: branch 'gone:branch' has characters/);
  });
});

// ---------------------------------------------------------------- PR overrides
describe('PR title / description overrides', () => {
  async function ctxs(repo: Repo, dir: string) {
    const cfg = { name: 'r', path: repo.dir, branch: 'feature', base: 'main' };
    const info = await S.loadRepo(cfg);
    assert.equal(info.error, undefined);
    return info.commits.map((c) => prContextFor(dir, cfg, info, c));
  }

  test('defaults to the commit; set, clear; unknown fields kept; hand-written files tolerated', async () => {
    const repo = newRepo();
    repo.commit('Initial', { 'a.txt': 'a\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('Subject line\n\nCommit body.', { 'b.txt': 'b\n' });
    const dir = tmpDir('lr-test-prs-');
    const [c] = await ctxs(repo, dir);
    assert.deepEqual(PR.prView(await PR.loadPr(c), { subject: 'Subject line', body: 'Commit body.' }), {
      title: 'Subject line', body: 'Commit body.', title_source: 'commit', body_source: 'commit', commit_subject: 'Subject line', commit_body: 'Commit body.',
    });
    await PR.writePr(c, { title: '  A   better title ', body: 'Line one\r\nLine two\n\n' });
    const f = PR.prPath(dir, c.sha);
    const doc = YAML.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual([doc.commit, doc.subject, doc.title, doc.body], [c.sha, 'Subject line', 'A better title', 'Line one\nLine two\n']);
    assert.match(doc.patch_id, /^[0-9a-f]{40}$/);
    assert.match(fs.readFileSync(f, 'utf8'), /body: \|/);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + 'reviewer_notes: [a, b]\n');
    await PR.writePr(c, { body: null });
    const v = PR.prView(await PR.loadPr(c), { subject: 'Subject line', body: 'Commit body.' });
    assert.deepEqual([v.title, v.title_source, v.body, v.body_source], ['A better title', 'override', 'Commit body.', 'commit']);
    assert.deepEqual(YAML.parse(fs.readFileSync(f, 'utf8')).reviewer_notes, ['a', 'b']);
    // hand-written: just a title, blank title ignored, `description` alias
    fs.writeFileSync(f, 'title: "   "\ndescription: From an agent\n');
    assert.deepEqual((await PR.loadPr(c)).override, { body: 'From an agent' });
    // a hand-written override that says what the commit says (give or take whitespace) isn't an edit; the file is kept
    const same = 'title: "Subject  line "\nbody: "Commit body.\\n\\n  "\n';
    fs.writeFileSync(f, same);
    const u = PR.prView(await PR.loadPr(c), { subject: 'Subject line', body: 'Commit body.' });
    assert.deepEqual([u.title, u.title_source, u.body, u.body_source], ['Subject line', 'commit', 'Commit body.', 'commit']);
    assert.equal(fs.readFileSync(f, 'utf8'), same);
    // concurrent writes are serialised; nothing is lost and no temp files are left behind
    await Promise.all([PR.writePr(c, { title: 'T1' }), PR.writePr(c, { body: 'B1' })]);
    assert.deepEqual((await PR.loadPr(c)).override, { title: 'T1', body: 'B1' });
    assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('follow a rebase (patch-id) and a fixup (subject); never taken from a commit still in the range', async () => {
    const repo = newRepo();
    repo.commit('Initial', { 'a.txt': 'a\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('Add parser', { 'p.txt': 'p\n' });
    repo.commit('Use parser', { 'u.txt': 'u\n' });
    const dir = tmpDir('lr-test-prs-');
    const [a1, u1] = await ctxs(repo, dir);
    await PR.writePr(a1, { title: 'Parser PR' });
    await PR.writePr(u1, { body: 'Uses it' });

    // rebase onto a moved main: same patches, new shas
    repo.git('checkout', '-q', 'main');
    repo.commit('Main moves', { 'm.txt': 'm\n' });
    repo.git('checkout', '-q', 'feature');
    repo.git('rebase', '-q', 'main');
    const [a2, u2] = await ctxs(repo, dir);
    assert.notEqual(a2.sha, a1.sha);
    const batch = await PR.loadPrs(dir, a2.liveCommits!);
    assert.deepEqual([batch.get(a2.sha)?.override.title, batch.get(a2.sha)?.matchedBy, batch.get(u2.sha)?.override.body], ['Parser PR', 'patch-id', 'Uses it']);
    // a write moves it to the new sha and keeps the old file as a .bak
    await PR.writePr(a2, { body: 'and a body' });
    const doc = YAML.parse(fs.readFileSync(PR.prPath(dir, a2.sha), 'utf8'));
    assert.deepEqual([doc.title, doc.body.trim(), doc.previous_commits, doc.matched_by], ['Parser PR', 'and a body', [a1.sha], 'patch-id']);
    assert.equal(fs.existsSync(PR.prPath(dir, a1.sha)), false);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(a1.sha) && f.endsWith('.bak')));

    // a fixup that changes the patch: matched by subject
    repo.fixup(u2.sha, () => repo.write('u.txt', 'u changed\n'));
    const [, u3] = await ctxs(repo, dir);
    assert.notEqual(u3.sha, u2.sha);
    const l = await PR.loadPr(u3);
    assert.deepEqual([l.override.body, l.matchedBy], ['Uses it', 'subject']);

    // the file of a commit that is still in the range is never taken by another commit
    const [a4] = await ctxs(repo, dir);
    fs.writeFileSync(PR.prPath(dir, 'f'.repeat(40)), YAML.stringify({ commit: 'f'.repeat(40), subject: 'Add parser', title: 'stale' }));
    assert.equal((await PR.loadPr(a4)).override.title, 'Parser PR'); // its own file wins
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a hand-written file (just title/body, no server metadata) still follows a rebase and a fixup', async () => {
    const repo = newRepo();
    repo.commit('Initial', { 'a.txt': 'a\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('Add parser', { 'p.txt': 'p\n' });
    repo.commit('Use parser', { 'u.txt': 'u\n' });
    const dir = tmpDir('lr-test-prs-');
    const [a1, u1] = await ctxs(repo, dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PR.prPath(dir, a1.sha), 'title: Agent title\n');
    fs.writeFileSync(PR.prPath(dir, u1.sha), 'body: Agent body\n');
    repo.git('checkout', '-q', 'main');
    repo.commit('Main moves', { 'm.txt': 'm\n' });
    repo.git('checkout', '-q', 'feature');
    repo.git('rebase', '-q', 'main');
    const [a2, u2] = await ctxs(repo, dir);
    const batch = await PR.loadPrs(dir, a2.liveCommits!, a2.inspectOrphan);
    assert.deepEqual([batch.get(a2.sha)?.override.title, batch.get(a2.sha)?.matchedBy], ['Agent title', 'patch-id']);
    // a fixup changes the patch: matched by the subject git has for the old sha
    repo.fixup(u2.sha, () => repo.write('u.txt', 'u changed\n'));
    const [, u3] = await ctxs(repo, dir);
    const l = await PR.loadPr(u3);
    assert.deepEqual([l.override.body, l.matchedBy], ['Agent body', 'subject']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a file whose commit merely left the range (still an ancestor of the range end) is never carried to another commit', async () => {
    const repo = newRepo();
    repo.commit('Initial', { 'a.txt': 'a\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    const c1 = repo.commit('Fix lint', { 'b.txt': 'b\n' });
    const c2 = repo.commit('Feature', { 'c.txt': 'c\n' });
    repo.commit('Fix lint', { 'd.txt': 'd\n' }); // same subject as c1, different patch
    const dir = tmpDir('lr-test-prs-');
    const all = await ctxs(repo, dir);
    await PR.writePr(all[0], { title: 'Lint fixes for the parser' });
    // narrow the range with `from:` so c1 leaves it; the second "Fix lint" is now unique in the range
    const cfg = { name: 'r', path: repo.dir, branch: 'feature', from: c2 };
    const info = await S.loadRepo(cfg);
    assert.equal(info.error, undefined);
    const narrowed = info.commits.map((c) => prContextFor(dir, cfg, info, c));
    assert.deepEqual((await PR.loadPr(narrowed[1])).override, {});
    await PR.writePr(narrowed[1], { body: 'x' });
    assert.ok(fs.existsSync(PR.prPath(dir, c1)), "c1's file is left alone");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('repo names that collide get a suffix and a warning', () => {
    const p = P.parseProject('c', '/tmp/c', YAML.stringify({ repos: [{ path: '/a/x', branch: 'b' }, { path: '/b/x', branch: 'b' }, { path: '/c/y', name: 'x', branch: 'b' }] }));
    assert.deepEqual(p.repos.map((r) => r.name), ['x', 'x-2', 'x-3']);
    assert.deepEqual(p.repos.map((r) => r.warnings.length), [0, 1, 1]);
    assert.match(p.repos[1].warnings[0], /named "x".*x-2.*unique `name`/);
  });
});

// ---------------------------------------------------------------- writing the intro / stack notes
describe('project.yaml edits (intro and stack notes)', async () => {
  const E = await import('../server/projectEdit.ts');
  const HAND = `# A hand-written comment at the top
title: Demo # trailing comment
repos:
  - name: one
    path: /r/one
    branch: x
    stacks:
      - title: First
        # why this colour
        color: green
        starts_at: "Some subject"
      - Second
  - path: /r/two # no name: "two"
    branch: y
    stacks:
      - title: Only
`;
  const mk = (slug: string, text = HAND) => {
    fs.mkdirSync(path.join(PROJECTS, slug), { recursive: true });
    fs.writeFileSync(path.join(PROJECTS, slug, 'project.yaml'), text);
    return path.join(PROJECTS, slug, 'project.yaml');
  };

  test('setting the intro changes only that field; comments and order survive', async () => {
    const file = mk('edit-intro');
    const cfg = await E.editProjectYaml('edit-intro', (doc) => E.setProjectDescription(doc, 'Why we do this.\r\n\r\nSecond para.  \n\n'));
    assert.equal(cfg.description, 'Why we do this.\n\nSecond para.\n');
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, HAND.replace('# trailing comment\n', '# trailing comment\ndescription: |\n  Why we do this.\n\n  Second para.\n'));
    // editing again rewrites in place; clearing removes the key and gives back the original file
    await E.editProjectYaml('edit-intro', (doc) => E.setProjectDescription(doc, 'Shorter.'));
    assert.match(fs.readFileSync(file, 'utf8'), /^description: \|\n  Shorter\.\nrepos:/m);
    await E.editProjectYaml('edit-intro', (doc) => E.setProjectDescription(doc, null));
    assert.equal(fs.readFileSync(file, 'utf8'), HAND);
  });

  test('stack notes: by repo name and stack number, shorthand stacks, title guard', async () => {
    const file = mk('edit-stack');
    const cfg = await E.editProjectYaml('edit-stack', (doc, c) => E.setStackDescription(doc, c, 'one', 1, 'Context for *First*.', 'First'));
    assert.equal(cfg.repos[0].stacks[0].description, 'Context for *First*.');
    let text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('        # why this colour\n        color: green\n        starts_at: "Some subject"\n        description: |\n          Context for *First*.\n      - Second\n'), text);
    // `- Second` becomes a map so it can carry a note
    await E.editProjectYaml('edit-stack', (doc, c) => E.setStackDescription(doc, c, 'one', 2, 'B note'));
    const c2 = P.loadProjectConfig('edit-stack')!;
    assert.deepEqual(c2.repos[0].stacks.map((s) => [s.title, s.description ?? null]), [['First', 'Context for *First*.'], ['Second', 'B note']]);
    // the second repo is found by its derived name, not its position among valid entries
    await E.editProjectYaml('edit-stack', (doc, c) => E.setStackDescription(doc, c, 'two', 1, 'Two'));
    assert.equal(P.loadProjectConfig('edit-stack')!.repos[1].stacks[0].description, 'Two');
    text = fs.readFileSync(file, 'utf8');
    await assert.rejects(E.editProjectYaml('edit-stack', (doc, c) => E.setStackDescription(doc, c, 'one', 1, 'x', 'Renamed')), /is now "First"/);
    await assert.rejects(E.editProjectYaml('edit-stack', (doc, c) => E.setStackDescription(doc, c, 'one', 9, 'x')), /no stack 9/);
    await assert.rejects(E.editProjectYaml('edit-stack', (doc, c) => E.setStackDescription(doc, c, 'nope', 1, 'x')), /no repo/);
    assert.equal(fs.readFileSync(file, 'utf8'), text); // refused edits write nothing
    // partitionStacks carries the note into the stack groups
    const { stacks } = P.partitionStacks([{ sha: 'a'.repeat(40), subject: 'Some subject' }], c2.repos[0].stacks);
    assert.equal(stacks[0].description, 'Context for *First*.');
  });

  test('never overwrites a file that fails to parse; re-applies onto a concurrent change', async () => {
    const broken = 'title: [unclosed\n';
    const file = mk('edit-broken', broken);
    await assert.rejects(E.editProjectYaml('edit-broken', (doc) => E.setProjectDescription(doc, 'x')), /refusing to overwrite/);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
    // an agent saves the file while our edit is being applied: our change lands on top of theirs
    const f2 = mk('edit-race');
    let first = true;
    await E.editProjectYaml('edit-race', (doc) => {
      if (first) {
        first = false;
        fs.writeFileSync(f2, HAND.replace('title: Demo', 'title: Agent title'));
      }
      E.setProjectDescription(doc, 'Mine');
    });
    const c = P.loadProjectConfig('edit-race')!;
    assert.deepEqual([c.title, c.description], ['Agent title', 'Mine\n']);
  });
});
