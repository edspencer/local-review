import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Repo, lines, tmpDir } from './fixture.ts';

// config.ts reads this at import time, so set it before importing the server modules
const REVIEWS = tmpDir('lr-test-reviews-');
process.env.LOCAL_REVIEW_PROJECTS_DIR = REVIEWS;
const R = await import('../server/reviews.ts');
const S = await import('../server/commits.ts');
const A = await import('../server/anchors.ts');
const { contextFor } = await import('../server/context.ts');
type Ctx = import('../server/reviews.ts').ReviewContext;
type Thread = import('../server/reviews.ts').Thread;

const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(REVIEWS, { recursive: true, force: true });
});

let stackSeq = 0;
function newRepo() {
  const r = Repo.create();
  repos.push(r);
  return r;
}

/** Load the `feature` branch of `repo` as a stack and return one review context per commit (oldest first). */
async function stack(repo: Repo, name: string): Promise<Ctx[]> {
  const cfg = { name, path: repo.dir, branch: 'feature', base: 'main' };
  const info = await S.loadRepo(cfg);
  assert.equal(info.error, undefined, String(info.error));
  return info.commits.map((c) => contextFor(path.join(REVIEWS, name), cfg, info, c));
}

const file = (ctx: Ctx) => R.reviewPath(ctx.dir, ctx.sha);
const readDoc = (f: string) => YAML.parse(fs.readFileSync(f, 'utf8'));

/** What the API does for POST …/threads. */
function addThread(ctx: Ctx, t: { path?: string; side?: 'left' | 'right'; line?: number; start_line?: number; body: string; author?: string }) {
  return R.mutateReview(ctx, (r) => {
    const th: Thread = { id: R.randomId('t'), resolved: false, comments: [] };
    if (t.path) Object.assign(th, { path: t.path, side: t.side ?? 'right', line: t.line, ...(t.start_line ? { start_line: t.start_line } : {}) });
    th.comments.push({ id: R.randomId('c'), author: t.author ?? 'ada', created: '2026-10-08T12:00:00Z', body: t.body });
    r.threads.push(th);
  });
}

const reply = (ctx: Ctx, tid: string, body: string, author = 'ada') =>
  R.mutateReview(ctx, (r) => {
    const t = r.threads.find((x) => x.id === tid);
    if (!t) throw new Error(`no thread ${tid}`);
    t.comments.push({ id: R.randomId('c'), author, created: null, body });
  });

const PARSER = lines(30, (i) => (i === 10 ? '  return tokens.filter(Boolean); // target' : `  const v${i} = ${i};`));

/** main: README; feature: "Add parser" (adds src/parser.ts), "Use parser" (edits README). */
function parserRepo() {
  const repo = newRepo();
  repo.commit('Initial', { 'README.md': 'hello\n', 'src/util.ts': lines(12, (i) => `export const u${i} = ${i};`) });
  repo.git('checkout', '-q', '-b', 'feature');
  repo.commit('Add parser', { 'src/parser.ts': PARSER });
  repo.commit('Use parser', { 'README.md': 'hello\nuses the parser\n' });
  return repo;
}

