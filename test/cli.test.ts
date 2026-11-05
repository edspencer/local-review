// The `local-review` CLI's own commands (`plan` is in branches.test.ts): init, guide, --version / --help, usage
// errors and serve's port handling. Runs from source via tsx, against a throwaway data home in the OS temp dir.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { tmpDir } from './fixture.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = tmpDir('lr-test-cli-');
const PROJECTS = path.join(HOME, 'projects');
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const lr = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const e: Record<string, string | undefined> = { ...process.env };
    delete e.LOCAL_REVIEW_PROJECTS_DIR;
    delete e.PORT;
    Object.assign(e, { LOCAL_REVIEW_HOME: HOME }, env);
    execFile(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), ...args], { env: e, cwd: ROOT, timeout: 20000 }, (err, stdout, stderr) =>
      res({ code: err ? Number((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });

describe('local-review CLI', () => {
  test('--version and --help', async () => {
    const v = await lr(['--version']);
    assert.equal(v.code, 0, v.stderr);
    assert.equal(v.stdout.trim(), JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    const h = await lr(['--help']);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /^Usage: local-review \[--data-dir <path>\] \[serve\]/);
    assert.match(h.stdout, /--port <n> +the port \(default 5622, or \$PORT\)/);
    for (const cmd of ['plan', 'init', 'guide']) assert.match(h.stdout, new RegExp(`^  ${cmd} `, 'm'));
    for (const sub of ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs']) assert.match(h.stdout, new RegExp(`^  service ${sub}$`, 'm'));
    // the docs site's CLI reference shows it verbatim
    const ref = fs.readFileSync(path.join(ROOT, 'website/src/content/docs/reference/cli.md'), 'utf8');
    const block = /## `local-review --help`\n\n```text\n([\s\S]*?)```/.exec(ref)?.[1];
    assert.equal(block, h.stdout, 'website/src/content/docs/reference/cli.md shows `local-review --help` exactly');
  });

  test('service install --dry-run from this checkout: refused without --from-checkout, else the file it would write', async () => {
    const home = tmpDir('lr-test-cli-home-');
    try {
      const r = await lr(['service', 'install', '--dry-run'], { HOME: home });
      if (process.platform !== 'darwin' && process.platform !== 'linux') return;
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^local-review: Local Review is running from a source checkout .*add --from-checkout\.\n$/);
      const d = await lr(['service', 'install', '--dry-run', '--from-checkout', '--port', '6123'], { HOME: home, PORT: '4000' });
      if (!fs.existsSync(path.join(ROOT, 'dist', 'server', 'cli.js'))) {
        assert.match(d.stderr, /build Local Review first \(npm run build\)/);
        return;
      }
      assert.equal(d.code, 0, d.stderr);
      assert.match(d.stdout, /^Would write the (LaunchAgent ~\/Library\/LaunchAgents\/local-review\.server\.plist|systemd user unit ~\/\.config\/systemd\/user\/local-review-server\.service) \(--dry-run/);
      assert.ok(d.stdout.includes(path.join(fs.realpathSync(ROOT), 'dist', 'server', 'cli.js')));
      assert.match(d.stdout, /6123/);
      assert.doesNotMatch(d.stdout, /4000/, '$PORT is not the service port');
      assert.deepEqual(fs.readdirSync(home), [], 'nothing written');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('usage errors exit 2 with the usage', async () => {
    for (const [args, msg] of [
      [['frobnicate'], /unknown command 'frobnicate'/],
      [['--frob'], /unknown option --frob/],
      [['-x'], /unknown option -x/],
      [['plan'], /plan needs a project/],
      [['init'], /init needs a project name/],
      [['init', '../evil'], /bad project name '\.\.\/evil'/],
      [['init', '.hidden'], /bad project name/],
      [['init', 'a', 'b'], /unexpected argument 'b'/],
      [['guide', '--port', '1'], /guide doesn't take --port/],
      [['plan', 'x', '--port', '1'], /plan doesn't take --port/],
      [['serve', '--format', 'md'], /serve doesn't take --format/],
      [['--port', 'nope'], /--port must be a port number/],
      [['--port', '70000'], /--port must be a port number/],
      [['service'], /service needs one of: install, uninstall, start, stop, restart, status, logs/],
      [['service', 'logs', '-n', 'x'], /-n must be a number of lines, not 'x'/],
      [['service', 'logs', '-n'], /-n needs a value/],
      [['service', 'logs', '--json'], /service logs doesn't take --json/],
      [['service', 'start', 'now'], /unexpected argument 'now'/],
      [['plan', 'x', '-f'], /plan doesn't take --follow/],
      [['init', 'x', '--data-dir='], /--data-dir needs a path/],
      [['init', 'x', '--data-dir'], /--data-dir needs a value/],
      [['service', 'frob'], /unknown service command 'frob'; service needs one of/],
      [['service', 'install', '--port', '0'], /--port must be a port number \(1-65535\), not '0'/],
      [['service', 'logs', '--force'], /service logs doesn't take --force/],
      [['service', 'status', '--port', '1'], /service status doesn't take --port/],
      [['service', 'uninstall', 'x'], /unexpected argument 'x'/],
      [['init', 'x', '--from-checkout'], /init doesn't take --from-checkout/],
      // a flag on a command that can't act on it is a usage error, not dropped (cli-contract SPEC §1)
      [['service', 'start', '--force'], /service start doesn't take --force/],
      [['service', 'status', '--refresh'], /service status doesn't take --refresh/],
      [['busy', '--check'], /busy doesn't take --check/],
      [['update', '--refresh'], /update doesn't take --refresh/],
      [['update', '--offline'], /update doesn't take --offline/],
      [['upgrade', 'now'], /unexpected argument 'now'/],
      [['update', '--to'], /--to needs a value/],
      [['doctor', '--force'], /doctor doesn't take --force/],
      [['doctor', '--check'], /doctor doesn't take --check/],
      [['serve', '--yes'], /serve doesn't take --yes/],
      [['service', 'install', '--offline'], /service install doesn't take --offline/],
    ] as const) {
      const r = await lr([...args]);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, msg);
      assert.match(r.stderr, /Usage: local-review/);
    }
    assert.ok(!fs.existsSync(PROJECTS), 'no usage error wrote anything');
  });

  test('--data-dir sets the data home for one command, before or after it, as LOCAL_REVIEW_HOME does', async () => {
    const dir = tmpDir('lr-test-cli-datadir-');
    try {
      let r = await lr(['--data-dir', dir, 'init', 'here']);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(fs.existsSync(path.join(dir, 'projects', 'here', 'project.yaml')));
      r = await lr(['init', 'there', `--data-dir=${dir}`]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(fs.existsSync(path.join(dir, 'projects', 'there', 'project.yaml')));
      assert.ok(!fs.existsSync(path.join(PROJECTS, 'here')) && !fs.existsSync(path.join(PROJECTS, 'there')), 'not in LOCAL_REVIEW_HOME');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('init creates project.yaml from the example, and never replaces one', async () => {
    const r = await lr(['init', 'demo']);
    assert.equal(r.code, 0, r.stderr);
    const file = path.join(PROJECTS, 'demo', 'project.yaml');
    assert.match(r.stdout, new RegExp(`Created ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(r.stdout, /http:\/\/localhost:5622\/demo/);
    const text = fs.readFileSync(file, 'utf8');
    const example = fs.readFileSync(path.join(ROOT, 'examples', 'project.example.yaml'), 'utf8');
    assert.equal(text, example.replace('title: My feature', 'title: demo'));
    assert.equal(YAML.parse(text).title, 'demo');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['project.yaml'], 'no temp file left behind');

    fs.writeFileSync(file, 'title: Mine\n');
    const again = await lr(['init', 'demo']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already exists; not replacing it/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'title: Mine\n', 'the existing file is untouched');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['project.yaml'], 'no temp file left behind');

    const port = await lr(['init', 'other'], { PORT: '5050' });
    assert.match(port.stdout, /http:\/\/localhost:5050\/other/);
  });

  test('guide prints AGENT-GUIDE.md', async () => {
    const r = await lr(['guide']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, fs.readFileSync(path.join(ROOT, 'AGENT-GUIDE.md'), 'utf8'));
  });

  test('plan on a missing project says how to create one', async () => {
    const r = await lr(['plan', 'nope']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no project 'nope'.*local-review init nope/);
  });

  test('serve refuses a port in use, and a bad $PORT', async () => {
    const blocker = net.createServer();
    await new Promise<void>((res) => blocker.listen(0, '127.0.0.1', res));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const r = await lr(['--port', String(port)]);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, new RegExp(`port ${port} is already in use; pick another with --port`));
    } finally {
      blocker.close();
    }
    const bad = await lr([], { PORT: 'abc' });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /PORT must be a port number \(0-65535\), not 'abc'/);
  });
});

describe('update and doctor (cli-contract SPEC §1, §5, §6)', () => {
  /** A registry that knows one newer local-review. */
  async function registry(latest: string) {
    const http = await import('node:http');
    const asked: string[] = [];
    const server = http.createServer((req, res) => {
      asked.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      if (req.url === '/-/package/local-review/dist-tags') res.end(JSON.stringify({ latest }));
      else if (req.url === `/local-review/${latest}`) res.end(JSON.stringify({ name: 'local-review', version: latest, engines: { node: '>=22' } }));
      else res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { url, asked, close: () => new Promise((r) => server.close(r)) };
  }

  test('from this checkout: --check reports (exit 0) with the right command; an update exits 5; `upgrade` is the same', async () => {
    const home = tmpDir('lr-test-update-');
    const reg = await registry('99.0.0');
    try {
      const env = { LOCAL_REVIEW_HOME: path.join(home, 'data'), HOME: home, npm_config_registry: reg.url };
      const c = await lr(['update', '--check', '--json'], env);
      assert.equal(c.code, 0, c.stderr);
      const doc = JSON.parse(c.stdout);
      assert.equal(doc.name, 'local-review');
      assert.equal(doc.target, '99.0.0');
      assert.equal(doc.updateAvailable, true);
      assert.equal(doc.installMethod, 'checkout');
      assert.equal(doc.canUpdate, false);
      assert.match(c.stderr, /^Local Review 99\.0\.0 is available \(you have .*\)\.\n  Run: git pull && npm install && npm run build +\(this is a checkout\)\n  Changes: https:\/\/github\.com\/edspencer\/local-review\/releases\/tag\/v99\.0\.0\n$/);
      // what `service status` repeats
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'data', 'update-check.json'), 'utf8')).target, '99.0.0');
      const u = await lr(['upgrade', '--yes'], env);
      assert.equal(u.code, 5, u.stderr);
      assert.match(u.stderr, /local-review: this install can't update itself: it's running from a checkout/);
      assert.equal(u.stdout, '');
      assert.ok(!fs.existsSync(path.join(home, 'data', 'update.lock')), 'the lock is released');
    } finally {
      await reg.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a registry that does not answer: exit 1, and doctor --offline never asks it', async () => {
    const home = tmpDir('lr-test-update-');
    const reg = await registry('99.0.0');
    await reg.close();
    try {
      const env = { LOCAL_REVIEW_HOME: path.join(home, 'data'), HOME: home, npm_config_registry: reg.url };
      const u = await lr(['update', '--check'], env);
      assert.equal(u.code, 1);
      assert.match(u.stderr, /^local-review: /);
      const d = await lr(['doctor', '--offline', '--json'], env);
      assert.ok(d.code === 0 || d.code === 1, d.stderr);
      const doc = JSON.parse(d.stdout);
      assert.equal(typeof doc.ok, 'boolean');
      assert.deepEqual(
        doc.checks.map((c: { id: string }) => c.id),
        ['node-engines', 'install-method', 'unit', 'running-version', 'port', 'linger', 'data-home', 'git', 'gh', 'update'],
      );
      assert.equal(doc.checks.at(-1).status, 'skip');
      assert.equal(doc.ok, !doc.checks.some((c: { status: string }) => c.status === 'fail'));
      assert.equal(d.code, doc.ok ? 0 : 1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('serve and busy (cli-contract SPEC §3, §4)', () => {
  const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  test("serve: stdout's first line is `Local Review <version>: <url>`; runtime.json while it runs; busy finds it; SIGTERM cleans up", async () => {
    const home = tmpDir('lr-test-serve-');
    const e: Record<string, string | undefined> = { ...process.env, LOCAL_REVIEW_HOME: home };
    for (const k of ['LOCAL_REVIEW_PROJECTS_DIR', 'PORT', 'LOCAL_REVIEW_DEV', 'FORCE_COLOR']) delete e[k];
    // the first run: no data home yet, so the snapshot and first-run logs would come first if they went to stdout
    fs.rmSync(home, { recursive: true, force: true });
    const proc = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), 'serve', '--port', '0'], { env: e, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise<number | null>((res) => proc.on('exit', (code) => res(code)));
    try {
      for (let i = 0; i < 200 && !stdout.includes('\n'); i++) await new Promise((r) => setTimeout(r, 50));
      const [first, second] = stdout.split('\n');
      const m = new RegExp(`^Local Review ${VERSION.replace(/\./g, '\\.')}: (http://localhost:(\\d+))$`).exec(first);
      assert.ok(m, `the first line: ${JSON.stringify(first)} (stderr: ${stderr})`);
      for (let i = 0; i < 40 && !stdout.includes('Projects:'); i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(stdout.split('\n')[1] ?? second, `Projects: ${path.join(home, 'projects')}`);
      const port = Number(m[2]);
      const rt = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8'));
      assert.deepEqual({ ...rt, startedAt: typeof rt.startedAt }, { pid: proc.pid, port, url: `http://127.0.0.1:${port}`, version: VERSION, startedAt: 'string' });
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'runtime.json')).mode & 0o777, 0o600);

      const api = await (await fetch(`http://127.0.0.1:${port}/api/busy`)).json();
      assert.deepEqual(api, { busy: false, version: VERSION, counts: { save: 0, snapshot: 0, sync: 0 } });
      const b = await lr(['busy'], { LOCAL_REVIEW_HOME: home });
      assert.deepEqual([b.code, b.stdout, b.stderr], [0, "Local Review isn't busy.\n", '']);
      const j = await lr(['busy', '--json'], { LOCAL_REVIEW_HOME: home });
      assert.equal(j.code, 0);
      assert.deepEqual(JSON.parse(j.stdout), { running: true, busy: false, url: `http://127.0.0.1:${port}`, version: VERSION, counts: { save: 0, snapshot: 0, sync: 0 } });
      assert.equal(j.stderr, "Local Review isn't busy.\n", '--json: the prose goes to stderr');

      // a save under way (adding the example projects runs git for a while) is busy, then it isn't
      const seen: unknown[] = [];
      let done = false;
      const saving = fetch(`http://127.0.0.1:${port}/api/examples`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).finally(() => (done = true));
      while (!done) {
        seen.push((await (await fetch(`http://127.0.0.1:${port}/api/busy`)).json()).counts);
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal((await saving).status, 201);
      assert.ok(seen.some((c) => JSON.stringify(c) === JSON.stringify({ save: 1, snapshot: 0, sync: 0 })), `a save was seen in flight: ${JSON.stringify(seen)}`);
      assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/busy`)).json()).counts, { save: 0, snapshot: 0, sync: 0 });

      proc.kill('SIGTERM');
      assert.equal(await exited, 0, 'a clean exit on SIGTERM');
      assert.ok(!fs.existsSync(path.join(home, 'runtime.json')), 'runtime.json is removed on exit');
      const gone = await lr(['busy', '--json'], { LOCAL_REVIEW_HOME: home });
      assert.equal(gone.code, 3);
      assert.deepEqual(JSON.parse(gone.stdout), { running: false, busy: false });
    } finally {
      proc.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('busy: 75 and the counts when the instance is busy; 3 with no runtime.json, or one whose pid is dead', async () => {
    const home = tmpDir('lr-test-busy-');
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/busy' ? { busy: true, version: '9.9.9', counts: { save: 1, snapshot: 0, sync: 2 } } : {}));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const write = (pid: number) =>
      fs.writeFileSync(path.join(home, 'runtime.json'), JSON.stringify({ pid, port, url: `http://127.0.0.1:${port}`, version: '9.9.9', startedAt: new Date().toISOString() }));
    try {
      const none = await lr(['busy'], { LOCAL_REVIEW_HOME: home });
      assert.deepEqual([none.code, none.stdout], [3, "Local Review isn't running.\n"]);
      write(process.pid);
      const b = await lr(['busy'], { LOCAL_REVIEW_HOME: home });
      assert.deepEqual([b.code, b.stdout], [75, 'Local Review is busy: 1 save and 2 GitHub syncs are running.\n']);
      const j = await lr(['busy', '--json'], { LOCAL_REVIEW_HOME: home });
      assert.equal(j.code, 75);
      assert.deepEqual(JSON.parse(j.stdout), { running: true, busy: true, url: `http://127.0.0.1:${port}`, version: '9.9.9', counts: { save: 1, snapshot: 0, sync: 2 } });
      write(2 ** 22 + 12345); // no such process: a crashed instance's leftover
      assert.equal((await lr(['busy'], { LOCAL_REVIEW_HOME: home })).code, 3);
      const bad = await lr(['busy', 'now']);
      assert.equal(bad.code, 2);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
