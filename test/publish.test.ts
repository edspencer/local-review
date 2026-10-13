// Threads marked for the real GitHub PR (`publish: true`, and the agent's `published:` record once it has posted
// one): the YAML round trip, what counts as open, the plan's `publish_threads`, and the endpoints that set them.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Repo, lines, tmpDir } from './fixture.ts';
import { isOpen, openCount, toPublish } from '../shared/threads.ts';
import { progressOf } from '../shared/readiness.ts';

const HOME = tmpDir('lr-test-home-');
const PROJECTS = tmpDir('lr-test-projects-');
process.env.LOCAL_REVIEW_HOME = HOME;
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const R = await import('../server/reviews.ts');
const P = await import('../server/projects.ts');
const PL = await import('../server/plan.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

const CTX = { repo: 'r', dir: '/nowhere', repoPath: '/nowhere', branch: 'feature', sha: 'a'.repeat(40), subject: 'S', getPatchId: async () => null };
const roundTrip = (doc: unknown) => YAML.parse(R.toYaml(R.normalize(doc, CTX)));

// ---------------------------------------------------------------- the YAML
describe('publish: in the comment YAML', () => {
  test('kept through a read and a write, after resolved:, and absent when it was', () => {
    const out = roundTrip({
      threads: [
        { id: 't1', path: 'a.ts', side: 'right', line: 3, resolved: false, publish: true, comments: [{ id: 'c1', author: 'ada', body: 'For the team.' }] },
        { id: 't2', resolved: false, comments: [{ id: 'c2', author: 'ada', body: 'Local only.' }] },
      ],
    });
    assert.equal(out.threads[0].publish, true);
    assert.deepEqual(Object.keys(out.threads[0]).slice(0, 6), ['id', 'path', 'side', 'line', 'resolved', 'publish']);
    assert.equal('publish' in out.threads[1], false, 'nothing added to threads that had none');
    assert.equal('published' in out.threads[1], false);
  });

  test('tolerant: "true" counts, false and anything else are dropped', () => {
    const r = R.normalize({ threads: [{ id: 'a', publish: 'true', comments: ['x'] }, { id: 'b', publish: false, comments: ['x'] }, { id: 'c', publish: 'yes', comments: ['x'] }] }, CTX);
    assert.deepEqual(r.threads.map((t) => t.publish), [true, undefined, undefined]);
  });

  test('published: the agent\'s record is kept as written (extra keys too); a bare URL becomes {url}', () => {
    const out = roundTrip({
      threads: [
        { id: 'a', resolved: false, publish: true, published: { url: 'https://github.com/o/r/pull/12#discussion_r1', id: 1, at: '2026-10-13T12:00:00Z', review: 99 }, comments: ['x'] },
        { id: 'b', resolved: false, publish: true, published: 'https://github.com/o/r/pull/12#discussion_r2', comments: ['x'] },
        { id: 'c', resolved: false, publish: true, published: ['odd'], comments: ['x'] }, // not ours to fix: kept
      ],
    });
    assert.deepEqual(out.threads[0].published, { url: 'https://github.com/o/r/pull/12#discussion_r1', id: 1, at: '2026-10-13T12:00:00Z', review: 99 });
    assert.deepEqual(out.threads[1].published, { url: 'https://github.com/o/r/pull/12#discussion_r2' });
    assert.deepEqual(out.threads[2].published, ['odd']);
  });

  test('not open, not in progress; to publish until published', () => {
    const local = { id: 'l', resolved: false, comments: [{}] };
    const gh = { id: 'g', resolved: false, publish: true, comments: [{}] };
    const posted = { ...gh, published: { url: 'https://x' } };
    assert.equal(isOpen(local), true);
    assert.equal(isOpen(gh), false, "the agent doesn't answer it: not open");
    assert.equal(openCount([{ thread: local }, { thread: gh }]), 1);
    assert.deepEqual([toPublish(local), toPublish(gh), toPublish(posted), toPublish({ ...gh, comments: [] })], [false, true, false, false]);
    assert.deepEqual(progressOf([local, gh], ['f'], []), { threads: 1, resolved: 0, files: 1, viewed: 0 });
    assert.equal(R.unresolvedCount(R.normalize({ threads: [local, gh] }, CTX)), 1);
  });
});

// ---------------------------------------------------------------- a project to plan and serve
function writeReview(slug: string, sha: string, doc: unknown) {
  const dir = path.join(PROJECTS, slug, 'reviews', 'r');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sha}.yaml`), YAML.stringify(doc));
}

/** Two PRs: A (a draft) with inline, file, general, outdated and posted threads marked; B published, with one unposted. */
function world(slug: string) {
  const r = Repo.create();
  repos.push(r);
  r.commit('Initial', { 'README.md': 'x\n' });
  r.git('checkout', '-q', '-b', 'feature');
  const a = r.commit('Add parser', { 'parse.ts': lines(10, (i) => `line ${i}`) });
  const b = r.commit('Use parser', { 'use.ts': lines(10, (i) => `use ${i}`) });
  fs.mkdirSync(path.join(PROJECTS, slug, 'prs', 'r'), { recursive: true });
  fs.writeFileSync(path.join(PROJECTS, slug, 'project.yaml'), YAML.stringify({ title: 'Publish', repos: [{ name: 'r', path: r.dir, branch: 'feature', base: 'main' }] }));
  fs.writeFileSync(path.join(PROJECTS, slug, 'prs', 'r', `${b}.yaml`), 'branch: me/use\ngithub:\n  number: 12\n  url: https://github.com/o/r/pull/12\n');
  const c = (id: string, body: string, author = 'ada') => ({ id, author, created: '2026-10-13T10:00:00Z', body });
  writeReview(slug, a, {
    threads: [
      { id: 't-inline', path: 'parse.ts', side: 'right', start_line: 2, line: 4, resolved: false, publish: true, comments: [c('c1', 'Why a loop here?'), c('c2', 'See ![x](assets/0123456789abcdef.png)')] },
      { id: 't-file', path: 'parse.ts', resolved: false, publish: true, comments: [c('c3', 'This whole file needs a header.')] },
      { id: 't-general', resolved: false, publish: true, comments: [c('c4', 'Overall: nice.')] },
      { id: 't-gone', path: 'parse.ts', side: 'right', line: 2, resolved: false, publish: true, anchor: { commit: b, path: 'parse.ts', side: 'right', line: 2, text: 'not in the file' }, comments: [c('c5', 'Gone now.')] },
      { id: 't-posted', resolved: true, publish: true, published: { url: 'https://github.com/o/r/pull/1#issuecomment-1' }, comments: [c('c6', 'Already up.')] },
      { id: 't-local', path: 'parse.ts', side: 'right', line: 5, resolved: false, comments: [c('c7', 'Just for Claude.')] },
      { id: 't-empty', resolved: false, publish: true, comments: [] },
    ],
  });
  writeReview(slug, b, { threads: [{ id: 't-b', path: 'use.ts', side: 'left', line: 3, resolved: false, publish: true, comments: [c('c8', 'Old side.')] }] });
  return { r, a, b };
}

describe('the plan: publish_threads', () => {
  let x: ReturnType<typeof world>;
  before(() => { x = world('plan'); });

  test('each PR lists its marked threads, with file and line, in file order; local and empty ones left out', async () => {
    const plan = await PL.buildPlan((await P.loadProject('plan'))!);
    const [pa, pb] = plan.prs;
    assert.deepEqual(pa.publish_threads.map((t) => t.id), ['t-inline', 't-file', 't-general', 't-gone', 't-posted']);
    const inline = pa.publish_threads[0];
    assert.deepEqual({ path: inline.path, line: inline.line, side: inline.side, start_line: inline.start_line, start_side: inline.start_side, outdated: inline.outdated }, { path: 'parse.ts', line: 4, side: 'right', start_line: 2, start_side: 'right', outdated: false });
    assert.deepEqual(inline.comments.map((c) => [c.id, c.author, c.body]), [['c1', 'ada', 'Why a loop here?'], ['c2', 'ada', 'See ![x](assets/0123456789abcdef.png)']]);
    assert.equal(inline.published, null);
    const file = pa.publish_threads[1];
    assert.deepEqual([file.path, file.line, file.side], ['parse.ts', null, null], 'a comment on the whole file');
    const general = pa.publish_threads[2];
    assert.deepEqual([general.path, general.line], [null, null]);
    assert.equal(pa.publish_threads[3].outdated, true);
    assert.deepEqual(pa.publish_threads[4].published, { url: 'https://github.com/o/r/pull/1#issuecomment-1' });
    assert.deepEqual(pb.publish_threads.map((t) => [t.id, t.side, t.line]), [['t-b', 'left', 3]]);
  });

  test('warnings: outdated, an image without a URL, and a published PR with comments not posted yet', async () => {
    const plan = await PL.buildPlan((await P.loadProject('plan'))!);
    const [pa, pb] = plan.prs;
    assert.ok(pa.warnings.some((w) => /t-gone \(parse\.ts:2\) is outdated/.test(w)), pa.warnings.join('\n'));
    assert.ok(pa.warnings.some((w) => /assets\/0123456789abcdef\.png in a comment for GitHub/.test(w)), pa.warnings.join('\n'));
    assert.ok(pa.images.some((i) => i.name === '0123456789abcdef.png'));
    assert.ok(!pa.warnings.some((w) => /not posted|aren't posted|isn't posted/.test(w)), 'A has no GitHub PR yet: nothing to warn about');
    assert.ok(pb.warnings.includes("1 comment marked for GitHub isn't posted on PR #12 yet"), pb.warnings.join('\n'));
    assert.ok(plan.warnings.some((w) => /PR #2 .*isn't posted on PR #12 yet/.test(w)));
  });

  test('markdown and JSON from the CLI', async () => {
    const lr = (...args: string[]) =>
      new Promise<string>((res, rej) =>
        execFile(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), ...args], { env: { ...process.env, LOCAL_REVIEW_PROJECTS_DIR: PROJECTS }, cwd: ROOT }, (err, stdout, stderr) => (err ? rej(new Error(stderr)) : res(stdout))),
      );
    const md = await lr('plan', 'plan');
    assert.match(md, /Comments for the GitHub PR \(4 to post, 1 posted\):/);
    assert.match(md, /- Thread `t-inline`, `parse\.ts` lines 2 to 4 \(RIGHT\)/);
    assert.match(md, /- Thread `t-file`, `parse\.ts` \(the whole file\)/);
    assert.match(md, /- Thread `t-general`, general \(the review body\)/);
    assert.match(md, /- Thread `t-gone`, `parse\.ts` line 2 \(RIGHT\) \*\*\(outdated: not in the diff any more\)\*\*/);
    assert.match(md, /- Thread `t-posted`, general \(the review body\): posted https:\/\/github\.com\/o\/r\/pull\/1#issuecomment-1/);
    assert.match(md, /- Thread `t-b`, `use\.ts` line 3 \(LEFT, the old file\)/);
    assert.match(md, /Why a loop here\?/);
    assert.doesNotMatch(md, /Just for Claude/);
    const json = JSON.parse(await lr('plan', 'plan', '--format', 'json'));
    assert.deepEqual(json.prs.map((p: any) => p.publish_threads.length), [5, 1]);
  });

  test('read-only: planning writes nothing', async () => {
    const dir = path.join(PROJECTS, 'plan', 'reviews', 'r');
    const snap = () => fs.readdirSync(dir).map((f) => `${f}:${fs.readFileSync(path.join(dir, f), 'utf8')}`);
    const before = snap();
    await PL.buildPlan((await P.loadProject('plan'))!);
    assert.deepEqual(snap(), before);
  });
});

// ---------------------------------------------------------------- the endpoints
describe('the endpoints', () => {
  let server: ChildProcess;
  let port = 0;
  let x: ReturnType<typeof world>;
  before(async () => {
    x = world('api');
    port = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const pt = (s.address() as net.AddressInfo).port;
        s.close(() => res(pt));
      });
    });
    server = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), 'serve'], {
      env: { ...process.env, PORT: String(port), LOCAL_REVIEW_DEV: '1', LOCAL_REVIEW_HOME: HOME, LOCAL_REVIEW_PROJECTS_DIR: PROJECTS },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
      } catch { /* not up yet */ }
      await new Promise((res) => setTimeout(res, 100));
    }
  });
  after(() => server?.kill());
  const commit = (sha: string) => `http://127.0.0.1:${port}/api/projects/api/repos/r/commits/${sha}`;
  const send = (method: string, url: string, body: unknown) => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const fileDoc = (sha: string) => YAML.parse(fs.readFileSync(path.join(PROJECTS, 'api', 'reviews', 'r', `${sha}.yaml`), 'utf8'));
  const thread = (sha: string, id: string) => fileDoc(sha).threads.find((t: any) => t.id === id);

  test('POST …/threads with publish: true marks the new thread; without it, nothing is written', async () => {
    let res = await send('POST', `${commit(x.b)}/threads`, { body: 'For the team.', path: 'use.ts', line: 2, publish: true, author: 'ada' });
    assert.equal(res.status, 200);
    const made = (await res.json()).threads.at(-1);
    assert.equal(made.publish, true);
    assert.equal(thread(x.b, made.id).publish, true);
    res = await send('POST', `${commit(x.b)}/threads`, { body: 'Local.', author: 'ada' });
    const local = (await res.json()).threads.at(-1);
    assert.equal('publish' in thread(x.b, local.id), false);
    assert.equal((await send('POST', `${commit(x.b)}/threads`, { body: 'x', publish: 'yes' })).status, 400);
  });

  test('PATCH …/threads/:tid sets and clears publish, and records published', async () => {
    assert.equal((await send('PATCH', `${commit(x.a)}/threads/t-local`, { publish: true })).status, 200);
    assert.equal(thread(x.a, 't-local').publish, true);
    assert.equal(thread(x.a, 't-local').resolved, false, 'resolved untouched');
    assert.equal((await send('PATCH', `${commit(x.a)}/threads/t-local`, { publish: false })).status, 200);
    assert.equal('publish' in thread(x.a, 't-local'), false, 'unmarked: the key goes');

    const url = 'https://github.com/o/r/pull/12#discussion_r42';
    assert.equal((await send('PATCH', `${commit(x.a)}/threads/t-inline`, { published: { url, id: 42, at: '2026-10-13T12:00:00Z' } })).status, 200);
    assert.deepEqual(thread(x.a, 't-inline').published, { url, id: 42, at: '2026-10-13T12:00:00Z' });
    assert.equal((await send('PATCH', `${commit(x.a)}/threads/t-file`, { published: { url } })).status, 200);
    assert.match(thread(x.a, 't-file').published.at, /^\d{4}-\d\d-\d\dT/, 'at defaults to now');
    assert.equal((await send('PATCH', `${commit(x.a)}/threads/t-file`, { published: null })).status, 200);
    assert.equal('published' in thread(x.a, 't-file'), false);
  });

  test('bad values: 400, and the file is unchanged', async () => {
    const before = fs.readFileSync(path.join(PROJECTS, 'api', 'reviews', 'r', `${x.a}.yaml`), 'utf8');
    for (const b of [{ publish: 'true' }, { published: 'https://x' }, { published: { url: 'javascript:alert(1)' } }, { published: { url: 'https://x', at: 'soon' } }, { published: { url: 'https://x', id: {} } }])
      assert.equal((await send('PATCH', `${commit(x.a)}/threads/t-general`, b)).status, 400, JSON.stringify(b));
    assert.equal(fs.readFileSync(path.join(PROJECTS, 'api', 'reviews', 'r', `${x.a}.yaml`), 'utf8'), before);
    assert.equal((await send('PATCH', `${commit(x.a)}/threads/nope`, { publish: true })).status, 404);
  });

  test('the project and the Comments tab: marked threads come through, and aren\'t counted as open', async () => {
    const p = await (await fetch(`http://127.0.0.1:${port}/api/projects/api`)).json();
    const a = p.repos[0].commits[0];
    assert.equal(a.unresolved, 1, 't-local only (t-empty has no comments)');
    assert.equal(a.progress.threads, 1);
    const tab = await (await fetch(`http://127.0.0.1:${port}/api/projects/api/threads`)).json();
    const marked = tab.threads.filter((e: any) => e.thread.publish).map((e: any) => e.thread.id).sort();
    assert.ok(marked.includes('t-inline') && marked.includes('t-b'), marked.join());
    assert.equal(tab.threads.find((e: any) => e.thread.id === 't-inline').thread.published.id, 42);
  });
});