// ---------------------------------------------------------------- anchors (pure)
describe('anchor text search', () => {
  const file = ['a', '}', 'b', 'c', '}', 'd'];
  test('prefers the match whose context fits', () => {
    assert.equal(A.findAnchorText(file, { text: '}', before: 'b\nc', after: 'd' }, 2), 5);
    assert.equal(A.findAnchorText(file, { text: '}', before: 'a', after: 'b' }, 5), 2);
  });
  test('ties broken by distance to the hint', () => {
    assert.equal(A.findAnchorText(file, { text: '}' }, 1), 2);
    assert.equal(A.findAnchorText(file, { text: '}' }, 6), 5);
  });
  test('falls back to whitespace-insensitive matching (re-indented code)', () => {
    assert.equal(A.findAnchorText(['x', '    return  1;', 'y'], { text: '  return 1;' }, 1), 2);
  });
  test('a blank line needs some context to match', () => {
    assert.equal(A.findAnchorText(['a', '', 'b'], { text: '', before: 'zzz' }, 2), null);
    assert.equal(A.findAnchorText(['a', '', 'b', '', 'c'], { text: '', before: 'b', after: 'c' }, 1), 4);
  });
  test('multi-line text and missing text', () => {
    assert.equal(A.findAnchorText(['p', 'q', 'r', 's'], { text: 'q\nr' }, 1), 2);
    assert.equal(A.findAnchorText(['p', 'q'], { text: 'nope' }, 1), null);
  });
  test('makeAnchor captures text and up to 3 lines of context', () => {
    const files = [{ path: 'f', oldPath: 'f', oldContent: null, newContent: lines(10, (i) => `L${i}`) }];
    const a = A.makeAnchor(files, 'c'.repeat(40), { path: 'f', side: 'right', line: 6, start_line: 5 })!;
    assert.equal(a.text, 'L5\nL6');
    assert.equal(a.before, 'L2\nL3\nL4');
    assert.equal(a.after, 'L7\nL8\nL9');
    const top = A.makeAnchor(files, 'c'.repeat(40), { path: 'f', side: 'right', line: 1 })!;
    assert.equal(top.before, undefined);
    assert.equal(A.makeAnchor(files, 'c'.repeat(40), { path: 'f', side: 'right', line: 11 }), null);
  });
});

test('normalizeSubject strips fixup!/squash!/amend! and whitespace', () => {
  assert.equal(R.normalizeSubject('fixup! squash!  Add   parser '), 'Add parser');
  assert.equal(R.normalizeSubject('amend! Add parser'), 'Add parser');
  assert.equal(R.normalizeSubject('Add parser'), 'Add parser');
});

