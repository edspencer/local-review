// Caching (stamps.ts, loadProject, the API's payloads, commit details) must never serve something stale: a loaded
// project is reused only while project.yaml, prs/, reviews/ and the range's git state are unchanged, and the live
// server still pushes (and then serves) every change an agent or a rebase makes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Repo, tmpDir } from './fixture.ts';

const PROJECTS = tmpDir('lr-test-projects-');
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const P = await import('../server/projects.ts');
const S = await import('../server/commits.ts');
const ST = await import('../server/stamps.ts');
const RF = await import('../server/reffiles.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

function writeProject(slug: string, doc: unknown) {
  fs.mkdirSync(path.join(PROJECTS, slug), { recursive: true });
  fs.writeFileSync(path.join(PROJECTS, slug, 'project.yaml'), YAML.stringify(doc));
}

/** main + feature with three commits */
function stackRepo() {
  const repo = newRepo();
  repo.commit('Initial', { 'README.md': 'x\n' });
  repo.git('checkout', '-q', '-b', 'feature');
  const a = repo.commit('Add parser', { 'a.txt': 'a\n' });
  const b = repo.commit('Use parser', { 'b.txt': 'b\n' });
  const c = repo.commit('Docs', { 'c.txt': 'c\n' });
  return { repo, a, b, c };
}

// ---------------------------------------------------------------- loadProject
describe('loadProject cache', () => {
  test('reused while nothing changed; rebuilt on a project.yaml edit, a prs/ change, a new commit or a new branch', async () => {
    const { repo, a, b } = stackRepo();
    const doc = { title: 'Cache', repos: [{ path: repo.dir, branch: 'feature', base: 'main', name: 'r', stacks: [{ title: 'One', starts_at: 'Add parser' }] }] };
    writeProject('cache', doc);
    const p1 = await P.loadProject('cache');
    assert.ok(p1);
    assert.equal(await P.loadProject('cache'), p1, 'nothing changed: the same object');

    // project.yaml: regrouped
    writeProject('cache', { ...doc, repos: [{ ...doc.repos[0], stacks: [{ title: 'One', starts_at: 'Add parser' }, { title: 'Two', starts_at: 'Use parser' }] }] });
    const p2 = (await P.loadProject('cache'))!;
    assert.notEqual(p2, p1);
    assert.deepEqual(p2.repos[0].stacks.map((g) => [g.title, g.shas.length]), [['One', 1], ['Two', 2]]);
    assert.equal(await P.loadProject('cache'), p2);

    // the same text written again (a no-op save) keeps the cache
    writeProject('cache', { ...doc, repos: [{ ...doc.repos[0], stacks: [{ title: 'One', starts_at: 'Add parser' }, { title: 'Two', starts_at: 'Use parser' }] }] });
    assert.equal(await P.loadProject('cache'), p2);

    // a prs file (a stack selector can be a PR title, and landed PRs live there)
    const prs = path.join(PROJECTS, 'cache', 'prs', 'r');
    fs.mkdirSync(prs, { recursive: true });
    fs.writeFileSync(path.join(prs, `${b}.yaml`), YAML.stringify({ commit: b, title: 'The parser, used' }));
    const p3 = (await P.loadProject('cache'))!;
    assert.notEqual(p3, p2);
    assert.equal(await P.loadProject('cache'), p3);

    // the branch moves: a new commit is in the range straight away (no poll running: the ref files are checked every time)
    const d = repo.commit('More docs', { 'd.txt': 'd\n' });
    const p4 = (await P.loadProject('cache'))!;
    assert.notEqual(p4, p3);
    assert.deepEqual(p4.repos[0].info.commits.map((c) => c.sha).slice(0, 1), [a]);
    assert.equal(p4.repos[0].info.commits.at(-1)!.sha, d);

    // a new branch (an agent tagging a commit): the branch index is new
    repo.git('branch', 'me/parser', a);
    const p5 = (await P.loadProject('cache'))!;
    assert.notEqual(p5, p4);
    assert.equal(p5.repos[0].refIndex.byRef.get('refs/heads/me/parser')?.sha, a);
  });

  test('a rebase (rewritten shas) is a new range; the base moving is too', async () => {
    const { repo, a } = stackRepo();
    writeProject('rebase', { repos: [{ path: repo.dir, branch: 'feature', base: 'main', name: 'r' }] });
    const before = (await P.loadProject('rebase'))!;
    repo.git('commit', '-q', '--amend', '-m', 'Docs, reworded');
    const after = (await P.loadProject('rebase'))!;
    assert.notEqual(after, before);
    assert.equal(after.repos[0].info.commits.at(-1)!.subject, 'Docs, reworded');
    // the first commit lands on main: it leaves the range
    repo.git('branch', '-f', 'main', a);
    const landed = (await P.loadProject('rebase'))!;
    assert.deepEqual(landed.repos[0].info.commits.map((c) => c.subject), ['Use parser', 'Docs, reworded']);
  });

  test('with a poll running, requests use its git state until it reads again', async () => {
    const { repo } = stackRepo();
    const cfg = { name: 'r', path: repo.dir, branch: 'feature', base: 'main' };
    writeProject('polled', { repos: [cfg] });
    await ST.repoState(cfg, { fresh: true });
    ST.trustPolled(60_000);
    try {
      const p1 = (await P.loadProject('polled'))!;
      repo.commit('Unseen yet', { 'e.txt': 'e\n' });
      assert.equal(await P.loadProject('polled'), p1, "the poll hasn't run");
      const s = await ST.repoState(cfg, { fresh: true }); // the poll
      assert.equal(s.refs.head, repo.git('rev-parse', 'feature'));
      const p2 = (await P.loadProject('polled'))!;
      assert.equal(p2.repos[0].info.commits.at(-1)!.subject, 'Unseen yet');
    } finally {
      ST.trustPolled(0);
    }
  });

  test('concurrent reads of a range share one git read; a missing repo has a stamp too', async () => {
    const { repo } = stackRepo();
    const cfg = { name: 'r', path: repo.dir, branch: 'feature', base: 'main' };
    const [x, y] = await Promise.all([ST.repoState(cfg), ST.repoState(cfg)]);
    assert.equal(x, y);
    const gone = await ST.repoState({ name: 'g', path: path.join(PROJECTS, 'no-such-repo'), branch: 'x' });
    assert.equal(gone.stamp, 'missing');
  });

  test("the poll doesn't ask git again while the ref files are unchanged, and does once they move", async () => {
    const { repo } = stackRepo();
    const cfg = { name: 'r', path: repo.dir, branch: 'feature', base: 'main' };
    const s1 = await ST.repoState(cfg, { fresh: true });
    repo.write('scratch.txt', 'work in progress\n');
    repo.git('add', 'scratch.txt'); // editing and staging don't touch refs
    assert.equal(await ST.repoState(cfg, { fresh: true }), s1, 'the same state: git not read again');
    assert.equal(await ST.repoState(cfg), s1);
    repo.git('commit', '-q', '-m', 'Scratch');
    const s2 = await ST.repoState(cfg, { fresh: true });
    assert.notEqual(s2, s1);
    assert.equal(s2.refs.head, repo.git('rev-parse', 'feature'));
    assert.equal(await ST.repoState(cfg, { fresh: true }), s2);
  });
});

// ---------------------------------------------------------------- ref files (reffiles.ts)
describe('ref-file stamp', () => {
  test('changes with every kind of ref change, not with edits or staging', () => {
    const { repo, a } = stackRepo();
    let last = RF.refFilesStamp(repo.dir);
    assert.ok(last);
    const changed = (what: string, act: () => void) => {
      act();
      const now = RF.refFilesStamp(repo.dir);
      assert.notEqual(now, last, `${what} should change the stamp`);
      last = now;
    };
    const same = (what: string, act: () => void) => {
      act();
      assert.equal(RF.refFilesStamp(repo.dir), last, `${what} should not change the stamp`);
    };
    same('an edit', () => repo.write('a.txt', 'edited\n'));
    same('staging', () => repo.git('add', 'a.txt'));
    changed('a commit', () => repo.git('commit', '-q', '-m', 'Edit a'));
    changed('an amend', () => repo.git('commit', '-q', '--amend', '-m', 'Edit a, reworded'));
    changed('a new nested branch', () => repo.git('branch', 'me/feat/x', a));
    changed('moving it', () => repo.git('branch', '-f', 'me/feat/x', 'feature'));
    changed('a tag', () => repo.git('tag', 'v1', a));
    changed('a fetch moving a remote-tracking ref', () => repo.git('update-ref', 'refs/remotes/origin/main', a));
    changed('origin/HEAD', () => repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'));
    changed('pack-refs', () => repo.git('pack-refs', '--all'));
    changed('a packed ref moving', () => repo.git('update-ref', 'refs/heads/me/feat/x', a));
    changed('a checkout', () => repo.git('checkout', '-q', 'main'));
    changed('a branch deleted', () => repo.git('branch', '-D', 'me/feat/x'));
    changed('a reset', () => repo.git('reset', '-q', '--hard', a));
  });

  test("a fetch that moves nothing doesn't change it (editors auto-fetch every minute or so); one that moves a branch does", () => {
    const { repo: upstream } = stackRepo();
    const clone = newRepo();
    clone.git('remote', 'add', 'origin', upstream.dir);
    clone.git('fetch', '-q', 'origin');
    clone.git('pack-refs', '--all'); // fetches then rewrite packed-refs too
    const s1 = RF.refFilesStamp(clone.dir);
    for (let i = 0; i < 3; i++) {
      clone.git('fetch', '-q', '--prune', 'origin');
      assert.equal(RF.refFilesStamp(clone.dir), s1, `no-op fetch ${i + 1}`);
    }
    fs.writeFileSync(path.join(clone.dir, '.git', 'refs', 'heads', 'x.lock'), ''); // a write in progress
    assert.equal(RF.refFilesStamp(clone.dir), s1, 'a lock file');
    fs.rmSync(path.join(clone.dir, '.git', 'refs', 'heads', 'x.lock'));
    upstream.commit('Upstream moves');
    clone.git('fetch', '-q', 'origin');
    assert.notEqual(RF.refFilesStamp(clone.dir), s1);
  });

  test('a linked worktree sees the shared refs; a bare repo works; not a repo is null', () => {
    const { repo, a } = stackRepo();
    const wt = path.join(tmpDir('lr-test-wt-'), 'wt');
    repo.git('worktree', 'add', '-q', '-b', 'side', wt, a);
    try {
      const dirs = RF.gitDirs(wt)!;
      assert.equal(fs.realpathSync(dirs.commonDir), fs.realpathSync(path.join(repo.dir, '.git')));
      const s1 = RF.refFilesStamp(wt);
      assert.ok(s1);
      repo.commit('In the main checkout'); // moves `feature`, a ref the worktree shares
      assert.notEqual(RF.refFilesStamp(wt), s1);
      const s2 = RF.refFilesStamp(wt);
      new Repo(wt).commit('In the worktree'); // its own HEAD's branch
      assert.notEqual(RF.refFilesStamp(wt), s2);
    } finally {
      fs.rmSync(path.dirname(wt), { recursive: true, force: true });
    }
    const bare = tmpDir('lr-test-bare-');
    try {
      repo.git('clone', '-q', '--bare', repo.dir, bare);
      assert.ok(RF.refFilesStamp(bare));
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
    assert.equal(RF.refFilesStamp(PROJECTS), null);
    assert.equal(RF.refFilesStamp(path.join(PROJECTS, 'no-such-dir')), null);
  });
});

// ---------------------------------------------------------------- refs and file contents
describe('git reads', () => {
  test('resolveCommits: refs, shas, a tag, and things that are not commits, in one call', async () => {
    const { repo, a } = stackRepo();
    repo.git('tag', 'v1', a);
    const tree = repo.git('rev-parse', 'HEAD^{tree}');
    const got = await S.resolveCommits(repo.dir, ['feature', a, 'v1', 'nope', tree, '--output=/tmp/x', null, 'main~0']);
    assert.deepEqual(got, [repo.git('rev-parse', 'feature'), a, a, null, null, null, null, repo.git('rev-parse', 'main')]);
    assert.deepEqual(await S.resolveCommits(path.join(PROJECTS, 'not-a-repo'), ['main']), [null]);
    assert.deepEqual(await S.resolveRange({ name: 'r', path: repo.dir, branch: 'feature' }), { head: repo.git('rev-parse', 'feature'), from: null, base: { ref: 'main', sha: repo.git('rev-parse', 'main') } });
  });

  test('commit details: text, binary, too large, renamed, deleted, empty, a submodule entry', async () => {
    const repo = newRepo();
    repo.commit('Initial', { 'old.txt': 'one\ntwo\nthree\nfour\nfive\nsix\n', 'gone.txt': 'bye\n', 'same.txt': 'same\n' });
    const big = 'x'.repeat(2 * 1024 * 1024 + 10) + '\n';
    repo.git('mv', 'old.txt', 'new.txt');
    repo.write('new.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    repo.git('rm', '-q', 'gone.txt');
    fs.writeFileSync(path.join(repo.dir, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
    repo.write('big.txt', big);
    repo.write('empty.txt', '');
    repo.write('ünï code.txt', 'héllo\n');
    repo.git('add', '-A');
    // a gitlink (submodule) entry pointing at a commit this repo doesn't have
    repo.git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`);
    repo.git('commit', '-q', '-m', 'Everything at once');
    const d = await S.commitDetail(repo.dir, repo.git('rev-parse', 'HEAD'));
    const by = new Map(d.files.map((f) => [f.path, f]));
    const pick = (p: string) => {
      const f = by.get(p)!;
      return { status: f.status, oldContent: f.oldContent, newContent: f.newContent, binary: f.binary, tooLarge: !!f.tooLarge };
    };
    assert.deepEqual(pick('new.txt'), { status: 'renamed', oldContent: 'one\ntwo\nthree\nfour\nfive\nsix\n', newContent: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', binary: false, tooLarge: false });
    assert.deepEqual(pick('gone.txt'), { status: 'deleted', oldContent: 'bye\n', newContent: null, binary: false, tooLarge: false });
    assert.deepEqual(pick('bin.dat'), { status: 'added', oldContent: null, newContent: null, binary: true, tooLarge: false });
    assert.deepEqual(pick('big.txt'), { status: 'added', oldContent: null, newContent: null, binary: false, tooLarge: true });
    assert.deepEqual(pick('empty.txt'), { status: 'added', oldContent: null, newContent: '', binary: false, tooLarge: false });
    assert.deepEqual(pick('ünï code.txt'), { status: 'added', oldContent: null, newContent: 'héllo\n', binary: false, tooLarge: false });
    assert.equal(pick('sub').binary, true);
    assert.equal(by.has('same.txt'), false);
    // the root commit: no old side at all
    const root = await S.commitDetail(repo.dir, repo.git('rev-list', '--max-parents=0', 'HEAD'));
    assert.deepEqual(root.files.map((f) => [f.path, f.oldContent, f.newContent]).sort(), [['gone.txt', null, 'bye\n'], ['old.txt', null, 'one\ntwo\nthree\nfour\nfive\nsix\n'], ['same.txt', null, 'same\n']]);
  });
});

// ---------------------------------------------------------------- the live server
async function startServer(env: NodeJS.ProcessEnv = {}): Promise<{ server: ChildProcess; port: number }> {
  const port = await new Promise<number>((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
  const server = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), 'serve'], {
    env: { ...process.env, PORT: String(port), LOCAL_REVIEW_DEV: '1', LOCAL_REVIEW_PROJECTS_DIR: PROJECTS, ...env },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return { server, port };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe('live server: the branch poll is quiet', () => {
  // the server's git is a wrapper that logs each call's subcommand, then runs the real git
  const dir = tmpDir('lr-test-gitcount-');
  const log = path.join(dir, 'log');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  let server: ChildProcess;
  let port = 0;
  before(async () => {
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(
      path.join(dir, 'bin', 'git'),
      `#!/bin/sh\nsub=""; skip=""\nfor a in "$@"; do\n  if [ -n "$skip" ]; then skip=""; continue; fi\n  case "$a" in -C|-c) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac\ndone\necho "$sub" >> '${log}'\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(log, '');
    fs.mkdirSync(path.join(dir, 'projects'));
    ({ server, port } = await startServer({
      PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`,
      LOCAL_REVIEW_PROJECTS_DIR: path.join(dir, 'projects'), // just this test's project
    }));
  });
  after(() => {
    server?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // `git config --get user.name` at start isn't the poll
  const launches = () => fs.readFileSync(log, 'utf8').split('\n').filter((s) => s && s !== 'config').length;

  test('no git with no browser connected; one round when one connects; none while idle; git again once a branch moves', async () => {
    const { repo } = stackRepo();
    fs.mkdirSync(path.join(dir, 'projects', 'quiet'));
    fs.writeFileSync(path.join(dir, 'projects', 'quiet', 'project.yaml'), YAML.stringify({ repos: [{ path: repo.dir, branch: 'feature', base: 'main', name: 'r' }] }));
    await sleep(2500); // a poll interval and then some
    assert.equal(launches(), 0, 'nobody listening: no poll');

    const es = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: es.signal });
    const events: any[] = [];
    (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of res.body as any) for (const m of dec.decode(chunk).matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1]));
      } catch { /* aborted */ }
    })();
    try {
      await sleep(1000);
      const first = launches();
      assert.equal(first, 2, 'the first round reads the range once: cat-file and for-each-ref');
      await sleep(2500);
      assert.equal(launches(), first, 'idle rounds: the ref files are unchanged, so no git');

      repo.commit('Moves the branch');
      for (let i = 0; i < 60 && !events.some((e) => e.type === 'project' && e.reason === 'head'); i++) await sleep(100);
      assert.ok(events.some((e) => e.type === 'project' && e.reason === 'head'), 'the new commit is still pushed');
      assert.ok(launches() > first, 'git ran for the change');
    } finally {
      es.abort();
    }
  });
});

describe('live server: changes are pushed and then served fresh', () => {
  let server: ChildProcess;
  let port = 0;
  let r: ReturnType<typeof stackRepo>;
  const events: { at: number; e: any }[] = [];
  let es: AbortController;
  before(async () => {
    r = stackRepo();
    writeProject('live', { title: 'Live', repos: [{ path: r.repo.dir, branch: 'feature', base: 'main', name: 'r', stacks: [{ title: 'One', starts_at: 'Add parser' }] }] });
    ({ server, port } = await startServer());
    // listen to the event stream like the browser does
    es = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: es.signal });
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body as any) {
          buf += dec.decode(chunk);
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (/^event: change$/m.test(block) && data) events.push({ at: Date.now(), e: JSON.parse(data) });
          }
        }
      } catch { /* aborted */ }
    })();
    await api('');
    await new Promise((res) => setTimeout(res, 2500)); // the poll has seen every range once
  });
  after(() => {
    es?.abort();
    server?.kill();
  });

  const api = async (p: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/live${p}`);
    assert.equal(res.status, 200, `${p}: ${res.status}`);
    return res.json();
  };
  /** wait for an event matching `match` after `since`; returns how long it took */
  const waitFor = async (since: number, match: (e: any) => boolean, ms = 6000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((res) => setTimeout(res, 20))) {
      const hit = events.find((x) => x.at >= since && match(x.e));
      if (hit) return hit.at - since;
    }
    throw new Error(`no matching event within ${ms} ms`);
  };

  test('an agent replying in a review file: pushed, and /review and the sidebar serve it', async () => {
    const sha = r.b;
    await api(`/repos/r/commits/${sha}`); // cached on both sides now
    assert.equal((await api('')).repos[0].commits[1].threads, 0);
    const t0 = Date.now();
    const dir = path.join(PROJECTS, 'live', 'reviews', 'r');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sha}.yaml`), YAML.stringify({ commit: sha, threads: [{ id: 't1', comments: [{ author: 'claude', body: 'Done.' }] }] }));
    const took = await waitFor(t0, (e) => e.type === 'review' && e.sha === sha);
    assert.ok(took < 1500, `review event after ${took} ms`);
    assert.equal((await api(`/repos/r/commits/${sha}/review`)).threads[0].comments[0].body, 'Done.');
    assert.equal((await api(`/repos/r/commits/${sha}`)).review.threads.length, 1);
    assert.equal((await api('')).repos[0].commits[1].threads, 1);
  });

  test('a project.yaml edit regroups the stacks', async () => {
    const t0 = Date.now();
    writeProject('live', { title: 'Live', repos: [{ path: r.repo.dir, branch: 'feature', base: 'main', name: 'r', stacks: [{ title: 'One', starts_at: 'Add parser' }, { title: 'Two', starts_at: 'Docs' }] }] });
    await waitFor(t0, (e) => e.type === 'project' && e.reason === 'config');
    assert.deepEqual((await api('')).repos[0].stacks.map((g: any) => [g.title, g.shas.length]), [['One', 2], ['Two', 1]]);
    assert.equal((await api(`/repos/r/commits/${r.c}`)).stack.title, 'Two');
  });

  test('a branch head change refreshes the commit list; a new branch tag shows up', async () => {
    const t0 = Date.now();
    const e = r.repo.commit('Even more', { 'e.txt': 'e\n' });
    const took = await waitFor(t0, (x) => x.type === 'project' && x.reason === 'head');
    assert.ok(took < 3500, `head event after ${took} ms`);
    const p = await api('');
    assert.equal(p.repos[0].commits.at(-1).sha, e);
    assert.equal((await api(`/repos/r/commits/${r.c}`)).next?.sha, e);
    const t1 = Date.now();
    r.repo.git('branch', 'me/docs', r.c);
    await waitFor(t1, (x) => x.type === 'project' && x.reason === 'refs');
    assert.equal((await api('')).repos[0].commits.find((c: any) => c.sha === r.c).branch.name, 'me/docs');
  });

  test('a rebase: the review follows the rewritten commit', async () => {
    const t0 = Date.now();
    // reword "Use parser" (the one with the review) and replay the rest: its sha changes, its patch-id doesn't
    const rest = r.repo.git('rev-list', '--reverse', `${r.b}..feature`).split('\n');
    r.repo.git('reset', '-q', '--hard', r.b);
    r.repo.git('commit', '-q', '--amend', '-m', 'Use the parser');
    for (const sha of rest) r.repo.git('cherry-pick', sha);
    await waitFor(t0, (x) => x.type === 'project' && x.reason === 'head');
    const p = await api('');
    const moved = p.repos[0].commits.find((c: any) => c.subject === 'Use the parser');
    assert.ok(moved && moved.sha !== r.b);
    assert.equal(moved.threads, 1);
    const review = await api(`/repos/r/commits/${moved.sha}/review`);
    assert.deepEqual([review.matched_from, review.matched_by, review.threads[0].comments[0].body], [r.b, 'patch-id', 'Done.']);
  });
});
