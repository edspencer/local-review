// The Comments tab (stack and project pages): every thread across a project's or a stack's PRs (server/threads.ts,
// GET /api/projects/:p/threads), in its order: open threads first, then the most recently updated (shared/threads.ts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Repo, lines, tmpDir } from './fixture.ts';
import { entryKey, isOpen, lastUpdate, openCount, orderThreads, sortKey } from '../shared/threads.ts';

const HOME = tmpDir('lr-test-home-');
const PROJECTS = tmpDir('lr-test-projects-');
process.env.LOCAL_REVIEW_HOME = HOME;
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const P = await import('../server/projects.ts');
const T = await import('../server/threads.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the order (pure)
type C = { created?: string | null; edited?: string | null };
const entry = (id: string, resolved: boolean, comments: C[], repo = 'r', sha = 'a') => ({ repo, sha, thread: { id, resolved, comments } });

describe('last update', () => {
  test('the newest comment or reply, written or edited', () => {
    assert.equal(lastUpdate({ id: 't', resolved: false, comments: [{ created: '2026-10-01T10:00:00Z' }, { created: '2026-10-02T10:00:00Z' }] }), Date.parse('2026-10-02T10:00:00Z'));
    assert.equal(lastUpdate({ id: 't', resolved: false, comments: [{ created: '2026-10-01T10:00:00Z', edited: '2026-10-05T09:00:00Z' }, { created: '2026-10-02T10:00:00Z' }] }), Date.parse('2026-10-05T09:00:00Z'));
  });
  test('compared as times, whatever offset an agent wrote', () => {
    const a = { id: 'a', resolved: false, comments: [{ created: '2026-10-01T12:00:00+02:00' }] }; // 10:00Z
    const b = { id: 'b', resolved: false, comments: [{ created: '2026-10-01T11:00:00Z' }] };
    assert.ok(lastUpdate(b) > lastUpdate(a));
  });
  test('no times, or unparseable ones: 0', () => {
    assert.equal(lastUpdate({ id: 't', resolved: false, comments: [{ created: null }, { created: 'yesterday' }, {}] }), 0);
  });
});

describe('the order', () => {
  test('open threads first, then newest update first', () => {
    const es = [
      entry('old-open', false, [{ created: '2026-10-01T10:00:00Z' }]),
      entry('new-resolved', true, [{ created: '2026-10-09T10:00:00Z' }]),
      entry('new-open', false, [{ created: '2026-10-03T10:00:00Z' }]),
      entry('old-resolved', true, [{ created: '2026-09-01T10:00:00Z' }]),
      entry('replied-open', false, [{ created: '2026-09-20T10:00:00Z' }, { created: '2026-10-05T10:00:00Z' }]),
    ];
    assert.deepEqual(orderThreads(es).map((e) => e.thread.id), ['replied-open', 'new-open', 'old-open', 'new-resolved', 'old-resolved']);
  });
  test('ties and threads without times keep the order they came in (sidebar order), after timed ones', () => {
    const es = [
      entry('x', false, [{}]),
      entry('y', false, [{ created: '2026-10-01T10:00:00Z' }]),
      entry('z', false, [{}]),
      entry('w', false, [{ created: '2026-10-01T10:00:00Z' }]),
    ];
    assert.deepEqual(orderThreads(es).map((e) => e.thread.id), ['y', 'w', 'x', 'z']);
  });
  test('a held thread sorts by its earlier key: resolved or replied to from the tab, it stays put', () => {
    const a = entry('a', false, [{ created: '2026-10-03T10:00:00Z' }]);
    const b = entry('b', false, [{ created: '2026-10-02T10:00:00Z' }]);
    const c = entry('c', false, [{ created: '2026-10-01T10:00:00Z' }]);
    const held = new Map([[entryKey(b), sortKey(b.thread)]]);
    // b resolved: without holding it drops to the bottom, held it stays second
    const bResolved = { ...b, thread: { ...b.thread, resolved: true } };
    assert.deepEqual(orderThreads([a, bResolved, c]).map((e) => e.thread.id), ['a', 'c', 'b']);
    assert.deepEqual(orderThreads([a, bResolved, c], held).map((e) => e.thread.id), ['a', 'b', 'c']);
    // c replied to: without holding it jumps to the top, held it stays last
    const cReplied = { ...c, thread: { ...c.thread, comments: [...c.thread.comments, { created: '2026-10-09T10:00:00Z' }] } };
    assert.deepEqual(orderThreads([a, b, cReplied]).map((e) => e.thread.id), ['c', 'a', 'b']);
    assert.deepEqual(orderThreads([a, b, cReplied], new Map([[entryKey(c), sortKey(c.thread)]])).map((e) => e.thread.id), ['a', 'b', 'c']);
  });
  test('keys are per PR: the same thread id on two PRs is two threads', () => {
    assert.notEqual(entryKey(entry('t-auto0', false, [], 'r', 'a')), entryKey(entry('t-auto0', false, [], 'r', 'b')));
    assert.notEqual(entryKey(entry('t-auto0', false, [], 'r', 'a')), entryKey(entry('t-auto0', false, [], 's', 'a')));
  });
  test('open: unresolved with a comment; the counter counts those', () => {
    assert.equal(isOpen({ id: 't', resolved: false, comments: [{}] }), true);
    assert.equal(isOpen({ id: 't', resolved: true, comments: [{}] }), false);
    assert.equal(isOpen({ id: 't', resolved: false, comments: [] }), false);
    assert.equal(openCount([entry('a', false, [{}]), entry('b', true, [{}]), entry('c', false, [])]), 1);
  });
});

// ---------------------------------------------------------------- collecting them (server)
function writeProject(slug: string, doc: unknown) {
  fs.mkdirSync(path.join(PROJECTS, slug), { recursive: true });
  fs.writeFileSync(path.join(PROJECTS, slug, 'project.yaml'), YAML.stringify(doc));
}
function writeReview(slug: string, repo: string, sha: string, doc: unknown) {
  const dir = path.join(PROJECTS, slug, 'reviews', repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sha}.yaml`), typeof doc === 'string' ? doc : YAML.stringify(doc));
}

/**
 * Two repos. `api`: main + feature with four commits in two stacks (One: a, b; Two: c, d). `web`: one commit, no
 * stacks. Reviews: a general thread on a (resolved), an inline one on b (open, replied to later), an empty thread
 * and an inline one whose line is gone on c, an invalid file on d, and a general thread on web's commit.
 */
function world() {
  const api = Repo.create();
  repos.push(api);
  api.commit('Initial', { 'README.md': 'x\n' });
  api.git('checkout', '-q', '-b', 'feature');
  const a = api.commit('Add parser', { 'parse.ts': lines(10, (i) => `line ${i}`) });
  const b = api.commit('Use parser', { 'use.ts': lines(10, (i) => `use ${i}`) });
  const c = api.commit('Docs', { 'docs.md': lines(5, (i) => `doc ${i}`) });
  const d = api.commit('More docs', { 'more.md': 'more\n' });
  const web = Repo.create();
  repos.push(web);
  web.commit('Initial', { 'index.html': '<p>\n' });
  web.git('checkout', '-q', '-b', 'feature');
  const w = web.commit('Page', { 'page.html': '<p>page</p>\n' });
  writeProject('comments', {
    title: 'Comments',
    repos: [
      { path: api.dir, branch: 'feature', base: 'main', name: 'api', stacks: [{ title: 'One', starts_at: 'Add parser' }, { title: 'Two', starts_at: 'Docs' }] },
      { path: web.dir, branch: 'feature', base: 'main', name: 'web' },
    ],
  });
  const comment = (id: string, created: string, body = 'hi', author = 'maya') => ({ id, author, created, body });
  writeReview('comments', 'api', a, { threads: [{ id: 't-general', resolved: true, comments: [comment('c1', '2026-10-01T10:00:00Z')] }] });
  writeReview('comments', 'api', b, {
    threads: [{ id: 't-inline', path: 'use.ts', side: 'right', line: 4, resolved: false, comments: [comment('c2', '2026-10-02T10:00:00Z'), comment('c3', '2026-10-06T10:00:00Z', 'done', 'claude')] }],
  });
  writeReview('comments', 'api', c, {
    threads: [
      { id: 't-empty', resolved: false, comments: [] },
      {
        id: 't-gone',
        path: 'docs.md',
        side: 'right',
        line: 2,
        resolved: false,
        // made on another commit, on text this one doesn't have: outdated here
        anchor: { commit: a, path: 'docs.md', side: 'right', line: 2, text: 'something else entirely' },
        comments: [comment('c4', '2026-10-03T10:00:00Z')],
      },
    ],
  });
  writeReview('comments', 'api', d, 'threads: [this is: not valid\n');
  writeReview('comments', 'web', w, { threads: [{ id: 't-web', resolved: false, comments: [comment('c5', '2026-10-04T10:00:00Z')] }] });
  return { api, web, a, b, c, d, w };
}

describe('collecting the threads', () => {
  let x: ReturnType<typeof world>;
  before(() => { x = world(); });

  test('the project: every repo and stack, open first, then newest; empty threads left out; bad files reported', async () => {
    const p = (await P.loadProject('comments'))!;
    const { threads, problems } = await T.collectThreads(p);
    assert.deepEqual(threads.map((e) => [e.repo, e.thread.id]), [
      ['api', 't-inline'], // open, last reply 10-06
      ['web', 't-web'], // open, 10-04
      ['api', 't-gone'], // open, 10-03
      ['api', 't-general'], // resolved
    ]);
    const inline = threads[0];
    assert.equal(inline.sha, x.b);
    assert.equal(inline.position, 2);
    assert.equal(inline.updated, '2026-10-06T10:00:00.000Z');
    assert.equal(inline.thread.comments.length, 2);
    assert.equal(inline.thread.outdated, undefined);
    assert.equal(inline.thread.anchor?.text, 'use 4', 'placed: anchored on the line it is on');
    assert.equal(threads[2].thread.outdated, true, 'its text is not on its commit: outdated');
    assert.deepEqual(problems.map((pr) => [pr.repo, pr.sha]), [['api', x.d]]);
    assert.match(problems[0].file, /reviews\/api\/[0-9a-f]{40}\.yaml$/);
  });

  test('one stack: only its PRs', async () => {
    const p = (await P.loadProject('comments'))!;
    const one = await T.collectThreads(p, { repo: 'api', shas: p.repos[0].stacks.find((g) => g.title === 'One')!.shas });
    assert.deepEqual(one.threads.map((e) => e.thread.id), ['t-inline', 't-general']);
    assert.deepEqual(one.problems, []);
    const two = await T.collectThreads(p, { repo: 'api', shas: p.repos[0].stacks.find((g) => g.title === 'Two')!.shas });
    assert.deepEqual(two.threads.map((e) => e.thread.id), ['t-gone']);
    assert.equal(two.problems.length, 1);
  });

  test('one repo', async () => {
    const p = (await P.loadProject('comments'))!;
    assert.deepEqual((await T.collectThreads(p, { repo: 'web' })).threads.map((e) => e.thread.id), ['t-web']);
  });

  test('follows the files: a new reply re-sorts, and a review carried over after a rebase is still listed', async () => {
    writeReview('comments', 'api', x.a, { threads: [{ id: 't-general', resolved: false, comments: [{ id: 'c1', author: 'maya', created: '2026-10-01T10:00:00Z', body: 'hi' }, { id: 'c9', author: 'claude', created: '2026-10-08T10:00:00Z', body: 'fixed' }] }] });
    let p = (await P.loadProject('comments'))!;
    assert.deepEqual((await T.collectThreads(p)).threads.map((e) => e.thread.id), ['t-general', 't-inline', 't-web', 't-gone']);

    // reword "Use parser" (b): its review file stays under the old sha, and is carried over to the new commit
    x.api.git('checkout', '-q', 'feature~2');
    x.api.git('commit', '-q', '--amend', '-m', 'Use the parser');
    const newB = x.api.git('rev-parse', 'HEAD');
    x.api.git('cherry-pick', x.c, x.d);
    x.api.git('branch', '-f', 'feature', 'HEAD');
    x.api.git('checkout', '-q', 'feature');
    p = (await P.loadProject('comments'))!;
    const moved = (await T.collectThreads(p)).threads.find((e) => e.thread.id === 't-inline')!;
    assert.ok(moved, 'still listed after the rebase');
    assert.equal(moved.sha, newB, 'on the new commit');
  });
});

// ---------------------------------------------------------------- the endpoint
describe('GET /api/projects/:p/threads', () => {
  let server: ChildProcess;
  let port = 0;
  before(async () => {
    world(); // a fresh copy (overwrites the project): the tests above may have rebased theirs
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
  const get = (q: string) => fetch(`http://127.0.0.1:${port}/api/projects/comments/threads${q}`);

  test('the project, a repo, a stack by its ref', async () => {
    const all = await (await get('')).json();
    assert.deepEqual(all.threads.map((e: any) => e.thread.id), ['t-inline', 't-web', 't-gone', 't-general']);
    assert.equal(all.problems.length, 1);
    assert.deepEqual((await (await get('?repo=web')).json()).threads.map((e: any) => e.thread.id), ['t-web']);
    assert.deepEqual((await (await get('?repo=api&stack=1-one')).json()).threads.map((e: any) => e.thread.id), ['t-inline', 't-general']);
    assert.deepEqual((await (await get('?repo=api&stack=2')).json()).threads.map((e: any) => e.thread.id), ['t-gone']);
  });

  test('bad and unknown scopes', async () => {
    assert.equal((await get('?stack=1')).status, 400, 'a stack needs its repo');
    assert.equal((await get('?repo=nope')).status, 404);
    assert.equal((await get('?repo=api&stack=9')).status, 404);
    assert.equal((await get('?repo=api&stack=..')).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects/nope/threads`)).status, 404);
  });

  test('localhost only, like the rest of the API', async () => {
    // (fetch won't send another Host: node:http will)
    const status = await new Promise<number>((res, rej) =>
      http.get({ host: '127.0.0.1', port, path: '/api/projects/comments/threads', headers: { host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode!); }).on('error', rej),
    );
    assert.equal(status, 403);
  });

  test('read-only: no file is written', async () => {
    const dir = path.join(PROJECTS, 'comments', 'reviews');
    const snap = () => fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
      const full = path.join(dir, String(f));
      return fs.statSync(full).isFile() ? `${f}:${fs.statSync(full).mtimeMs}` : String(f);
    });
    const before = snap();
    await get('');
    await get('?repo=api&stack=2');
    assert.deepEqual(snap(), before);
  });
});
