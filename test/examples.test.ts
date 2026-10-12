// The example projects (server/examples.ts): adding them creates the Orchard repos and projects (the same shas as
// the demo's lock), adding again changes nothing, removing renames and deletes nothing, adding after removing
// restores what was there (comments included), and a user's own project of the same name is never touched. Then the
// HTTP endpoints, through the real server. Everything in a throwaway HOME and data home in the OS temp dir.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { tmpDir } from './fixture.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUGS = ['example-waitlists', 'example-calendar-feed', 'example-calendar-reminders', 'example-webhook-retries'];

function sandbox() {
  const home = tmpDir('lr-test-examples-');
  const lrHome = path.join(home, '.local-review');
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, LOCAL_REVIEW_HOME: lrHome };
    delete e.LOCAL_REVIEW_PROJECTS_DIR;
    delete e.PORT;
    return e;
  };
  const lr = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
      execFile(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), ...args], { env: env(), cwd: ROOT, timeout: 60000 }, (err, stdout, stderr) =>
        res({ code: err ? Number((err as any).code ?? 1) : 0, stdout, stderr }),
      );
    });
  /** every file under the data home, with its size: nothing may ever disappear from this */
  const files = (dir = lrHome): Map<string, number> => {
    const out = new Map<string, number>();
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.set(path.relative(lrHome, p), fs.statSync(p).size);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
  };
  return { home, lrHome, projects: path.join(lrHome, 'projects'), env, lr, files };
}

const keptAll = (before: Map<string, number>, now: Map<string, number>, renamed: (f: string) => string = (f) => f) => {
  for (const f of before.keys()) assert.ok(now.has(renamed(f)), `${f} is gone`);
};

describe('the example projects, from the CLI', () => {
  const s = sandbox();
  after(() => fs.rmSync(s.home, { recursive: true, force: true }));

  test('adding creates the four projects and the four repos, with the demo\'s shas', async () => {
    const r = await s.lr(['examples']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Created example-waitlists, example-calendar-feed, example-calendar-reminders, example-webhook-retries/);
    for (const slug of SLUGS) {
      const doc = YAML.parse(fs.readFileSync(path.join(s.projects, slug, 'project.yaml'), 'utf8'));
      assert.equal(doc.example, true, slug);
      for (const repo of doc.repos) assert.match(repo.path, /^~\/\.local-review\/examples\/orchard-[0-9a-f]{10}\/orchard-/, 'written ~-relative');
    }
    const [root] = fs.readdirSync(path.join(s.lrHome, 'examples'));
    const manifest = JSON.parse(fs.readFileSync(path.join(s.lrHome, 'examples', root, 'manifest.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', 'shas.json'), 'utf8'));
    assert.deepEqual(manifest.repos, lock.repos, 'the same history as the demo test bed');
  });

  test('adding again changes nothing', async () => {
    const before = s.files();
    const r = await s.lr(['examples']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Already there: example-waitlists, example-calendar-feed, example-calendar-reminders, example-webhook-retries/);
    assert.deepEqual(s.files(), before);
  });

  test('removing renames each project.yaml to a .bak and deletes nothing; adding again restores them, comments included', async () => {
    // a comment the user wrote on an example
    const reviews = path.join(s.projects, 'example-calendar-feed', 'reviews', 'orchard-api');
    const reviewFile = path.join(reviews, fs.readdirSync(reviews)[0]);
    fs.appendFileSync(reviewFile, '# my note\n');
    const before = s.files();
    const r = await s.lr(['examples', 'remove']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Removed example-waitlists, example-calendar-feed, example-calendar-reminders, example-webhook-retries/);
    const now = s.files();
    keptAll(before, now, (f) => f.replace(/project\.yaml$/, 'project.example-removed.yaml.bak'));
    for (const slug of SLUGS) assert.ok(!fs.existsSync(path.join(s.projects, slug, 'project.yaml')));

    const again = await s.lr(['examples', 'remove']);
    assert.match(again.stdout, /No example projects to remove/);

    const add = await s.lr(['examples']);
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stdout, /Restored example-waitlists, example-calendar-feed, example-calendar-reminders, example-webhook-retries/);
    assert.deepEqual(s.files(), before, 'back exactly as it was');
    assert.match(fs.readFileSync(reviewFile, 'utf8'), /# my note\n$/);
  });

  test("a user's own project with an example's name is never touched", async () => {
    await s.lr(['examples', 'remove']);
    const mine = path.join(s.projects, 'example-waitlists', 'project.yaml');
    fs.renameSync(path.join(s.projects, 'example-waitlists', 'project.example-removed.yaml.bak'), path.join(s.home, 'set-aside.bak'));
    fs.writeFileSync(mine, 'title: Mine\nrepos: []\n');
    const before = s.files();
    const r = await s.lr(['examples']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already a project named 'example-waitlists'.*isn't an example; not touching it/);
    assert.deepEqual(s.files(), before, 'nothing written');
    const rm = await s.lr(['examples', 'remove']);
    assert.match(rm.stdout, /No example projects to remove/);
    assert.equal(fs.readFileSync(mine, 'utf8'), 'title: Mine\nrepos: []\n');
  });
});

/** Run the server from source on a free port over the sandbox's data home. */
async function serve(s: ReturnType<typeof sandbox>) {
  const port = await new Promise<number>((res) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => res(p));
    });
  });
  const server: ChildProcess = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), 'serve'], { env: { ...s.env(), PORT: String(port) }, stdio: 'ignore' });
  const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url('/health'))).ok) return { url, server };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  server.kill();
  throw new Error('server did not start');
}