// ---------------------------------------------------------------- parsing, ids, writes
describe('review files', () => {
  const ctx = (name: string): Ctx => ({ repo: name, dir: path.join(REVIEWS, name), repoPath: '/x', branch: 'b', sha: 'a'.repeat(40), subject: 'S', getPatchId: async () => 'p'.repeat(40) });

  test('tolerant parsing of hand-written files', () => {
    const r = R.normalize(
      {
        threads: [
          { body: 'single body', author: 'Claude', path: 'a.ts', line: '3', side: 'old' },
          { comments: ['plain string', { text: 'text key' }, { comment: 'comment key', author: 'ADA' }] },
          null,
          { path: 'b.ts', line: 5, start_line: 9 }, // bad range: start_line dropped
        ],
        viewed: ['a.ts', 'a.ts', 7],
      },
      ctx('parse'),
    );
    assert.equal(r.threads.length, 4);
    const [t0, t1, t2, t3] = r.threads;
    assert.deepEqual([t0.path, t0.side, t0.line, t0.comments[0].author, t0.comments[0].body], ['a.ts', 'left', 3, 'claude', 'single body']);
    assert.equal('body' in t0, false);
    assert.deepEqual(t1.comments.map((c) => c.body), ['plain string', 'text key', 'comment key']);
    assert.deepEqual(t1.comments.map((c) => c.author), ['unknown', 'unknown', 'ada']);
    assert.equal(t1.path, undefined);
    assert.equal(t2.comments.length, 0);
    assert.equal(t3.start_line, undefined);
    assert.deepEqual(r.viewed, ['a.ts', '7']);
    assert.equal(r.commit, 'a'.repeat(40));
  });

  test('ids: missing ones assigned on write, existing kept, duplicates replaced', async () => {
    const c = ctx('ids');
    const f = R.reviewPath(c.dir, c.sha);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      `threads:
  - id: t-keep
    comments:
      - id: c-keep
        author: ada
        body: one
      - author: claude
        body: no id
  - comments:
      - id: c-keep
        body: duplicate id
`,
    );
    await R.mutateReview(c, (r) => r.viewed.push('x'));
    const doc = readDoc(f);
    assert.equal(doc.threads[0].id, 't-keep');
    assert.equal(doc.threads[0].comments[0].id, 'c-keep');
    assert.match(doc.threads[0].comments[1].id, /^c-[0-9a-f]{8}$/);
    assert.match(doc.threads[1].id, /^t-[0-9a-f]{8}$/);
    assert.notEqual(doc.threads[1].comments[0].id, 'c-keep');
    assert.equal(doc.patch_id, 'p'.repeat(40));
    // bodies are block literals, easy for an agent to append to
    assert.match(fs.readFileSync(f, 'utf8'), /body: \|/);
  });

  test('atomic writes leave no temp files and unknown fields survive', async () => {
    const c = ctx('atomic');
    const f = R.reviewPath(c.dir, c.sha);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'custom_top: 1\nthreads:\n  - id: t-1\n    custom_thread: true\n    comments:\n      - id: c-1\n        author: ada\n        mood: happy\n        body: hi\n');
    await Promise.all(Array.from({ length: 20 }, (_, i) => reply(c, 't-1', `reply ${i}`)));
    const doc = readDoc(f);
    assert.equal(doc.threads[0].comments.length, 21);
    assert.equal(doc.custom_top, 1);
    assert.equal(doc.threads[0].custom_thread, true);
    assert.equal(doc.threads[0].comments[0].mood, 'happy');
    assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((x) => x.endsWith('.tmp')), []);
  });

  test('refuses to overwrite a file that is not valid YAML', async () => {
    const c = ctx('broken');
    const f = R.reviewPath(c.dir, c.sha);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const bad = 'threads: [\n  - oops: : :\n';
    fs.writeFileSync(f, bad);
    await assert.rejects(R.mutateReview(c, (r) => r.viewed.push('x')), /not valid YAML/);
    assert.equal(fs.readFileSync(f, 'utf8'), bad);
  });

  test('an agent reply saved while the UI is writing is not lost', async () => {
    const repo = parserRepo();
    const [c1] = await stack(repo, `race-${++stackSeq}`);
    const r0 = await addThread(c1, { path: 'src/parser.ts', line: 10, body: 'Why filter here?' });
    const tid = r0.threads[0].id;
    // Simulate the agent saving the file in the middle of the UI's write: the server has already read the
    // file and is computing anchors (async git work) when the agent appends its reply.
    let injected = false;
    const racing: Ctx = {
      ...c1,
      getFiles: async (sha) => {
        if (!injected) {
          injected = true;
          const f = file(c1);
          const doc = readDoc(f);
          doc.threads[0].comments.push({ author: 'claude', body: 'Because empty tokens break the lexer.' });
          fs.writeFileSync(f, YAML.stringify(doc));
        }
        return c1.getFiles!(sha);
      },
    };
    await reply(racing, tid, 'OK, thanks');
    assert.ok(injected);
    const bodies = readDoc(file(c1)).threads[0].comments.map((c: any) => c.body.trim());
    assert.deepEqual(bodies, ['Why filter here?', 'Because empty tokens break the lexer.', 'OK, thanks']);
    // and the agent's comment got a real id
    assert.match(readDoc(file(c1)).threads[0].comments[1].id, /^c-[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------- commit matching + relocation
describe('rebases', () => {
  test('exact sha, then patch-id after a rebase onto a moved main', async () => {
    const repo = parserRepo();
    const name = `pid-${++stackSeq}`;
    const [c1] = await stack(repo, name);
    await addThread(c1, { path: 'src/parser.ts', line: 10, body: 'hmm' });
    const exact = await R.loadReview(c1);
    assert.equal(exact.matchedFrom, undefined);
    assert.equal(exact.review.threads.length, 1);
    const anchor = exact.review.threads[0].anchor!;
    assert.equal(anchor.commit, c1.sha);
    assert.equal(anchor.text, '  return tokens.filter(Boolean); // target');
    assert.equal(anchor.before!.split('\n').length, 3);

    repo.git('checkout', '-q', 'main');
    repo.commit('Unrelated main work', { 'other.txt': 'x\n' });
    repo.git('checkout', '-q', 'feature');
    repo.git('rebase', '-q', 'main');
    const [n1, n2] = await stack(repo, name);
    assert.notEqual(n1.sha, c1.sha);
    assert.equal(await n1.getPatchId(), await c1.getPatchId());
    const l = await R.viewReview(n1);
    assert.equal(l.matchedFrom, c1.sha);
    assert.equal(l.matchedBy, 'patch-id');
    assert.equal(l.review.threads[0].line, 10);
    assert.equal((await R.loadReview(n2)).file, null, 'the other commit must not pick it up');

    // next write moves it under the new sha and keeps the old file as a .bak
    await R.mutateReview(n1, (r) => r.viewed.push('src/parser.ts'));
    const doc = readDoc(file(n1));
    assert.deepEqual(doc.previous_commits, [c1.sha]);
    assert.equal(doc.matched_by, 'patch-id');
    assert.equal(doc.commit, n1.sha);
    assert.equal(fs.existsSync(file(c1)), false);
    assert.ok(fs.readdirSync(path.dirname(file(c1))).some((f) => f.startsWith(c1.sha) && f.endsWith('.bak')));
  });

  test('a fixup that changes the patch-id: matched by subject, moved line relocated', async () => {
    const repo = parserRepo();
    const name = `subj-${++stackSeq}`;
    const [c1] = await stack(repo, name);
    const r = await addThread(c1, { path: 'src/parser.ts', line: 10, body: 'comment on line 10' });
    const range = await addThread(c1, { path: 'src/parser.ts', line: 12, start_line: 11, body: 'range' });
    await addThread(c1, { body: 'general comment' });
    const tid = r.threads[0].id;
    const rid = range.threads[1].id;

    repo.fixup(c1.sha, () => repo.write('src/parser.ts', '// header 1\n// header 2\n// header 3\n// header 4\n' + PARSER));
    const [n1] = await stack(repo, name);
    assert.notEqual(await n1.getPatchId(), await c1.getPatchId(), 'the fixup must change the patch-id');

    const l = await R.viewReview(n1);
    assert.equal(l.matchedFrom, c1.sha);
    assert.equal(l.matchedBy, 'subject');
    const t = l.review.threads.find((x) => x.id === tid)!;
    assert.equal(t.outdated, undefined);
    assert.equal(t.line, 14);
    const rt = l.review.threads.find((x) => x.id === rid)!;
    assert.deepEqual([rt.start_line, rt.line], [15, 16]);
    assert.equal(l.review.threads.length, 3);

    // saving: new location stored, original kept in the anchor
    await reply(n1, tid, 'still here');
    const doc = readDoc(file(n1));
    const saved = doc.threads.find((x: any) => x.id === tid);
    assert.equal(saved.line, 14);
    assert.equal(saved.anchor.line, 10);
    assert.equal(saved.anchor.commit, c1.sha);
    assert.equal(doc.matched_by, 'subject');
    assert.equal(saved.comments.length, 2);
  });

  test('never steals the file of a commit that is still on the stack; ambiguous subjects are skipped', async () => {
    const repo = newRepo();
    repo.commit('Initial', { 'a.txt': 'a\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('WIP', { 'b.txt': 'b\n' });
    repo.commit('WIP', { 'c.txt': 'c\n' });
    repo.commit('Tidy', { 'd.txt': 'd\n' });
    const name = `steal-${++stackSeq}`;
    const [w1, w2, t1] = await stack(repo, name);
    await addThread(w2, { body: 'on the second WIP' });
    // w2's file is live: neither w1 (same subject) nor t1 gets it
    assert.equal((await R.loadReview(w1)).file, null);
    assert.equal((await R.loadReview(t1)).file, null);

    // an orphan whose subject is "WIP" is not matched to either WIP commit (subject not unique on the stack)
    const fake = 'f'.repeat(40);
    fs.writeFileSync(R.reviewPath(path.join(REVIEWS, name), fake), YAML.stringify({ commit: fake, subject: 'WIP', patch_id: 'nope', threads: [{ comments: ['orphan'] }] }));
    assert.equal((await R.loadReview(w1)).file, null);
    // but one with a unique subject (after normalising a fixup! prefix) is
    fs.writeFileSync(R.reviewPath(path.join(REVIEWS, name), 'e'.repeat(40)), YAML.stringify({ commit: 'e'.repeat(40), subject: 'fixup!  Tidy', threads: [{ comments: ['x'] }] }));
    const lt = await R.loadReview(t1);
    assert.equal(lt.matchedFrom, 'e'.repeat(40));
    assert.equal(lt.matchedBy, 'subject');
  });

  test('not carried over: a commit that only left the range, or a file from another repo that had this name', async () => {
    const repo = newRepo();
    repo.commit('Initial', { 'a.txt': 'a\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('Fix lint', { 'b.txt': 'b\n' });
    const c2 = repo.commit('Feature', { 'c.txt': 'c\n' });
    repo.commit('Fix lint', { 'd.txt': 'd\n' });
    const name = `left-${++stackSeq}`;
    const [l1] = await stack(repo, name);
    await addThread(l1, { body: 'about the first lint fix' });
    // `from:` moves past it: the second "Fix lint" is now unique in the range, but must not get those comments
    const cfg = { name, path: repo.dir, branch: 'feature', from: c2 };
    const info = await S.loadRepo(cfg);
    const [, l3] = info.commits.map((c) => contextFor(path.join(REVIEWS, name), cfg, info, c));
    assert.equal((await R.loadReview(l3)).file, null);
    await addThread(l3, { body: 'second' });
    assert.ok(fs.existsSync(file(l1)), "the first commit's file is left where it is");
    // a file from a different repo (unknown sha, other repo_path) with the same subject is not matched either
    const other = 'c'.repeat(40);
    const [, , m3] = await stack(repo, `${name}-b`);
    fs.mkdirSync(m3.dir, { recursive: true });
    fs.writeFileSync(R.reviewPath(m3.dir, other), YAML.stringify({ repo_path: '/somewhere/else', commit: other, subject: 'Feature', threads: [{ comments: ['other repo'] }] }));
    const [, m2] = await stack(repo, `${name}-b`);
    assert.equal((await R.loadReview(m2)).file, null);
  });

  test('Change-Id trailer matches when subject and patch both changed', async () => {
    const repo = newRepo();
    repo.commit('Initial', { 'a.txt': 'a\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('First try\n\nChange-Id: I1234567890abcdef', { 'b.txt': 'b\n' });
    const name = `cid-${++stackSeq}`;
    const [c1] = await stack(repo, name);
    assert.equal(c1.changeId, 'I1234567890abcdef');
    await addThread(c1, { body: 'x' });
    assert.equal(readDoc(file(c1)).change_id, 'I1234567890abcdef');
    repo.write('b.txt', 'b2\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '--amend', '-m', 'Second try, renamed\n\nChange-Id: I1234567890abcdef');
    const [n1] = await stack(repo, name);
    const l = await R.loadReview(n1);
    assert.equal(l.matchedFrom, c1.sha);
    assert.equal(l.matchedBy, 'change-id');
  });

  test('renames: a real rename in the diff, and a newly added file renamed by a fixup', async () => {
    const repo = parserRepo();
    // add a commit that modifies util.ts so a later rename shows as a rename in its diff
    repo.commit('Tweak util', { 'src/util.ts': repo.read('src/util.ts').replace('u5 = 5', 'u5 = 50 // tweaked') });
    const name = `ren-${++stackSeq}`;
    const [p1, , u1] = await stack(repo, name);
    const tp = (await addThread(p1, { path: 'src/parser.ts', line: 10, body: 'parser' })).threads[0].id;
    const tu = (await addThread(u1, { path: 'src/util.ts', line: 5, body: 'util' })).threads[0].id;

    repo.fixup(p1.sha, () => repo.git('mv', 'src/parser.ts', 'src/lexer.ts'));
    repo.git('mv', 'src/util.ts', 'src/helpers.ts');
    repo.git('commit', '-q', '--amend', '--no-edit'); // amend the tip: "Tweak util" now also renames
    const [n1, , m1] = await stack(repo, name);

    const lu = await R.viewReview(m1);
    assert.equal(lu.matchedBy, 'subject');
    const u = lu.review.threads.find((t) => t.id === tu)!;
    assert.deepEqual([u.path, u.line, u.outdated], ['src/helpers.ts', 5, undefined]);

    const lp = await R.viewReview(n1);
    const p = lp.review.threads.find((t) => t.id === tp)!;
    assert.deepEqual([p.path, p.line, p.outdated], ['src/lexer.ts', 10, undefined]);
  });

  test('a deleted line makes the thread outdated, and it is kept (with its anchor) on write', async () => {
    const repo = parserRepo();
    const name = `del-${++stackSeq}`;
    const [c1] = await stack(repo, name);
    const tid = (await addThread(c1, { path: 'src/parser.ts', line: 10, body: 'this line is wrong' })).threads[0].id;
    repo.fixup(c1.sha, () => repo.write('src/parser.ts', PARSER.replace('  return tokens.filter(Boolean); // target\n', '')));
    const [n1] = await stack(repo, name);
    const l = await R.viewReview(n1);
    const t = l.review.threads.find((x) => x.id === tid)!;
    assert.equal(t.outdated, true);
    assert.equal(t.anchor!.text, '  return tokens.filter(Boolean); // target');
    await reply(n1, tid, 'removed it');
    const saved = readDoc(file(n1)).threads.find((x: any) => x.id === tid);
    assert.equal(saved.outdated, true);
    assert.equal(saved.comments.length, 2);
    assert.equal(saved.anchor.commit, c1.sha);
  });

  test('a file dropped from the commit makes its threads outdated', async () => {
    const repo = parserRepo();
    const name = `gone-${++stackSeq}`;
    const [, c2] = await stack(repo, name);
    const tid = (await addThread(c2, { path: 'README.md', line: 2, body: 'wording' })).threads[0].id;
    // amend the tip so it no longer touches README.md but keeps its subject
    repo.git('checkout', '-q', 'HEAD~1', '--', 'README.md');
    repo.write('notes.txt', 'n\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '--amend', '--no-edit');
    const [, n2] = await stack(repo, name);
    const t = (await R.viewReview(n2)).review.threads.find((x) => x.id === tid)!;
    assert.equal(t.outdated, true);
  });

  test('hand-written threads without an anchor get one on the first server write', async () => {
    const repo = parserRepo();
    const name = `hand-${++stackSeq}`;
    const [c1] = await stack(repo, name);
    const f = file(c1);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `threads:\n  - path: src/parser.ts\n    line: 10\n    comments:\n      - author: claude\n        body: agent-written\n`);
    const v = await R.viewReview(c1);
    assert.equal(v.review.threads[0].anchor?.text, '  return tokens.filter(Boolean); // target', 'computed for display too');
    await R.mutateReview(c1, (r) => r.viewed.push('src/parser.ts'));
    const t = readDoc(f).threads[0];
    assert.equal(t.anchor.commit, c1.sha);
    assert.equal(t.anchor.line, 10);
    assert.equal(t.anchor.text, '  return tokens.filter(Boolean); // target');
    assert.equal(t.side, 'right');
  });

  test('an anchor-less thread carried over from a rebased commit is anchored on the old commit, then relocated', async () => {
    const repo = parserRepo();
    const name = `handold-${++stackSeq}`;
    const [c1] = await stack(repo, name);
    const f = file(c1);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, YAML.stringify({ commit: c1.sha, subject: 'Add parser', threads: [{ path: 'src/parser.ts', line: 10, comments: [{ author: 'claude', body: 'x' }] }] }));
    repo.fixup(c1.sha, () => repo.write('src/parser.ts', '// a\n// b\n' + PARSER));
    const [n1] = await stack(repo, name);
    const t = (await R.viewReview(n1)).review.threads[0];
    assert.equal(t.line, 12);
    assert.equal(t.anchor!.commit, c1.sha);
  });
});
