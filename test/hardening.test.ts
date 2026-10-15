// Hardening tests: mixed-side ranges (start_side), the read-only git wrapper, path/arg injection through the
// HTTP API, the localhost-only request guard, and "the UI never deletes an agent's words".
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Repo, lines, tmpDir } from './fixture.ts';

// An inherited GIT_DIR must not redirect the server's git calls (git.ts strips GIT_* from its env).
process.env.GIT_DIR = '/nonexistent-git-dir';
const REVIEWS = tmpDir('lr-test-hardening-reviews-');
process.env.LOCAL_REVIEW_PROJECTS_DIR = REVIEWS;
const R = await import('../server/reviews.ts');
const S = await import('../server/commits.ts');
const A = await import('../server/anchors.ts');
const G = await import('../server/git.ts');
const { contextFor } = await import('../server/context.ts');
const { isLocalHost, isLocalOrigin } = await import('../server/security.ts');
delete process.env.GIT_DIR;
type Ctx = import('../server/reviews.ts').ReviewContext;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repos: Repo[] = [];
const dirs: string[] = [REVIEWS];
after(() => {
  for (const r of repos) r.rm();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function newRepo() {
  const r = Repo.create();
  repos.push(r);
  return r;
}

async function stack(repo: Repo, name: string): Promise<Ctx[]> {
  const cfg = { name, path: repo.dir, branch: 'feature', base: 'main' };
  const info = await S.loadRepo(cfg);
  assert.equal(info.error, undefined, String(info.error));
  return info.commits.map((c) => contextFor(path.join(REVIEWS, name), cfg, info, c));
}

// old: 1..20 "line i"; new: lines 8..10 replaced by three new lines
const OLD = lines(20, (i) => `line ${i}`);
const NEW = lines(20, (i) => (i >= 8 && i <= 10 ? `changed ${i}` : `line ${i}`));

function changeRepo() {
  const repo = newRepo();
  repo.commit('Initial', { 'f.txt': OLD });
  repo.git('checkout', '-q', '-b', 'feature');
  repo.commit('Change f', { 'f.txt': NEW });
  return repo;
}

// ---------------------------------------------------------------- start_side
describe('ranges spanning old and new lines (start_side)', () => {
  const files = [{ path: 'f.txt', oldPath: 'f.txt', oldContent: OLD, newContent: NEW }];
  const sha = 'a'.repeat(40);

  test('makeAnchor keeps the start line text on its own side', () => {
    const a = A.makeAnchor(files, sha, { path: 'f.txt', side: 'right', line: 9, start_line: 8, start_side: 'left' })!;
    assert.equal(a.start_side, 'left');
    assert.equal(a.start_line, 8);
    assert.equal(a.start_text, 'line 8');
    assert.equal(a.text, 'changed 9'); // only the end line, on `side`
    assert.equal(A.makeAnchor(files, sha, { path: 'f.txt', side: 'right', line: 9, start_line: 99, start_side: 'left' }), null);
  });

  test('placeThread relocates both ends after lines are inserted above', () => {
    const a = A.makeAnchor(files, sha, { path: 'f.txt', side: 'right', line: 9, start_line: 8, start_side: 'left' })!;
    const shifted = [{ path: 'f.txt', oldPath: 'f.txt', oldContent: 'x\ny\n' + OLD, newContent: 'x\ny\n' + NEW }];
    const p = A.placeThread({ path: 'f.txt', side: 'right', line: 9, start_line: 8, start_side: 'left', anchor: a }, shifted, 'b'.repeat(40));
    assert.deepEqual([p.outdated, p.side, p.line, p.start_side, p.start_line], [false, 'right', 11, 'left', 10]);
  });

  test('if the start line is gone it degrades to a single-line thread', () => {
    const a = A.makeAnchor(files, sha, { path: 'f.txt', side: 'right', line: 9, start_line: 8, start_side: 'left' })!;
    const other = [{ path: 'f.txt', oldPath: 'f.txt', oldContent: OLD.replace('line 8\n', 'gone\n'), newContent: NEW }];
    const p = A.placeThread({ path: 'f.txt', side: 'right', line: 9, start_line: 8, start_side: 'left', anchor: a }, other, 'b'.repeat(40));
    assert.deepEqual([p.outdated, p.line, p.start_line, p.start_side], [false, 9, undefined, undefined]);
  });

  test('stored, re-read and written exactly; same-side start_side is dropped; old files still load', async () => {
    const [ctx] = await stack(changeRepo(), 'mixed');
    await R.mutateReview(ctx, (r) => {
      r.threads.push({ id: 't-mixed', path: 'f.txt', side: 'right', line: 9, start_line: 8, start_side: 'left', resolved: false, comments: [{ id: 'c-1', author: 'ada', created: null, body: 'spans both' }] });
      // start_line > line is fine when the sides differ
      r.threads.push({ id: 't-mixed2', path: 'f.txt', side: 'left', line: 10, start_line: 8, start_side: 'right', resolved: false, comments: [{ id: 'c-2', author: 'ada', created: null, body: 'reverse' }] });
      r.threads.push({ id: 't-same', path: 'f.txt', side: 'right', line: 9, start_line: 8, start_side: 'right', resolved: false, comments: [{ id: 'c-3', author: 'ada', created: null, body: 'same side' }] });
      r.threads.push({ id: 't-old', path: 'f.txt', side: 'right', line: 9, start_line: 8, resolved: false, comments: [{ id: 'c-4', author: 'ada', created: null, body: 'no start_side' }] });
    });
    const doc = YAML.parse(fs.readFileSync(R.reviewPath(ctx.dir, ctx.sha), 'utf8'));
    const by = (id: string) => doc.threads.find((t: any) => t.id === id);
    assert.deepEqual([by('t-mixed').side, by('t-mixed').line, by('t-mixed').start_side, by('t-mixed').start_line], ['right', 9, 'left', 8]);
    assert.equal(by('t-mixed').anchor.start_side, 'left');
    assert.equal(by('t-mixed').anchor.start_text, 'line 8');
    assert.deepEqual([by('t-mixed2').start_side, by('t-mixed2').start_line, by('t-mixed2').line], ['right', 8, 10]);
    assert.equal(by('t-same').start_side, undefined);
    assert.equal(by('t-same').start_line, 8);
    assert.equal(by('t-old').start_side, undefined);
    const v = await R.viewReview(ctx);
    const m = v.review.threads.find((t) => t.id === 't-mixed')!;
    assert.deepEqual([m.outdated, m.start_side, m.start_line, m.line], [undefined, 'left', 8, 9]);
  });
});

// ---------------------------------------------------------------- data loss
describe('odd hand-written files never lose content', () => {
  test('a file whose top level is a list (or threads is a mapping) is refused, not overwritten', async () => {
    const [ctx] = await stack(changeRepo(), 'odd');
    const f = R.reviewPath(ctx.dir, ctx.sha);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    for (const text of ['- author: claude\n  body: a list at the top\n', 'threads:\n  t1:\n    comments: [{author: claude, body: hi}]\n']) {
      fs.writeFileSync(f, text);
      assert.ok((await R.loadReview(ctx)).parseError);
      await assert.rejects(R.mutateReview(ctx, (r) => { r.viewed.push('f.txt'); }), R.ReviewConflictError);
      assert.equal(fs.readFileSync(f, 'utf8'), text);
    }
  });

  test('a bare-string thread and a single-mapping comments field are kept', async () => {
    const [ctx] = await stack(changeRepo(), 'odd2');
    const f = R.reviewPath(ctx.dir, ctx.sha);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'threads:\n  - just a string thread\n  - comments:\n      author: claude\n      body: one comment, not a list\n');
    await R.mutateReview(ctx, (r) => { r.viewed.push('f.txt'); });
    const doc = YAML.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(doc.threads[0].comments[0].body.trim(), 'just a string thread');
    assert.deepEqual([doc.threads[1].comments[0].author, doc.threads[1].comments[0].body.trim()], ['claude', 'one comment, not a list']);
  });
});

// ---------------------------------------------------------------- git wrapper
describe('read-only git wrapper', () => {
  test('refuses write subcommands and writing / program-running options', async () => {
    const repo = changeRepo();
    for (const args of [['commit', '-m', 'x'], ['checkout', 'main'], ['fetch'], ['stash'], ['update-index', '--refresh'], ['status'], ['gc']]) {
      await assert.rejects(G.git(repo.dir, args), /non-read-only/);
    }
    for (const args of [['diff', '--output=/tmp/x'], ['log', '--output', '/tmp/x'], ['diff', '--no-index', 'a', 'b'], ['diff', '--ext-diff'], ['diff', '--textconv'], ['cat-file', '--filters', 'HEAD:f.txt']]) {
      await assert.rejects(G.git(repo.dir, args), /refusing git option/);
    }
    await assert.rejects(G.git('--exec-path=/x', ['log']), /bad repo path/);
    assert.throws(() => G.safeRef('--output=/tmp/x'));
    assert.throws(() => G.safeRef('a..b'));
    assert.throws(() => G.sha40('HEAD'));
  });

  test('a git call that never finishes times out instead of hanging its callers', async () => {
    const repo = changeRepo();
    G.setGitTimeout(0); // fires before any git can exit: stands in for a child stuck in the kernel
    try {
      await assert.rejects(G.git(repo.dir, ['rev-parse', 'HEAD']), /timed out/);
      await assert.rejects(G.gitBuffer(repo.dir, ['show', 'HEAD:f.txt']), /timed out/);
      await assert.rejects(G.gitWithInput(repo.dir, ['cat-file', '--batch-check'], 'HEAD\n'), /timed out/);
    } finally {
      G.setGitTimeout(G.GIT_TIMEOUT_MS);
    }
    assert.match(await G.git(repo.dir, ['rev-parse', 'HEAD']), /^[0-9a-f]{40}\n$/);
  });

  test('reading a stack leaves the repo (.git and work tree) byte-for-byte untouched, even with a dirty index', async () => {
    const repo = changeRepo();
    repo.write('f.txt', 'dirty work tree\n'); // index now stale vs the work tree: a refreshing command would rewrite it
    const snap = () => {
      const out: Record<string, string> = {};
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else {
            const st = fs.statSync(p);
            out[path.relative(repo.dir, p)] = `${st.size}:${st.mtimeMs}:${fs.readFileSync(p).toString('base64').slice(0, 64)}`;
          }
        }
      };
      walk(repo.dir);
      return out;
    };
    const before = snap();
    const [ctx] = await stack(repo, 'ro');
    await S.commitDetail(repo.dir, ctx.sha);
    await S.patchId(repo.dir, ctx.sha);
    assert.deepEqual(snap(), before);
  });
});