const JSON_POST: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };

describe('the example projects, through the server', () => {
  const s = sandbox();
  let server: ChildProcess | undefined;
  let url = (p: string) => p;
  const post = (p: string, init: RequestInit = JSON_POST) => fetch(url(p), { method: 'POST', ...init });

  before(async () => {
    ({ url, server } = await serve(s));
  });
  after(() => {
    server?.kill();
    fs.rmSync(s.home, { recursive: true, force: true });
  });

  test('state none, then add (JSON only), present, remove, removed', async () => {
    const list = async () => (await fetch(url('/projects'))).json() as Promise<any>;
    assert.equal((await list()).examples, 'none');
    assert.equal((await post('/examples', { body: '{}' })).status, 415, 'writes must be JSON');
    assert.equal((await post('/examples', { headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' })).status, 403);

    const add = await post('/examples');
    assert.equal(add.status, 201);
    assert.deepEqual((await add.json()).created, SLUGS);
    const l = await list();
    assert.equal(l.examples, 'present');
    assert.deepEqual(l.projects.map((p: any) => [p.slug, p.example]).sort(), SLUGS.map((x) => [x, true]).sort());
    for (const slug of SLUGS) {
      const p = await (await fetch(url(`/projects/${slug}`))).json();
      for (const r of p.repos) {
        assert.equal(r.error, null, `${slug}/${r.name}`);
        assert.deepEqual(r.warnings, []);
      }
    }
    assert.equal((await post('/examples')).status, 200, 'again: nothing to create');

    const rm = await post('/examples/remove');
    assert.equal(rm.status, 200);
    assert.deepEqual((await rm.json()).removed, SLUGS);
    const after = await list();
    assert.equal(after.examples, 'removed');
    assert.deepEqual(after.projects, []);
  });
});

describe('adding the example projects without blocking the server', () => {
  const s = sandbox();
  let server: ChildProcess | undefined;
  let url = (p: string) => p;

  before(async () => {
    ({ url, server } = await serve(s));
  });
  after(() => {
    server?.kill();
    fs.rmSync(s.home, { recursive: true, force: true });
  });

  test('the server answers while they are made; a second add joins the first; a remove meanwhile is refused', async () => {
    let addDone = 0;
    const first = fetch(url('/examples'), JSON_POST).then(async (r) => {
      addDone = performance.now();
      return { status: r.status, body: await r.json() };
    });
    await new Promise((r) => setTimeout(r, 30)); // the add is under way (it takes the better part of a second)
    const second = fetch(url('/examples'), JSON_POST).then(async (r) => ({ status: r.status, body: await r.json() }));
    const removing = await fetch(url('/examples/remove'), JSON_POST);
    const removed = { status: removing.status, body: await removing.json() };
    const health = await fetch(url('/health'));
    const healthDone = performance.now();
    assert.ok(health.ok);
    assert.equal(addDone, 0, 'the health check was answered while the examples were still being added');
    assert.ok(healthDone > 0);

    assert.equal(removed.status, 409);
    assert.match(removed.body.error, /still being added/);

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 201);
    assert.deepEqual(a, b, 'the second add joined the first');
    assert.deepEqual(a.body.created, SLUGS);
    assert.equal(fs.readdirSync(path.join(s.lrHome, 'examples')).length, 1, 'one set of repos');

    // once it's done, remove works again
    const after = await fetch(url('/examples/remove'), JSON_POST);
    assert.equal(after.status, 200);
    assert.deepEqual((await after.json()).removed, SLUGS);
  });
});

describe('an update that ships a new example project', () => {
  const s = sandbox();
  let server: ChildProcess | undefined;
  after(() => {
    server?.kill();
    fs.rmSync(s.home, { recursive: true, force: true });
  });

  test('it is offered on its own, adding creates just it, and it builds on the calendar feed', async () => {
    assert.equal((await s.lr(['examples'])).code, 0);
    // an install from before calendar-reminders existed: everything but it
    fs.renameSync(path.join(s.projects, 'example-calendar-reminders'), path.join(s.home, 'set-aside'));
    const before = s.files();
    let url: (p: string) => string;
    ({ url, server } = await serve(s));
    const list = await (await fetch(url('/projects'))).json();
    assert.equal(list.examples, 'present');
    assert.deepEqual(list.newExamples, ['example-calendar-reminders']);
    const add = await (await fetch(url('/examples'), JSON_POST)).json();
    assert.deepEqual([add.created, add.restored], [['example-calendar-reminders'], []]);
    assert.deepEqual(add.existing.sort(), ['example-calendar-feed', 'example-waitlists', 'example-webhook-retries']);
    keptAll(before, s.files());
    assert.deepEqual((await (await fetch(url('/projects'))).json()).newExamples, []);
    const rem = await (await fetch(url('/projects/example-calendar-reminders'))).json();
    assert.deepEqual(rem.after, { slug: 'example-calendar-feed', title: 'Calendar feed' });
    assert.equal(rem.repos[0].startsAfter, true);
    assert.equal(rem.repos[0].commits.length, 3);
    assert.deepEqual(rem.warnings, []);
  });
});