// ---------------------------------------------------------------- request guard (pure)
describe('localhost guard', () => {
  test('hosts and origins', () => {
    for (const h of ['localhost', 'localhost:5622', '127.0.0.1:5030', '[::1]:5622']) assert.ok(isLocalHost(h), h);
    for (const h of ['evil.com', 'localhost.evil.com', '127.0.0.1.nip.io:5622', '', undefined]) assert.ok(!isLocalHost(h), String(h));
    assert.ok(isLocalOrigin('http://localhost:5622'));
    assert.ok(!isLocalOrigin('http://evil.com'));
    assert.ok(!isLocalOrigin('null'));
  });
});

// ---------------------------------------------------------------- HTTP API end to end
describe('HTTP API', () => {
  let server: ChildProcess;
  let port = 0;
  let repo: Repo;
  let sha = '';
  const projectsDir = tmpDir('lr-test-http-projects-');
  dirs.push(projectsDir);
  const P = '/api/projects/demo-proj/repos/demo/commits';
  const reviewsDir = path.join(projectsDir, 'demo-proj', 'reviews');
  const prsDir = path.join(projectsDir, 'demo-proj', 'prs');

  function req(method: string, p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const data = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(data !== undefined && typeof opts.body !== 'string' ? { 'content-type': 'application/json' } : {}), ...opts.headers };
      const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => {
          let json: any = null;
          try { json = JSON.parse(s); } catch { json = s; }
          resolve({ status: res.statusCode!, json });
        });
      });
      r.on('error', reject);
      if (data !== undefined) r.write(data);
      r.end();
    });
  }

  before(async () => {
    repo = changeRepo();
    sha = repo.git('rev-parse', 'feature');
    fs.mkdirSync(path.join(projectsDir, 'demo-proj'));
    fs.writeFileSync(
      path.join(projectsDir, 'demo-proj', 'project.yaml'),
      YAML.stringify({
        title: 'Demo project',
        repos: [
          { path: repo.dir, branch: 'feature', base: 'main', name: 'demo', stacks: [{ title: 'Only', color: 'teal', starts_at: 'Change f' }] },
          { path: path.join(projectsDir, 'no-such-repo'), branch: 'x', name: 'missing-repo' },
          { path: repo.dir, branch: 'no-such-branch', base: 'main', name: 'missing-branch' },
          { path: repo.dir, branch: 'feature', base: 'main', name: '../../escape', stacks: [{ title: 'Nope', starts_at: 'No such subject' }] },
        ],
      }),
    );
    port = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    server = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), 'serve'], {
      env: { ...process.env, PORT: String(port), LOCAL_REVIEW_DEV: '1', LOCAL_REVIEW_PROJECTS_DIR: projectsDir, LOCAL_REVIEW_USER: 'Ada Lovelace' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await req('GET', '/api/health')).status === 200) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start');
  });
  after(() => server?.kill());

  test('projects list; missing repo / branch reported per repo; odd repo names sanitised; stack warnings', async () => {
    const list = await req('GET', '/api/projects');
    assert.equal(list.status, 200);
    // paths are absolute (the UI shows them ~-relative, with `home`)
    assert.deepEqual([list.json.projectsDir, list.json.home], [projectsDir, os.homedir()]);
    assert.deepEqual(list.json.projects.map((p: any) => [p.slug, p.title, p.repoCount]), [['demo-proj', 'Demo project', 4]]);
    const r = await req('GET', '/api/projects/demo-proj');
    assert.equal(r.status, 200);
    const by = (n: string) => r.json.repos.find((s: any) => s.name === n);
    assert.match(by('missing-repo').error, /repo not found/);
    assert.match(by('missing-branch').error, /branch 'no-such-branch' not found/);
    assert.equal(by('demo').commits.length, 1);
    assert.deepEqual(by('demo').stacks.map((s: any) => [s.title, s.color, s.shas.length]), [['Only', 'teal', 1]]);
    assert.equal(by('demo').commits[0].stack, 0);
    assert.equal(by('demo').commits[0].position, 1);
    const names = r.json.repos.map((s: any) => s.name);
    assert.ok(names.every((n: string) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(n)), names.join(','));
    // an unresolved selector: a warning, the commit falls into "Unstacked", nothing crashes
    const esc = r.json.repos.find((s: any) => s.name !== 'demo' && !s.error);
    assert.match(esc.warnings[0], /doesn't match any commit/);
    assert.deepEqual(esc.stacks.map((s: any) => [s.title, s.implicit ?? null, s.shas.length]), [['Unstacked', 'unstacked', 1], ['Nope', null, 0]]);
  });

  test('bad shas, traversal and option-looking params are rejected', async () => {
    for (const p of [`${P}/..%2F..%2Fetc`, `${P}/--output=x`, `${P}/HEAD`, `${P}/zzzz`]) assert.equal((await req('GET', p)).status, 400, p);
    assert.equal((await req('GET', `${P}/0000000`)).status, 404);
    for (const p of [
      `/api/projects/demo-proj/repos/..%2F..%2Fx/commits/${sha}`,
      `/api/projects/demo-proj/repos/..%2F..%2Fescape/commits/${sha}`,
      `/api/projects/..%2F..%2Fx/repos/demo/commits/${sha}`,
      `/api/projects/..`,
      `/api/projects/.hidden`,
    ]) assert.equal((await req('GET', p)).status, 404, p);
    const w = await req('POST', `/api/projects/demo-proj/repos/..%2F..%2Fescape/commits/${sha}/threads`, { body: { body: 'x' } });
    assert.equal(w.status, 404);
    const w2 = await req('PUT', `/api/projects/..%2Fdemo-proj/repos/demo/commits/${sha}/pr`, { body: { title: 'x' } });
    assert.equal(w2.status, 404);
    assert.deepEqual(fs.readdirSync(path.dirname(projectsDir)).filter((f) => f === 'escape'), []);
    assert.equal(fs.existsSync(prsDir), false);
  });

  test('/llms.txt: live facts (what /api/projects and /api/me show), URLs for the Host it was reached on; localhost only', async () => {
    const r = await req('GET', '/llms.txt', { headers: { host: `localhost:${port}` } });
    assert.equal(r.status, 200);
    const text: string = r.json;
    assert.match(text, /^# Local Review\n\n> /);
    assert.ok(text.includes(`Projects directory: \`${projectsDir}\``), 'the projects directory');
    assert.ok(text.includes("The reviewer's id: `ada`"), 'the reviewer id (LOCAL_REVIEW_USER)');
    assert.ok(text.includes(`\`demo-proj\`: Demo project, http://localhost:${port}/demo-proj; repos \`demo\` (\`${repo.dir}\`, \`feature\`)`), 'the existing projects');
    assert.ok(text.includes(`curl -s http://localhost:${port}/api/projects/<slug>`), 'URLs on this port');
    assert.ok(!text.includes('localhost:5622'), 'no default-port URLs left');
    const full = await req('GET', '/llms-full.txt');
    assert.equal(full.status, 200);
    assert.ok(full.json.includes('## Handling review threads'), 'llms-full.txt has the whole guide');
    assert.match((await req('GET', '/agent-guide.md')).json, /^# Driving Local Review/);
    for (const p of ['/llms.txt', '/llms-full.txt', '/agent-guide.md']) assert.equal((await req('GET', p, { headers: { host: 'evil.example' } })).status, 403, p);
  });

  test('non-localhost Host, cross-site Origin and non-JSON writes are refused', async () => {
    assert.equal((await req('GET', '/api/projects', { headers: { host: 'evil.example:5622' } })).status, 403);
    const p = `${P}/${sha}/threads`;
    assert.equal((await req('POST', p, { body: { body: 'x' }, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await req('POST', p, { body: '{"body":"x"}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal(fs.existsSync(path.join(reviewsDir, 'demo', `${sha}.yaml`)), false);
    const pr = `${P}/${sha}/pr`;
    assert.equal((await req('PUT', pr, { body: { title: 'x' }, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await req('PUT', pr, { body: '{"title":"x"}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal(fs.existsSync(prsDir), false);
  });

  test('PR title / description overrides: default to the commit, set, clear, tolerate hand edits', async () => {
    const pr = `${P}/${sha}/pr`;
    const c0 = await req('GET', `${P}/${sha}`);
    assert.deepEqual([c0.json.pr.title, c0.json.pr.title_source, c0.json.pr.body_source], ['Change f', 'commit', 'commit']);
    assert.deepEqual([c0.json.stack.title, c0.json.stack.position, c0.json.stack.count], ['Only', 1, 1]);
    assert.equal((await req('PUT', pr, { body: { title: 7 } })).status, 400);
    const s1 = await req('PUT', pr, { body: { title: 'Better title', body: 'Why:\n\n- because' } });
    assert.equal(s1.status, 200, JSON.stringify(s1.json));
    assert.deepEqual([s1.json.title, s1.json.title_source, s1.json.body, s1.json.body_source], ['Better title', 'override', 'Why:\n\n- because', 'override']);
    const file = path.join(prsDir, 'demo', `${sha}.yaml`);
    assert.deepEqual([s1.json.file, s1.json.target_file], [file, file]);
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual([doc.commit, doc.subject, typeof doc.patch_id, typeof doc.updated], [sha, 'Change f', 'string', 'string']);
    assert.match(fs.readFileSync(file, 'utf8'), /body: \|/);
    const list = await req('GET', '/api/projects/demo-proj');
    assert.equal(list.json.repos.find((r: any) => r.name === 'demo').commits[0].title, 'Better title');
    // clearing the title keeps the body; an agent's extra fields survive
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'agent_note: keep me\n');
    const s2 = await req('PUT', pr, { body: { title: null } });
    assert.deepEqual([s2.json.title, s2.json.title_source, s2.json.body_source], ['Change f', 'commit', 'override']);
    assert.equal(YAML.parse(fs.readFileSync(file, 'utf8')).agent_note, 'keep me');
    // a hand-written title that's just the commit subject isn't "edited", on the PR page or in the commit list
    const keep = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, keep + 'title: "Change f "\n');
    assert.equal((await req('GET', pr)).json.title_source, 'commit');
    assert.equal((await req('GET', '/api/projects/demo-proj')).json.repos.find((r: any) => r.name === 'demo').commits[0].title_source, 'commit');
    fs.writeFileSync(file, keep);
    // invalid YAML is never overwritten
    const broken = 'title: [unclosed\n';
    fs.writeFileSync(file, broken);
    assert.equal((await req('PUT', pr, { body: { title: 'x' } })).status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
    fs.writeFileSync(file, `commit: ${sha}\ntitle: Hand-written\ndescription: via the alias\n`);
    const g = await req('GET', pr);
    assert.deepEqual([g.json.title, g.json.body], ['Hand-written', 'via the alias']);
  });

  test('project intro and stack notes: PUT writes into project.yaml, keeps the rest, guarded like other writes', async () => {
    const file = path.join(projectsDir, 'demo-proj', 'project.yaml');
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '# hand comment\n' + before);
    const d = '/api/projects/demo-proj/description';
    assert.equal((await req('PUT', d, { body: { description: 5 } })).status, 400);
    assert.equal((await req('PUT', d, { body: {} })).status, 400);
    assert.equal((await req('PUT', d, { body: { description: 'x' }, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await req('PUT', d, { body: '{"description":"x"}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await req('PUT', '/api/projects/..%2Fx/description', { body: { description: 'x' } })).status, 404);
    const r = await req('PUT', d, { body: { description: 'The *intro*.' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.description, 'The *intro*.\n');
    assert.match(fs.readFileSync(file, 'utf8'), /^# hand comment\n/);
    assert.equal((await req('GET', '/api/projects/demo-proj')).json.description, 'The *intro*.\n');
    const s = '/api/projects/demo-proj/repos/demo/stacks/1/description';
    assert.equal((await req('PUT', '/api/projects/demo-proj/repos/demo/stacks/0/description', { body: { description: 'x' } })).status, 400);
    assert.equal((await req('PUT', '/api/projects/demo-proj/repos/demo/stacks/2/description', { body: { description: 'x' } })).status, 404);
    assert.equal((await req('PUT', '/api/projects/demo-proj/repos/nope/stacks/1/description', { body: { description: 'x' } })).status, 404);
    assert.equal((await req('PUT', s, { body: { description: 'x', title: 'Not it' } })).status, 409);
    const n = await req('PUT', s, { body: { description: 'Stack context', title: 'Only' } });
    assert.equal(n.status, 200, JSON.stringify(n.json));
    const p = await req('GET', '/api/projects/demo-proj');
    const st = p.json.repos.find((x: any) => x.name === 'demo').stacks[0];
    assert.equal(st.description, 'Stack context');
    assert.deepEqual(st.weight, { additions: 3, deletions: 3, prs: 1, files: 1 });
    assert.equal((await req('GET', `${P}/${sha}`)).json.stack.description, 'Stack context');
    // a project.yaml that doesn't parse is left alone
    const broken = fs.readFileSync(file, 'utf8') + 'repos: [unclosed\n';
    fs.writeFileSync(file, broken);
    assert.equal((await req('PUT', d, { body: { description: 'y' } })).status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
    fs.writeFileSync(file, before);
  });

  test('start_side via the API; agent comments cannot be edited or deleted from the UI', async () => {
    const p = `${P}/${sha}`;
    const r = await req('POST', `${p}/threads`, { body: { body: 'mixed', path: 'f.txt', side: 'right', line: 9, start_line: 8, start_side: 'left' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const t = r.json.threads[0];
    assert.deepEqual([t.side, t.line, t.start_side, t.start_line], ['right', 9, 'left', 8]);
    assert.equal((await req('POST', `${p}/threads`, { body: { body: 'x', path: 'f.txt', line: 9, start_side: 'up' } })).status, 400);

    // the agent appends a reply by hand, without id or created
    const file = path.join(reviewsDir, 'demo', `${sha}.yaml`);
    const text = fs.readFileSync(file, 'utf8').trimEnd() + '\n      - author: claude\n        body: agent reply\n';
    fs.writeFileSync(file, text);
    const v = await req('GET', `${p}/review`);
    const thread = v.json.threads[0];
    const agent = thread.comments.find((c: any) => c.author === 'claude');
    assert.ok(agent, JSON.stringify(thread));
    assert.equal((await req('DELETE', `${p}/threads/${thread.id}/comments/${agent.id}`)).status, 403);
    assert.equal((await req('PATCH', `${p}/threads/${thread.id}/comments/${agent.id}`, { body: { body: 'overwritten' } })).status, 403);
    assert.match(fs.readFileSync(file, 'utf8'), /agent reply/);
    // the reviewer's reply is added without losing the agent's
    assert.deepEqual((await req('GET', '/api/me')).json, { id: 'ada', name: 'Ada Lovelace' });
    const replied = await req('POST', `${p}/threads/${thread.id}/comments`, { body: { body: 'thank' } });
    assert.equal(replied.status, 200);
    // and the reviewer's own comments (only theirs) can be edited and deleted
    const mine = replied.json.threads[0].comments.at(-1);
    assert.equal((await req('PATCH', `${p}/threads/${thread.id}/comments/${mine.id}`, { body: { body: 'thanks' } })).status, 200);
    const scratch = await req('POST', `${p}/threads/${thread.id}/comments`, { body: { body: 'scratch' } });
    assert.equal((await req('DELETE', `${p}/threads/${thread.id}/comments/${scratch.json.threads[0].comments.at(-1).id}`)).status, 200);
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(doc.threads[0].comments.map((c: any) => [c.author, c.body.trim()]), [['ada', 'mixed'], ['claude', 'agent reply'], ['ada', 'thanks']]);
    assert.ok(doc.threads[0].comments.every((c: any) => typeof c.id === 'string'));
  });

  test('invalid YAML is never overwritten', async () => {
    const p = `${P}/${sha}`;
    const file = path.join(reviewsDir, 'demo', `${sha}.yaml`);
    const broken = fs.readFileSync(file, 'utf8') + '\n  - : [unclosed\n';
    fs.writeFileSync(file, broken);
    const r = await req('PUT', `${p}/viewed`, { body: { path: 'f.txt', viewed: true } });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /refusing to overwrite/);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
  });
});
