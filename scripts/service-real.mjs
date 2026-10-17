// `node scripts/service-real.mjs`: `local-review service …` against the machine's REAL service manager (launchd's
// gui/<uid> domain on macOS, systemd's user instance on Linux), with the package as a user gets it: packed, installed
// globally into a temp prefix, and run from there. CI only: it writes the real ~/Library/LaunchAgents or
// ~/.config/systemd/user file and loads it, so it refuses to run unless CI=true and LOCAL_REVIEW_REAL_SERVICE=1, and
// it must not run on a machine that uses Local Review as a service (the label is the real one). The data home is a
// throwaway. It removes what it installs, and checks that uninstall leaves the data home alone.
//
// What it checks: refused from npx's cache (writing nothing); install; it answers; a second install changes nothing;
// status; the server killed, and launchd's KeepAlive / systemd's Restart=always bringing it back; restart; a new port;
// a reinstall without --port keeping it; uninstall removing the file and stopping it, and nothing else.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.CI !== 'true' || process.env.LOCAL_REVIEW_REAL_SERVICE !== '1') {
  console.error('service-real: refusing to run outside CI (set CI=true and LOCAL_REVIEW_REAL_SERVICE=1 on a throwaway machine)');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-service-')));
const prefix = path.join(tmp, 'prefix');
const data = path.join(tmp, 'data');
const work = path.join(tmp, 'work');
for (const d of [prefix, work]) fs.mkdirSync(d);
const step = (s) => console.log(`service-real: ${s}`);

// the real HOME (that's where the service manager looks), a throwaway data home, no PORT
const env = { ...process.env, LOCAL_REVIEW_HOME: data };
for (const k of ['PORT', 'LOCAL_REVIEW_PROJECTS_DIR', 'LOCAL_REVIEW_DEV', 'NODE_OPTIONS']) delete env[k];
const bin = path.join(prefix, 'bin', 'local-review');
const lr = (...args) => {
  try {
    return execFileSync(bin, args, { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`local-review ${args.join(' ')} exited ${e.status}:\n${e.stdout}\n${e.stderr}`);
  }
};
const statusJson = () => JSON.parse(lr('service', 'status', '--json'));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
const answers = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
};

let installed = false;
try {
  step('npm pack, and install it into a temp prefix');
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const tarball = path.join(tmp, JSON.parse(out.slice(out.search(/^\[$/m))).at(-1).filename);
  execFileSync('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball], { stdio: ['ignore', 'ignore', 'inherit'] });
  const cli = fs.realpathSync(path.join(prefix, 'lib', 'node_modules', 'local-review', 'dist', 'server', 'cli.js'));

  const before = statusJson();
  assert.equal(before.installed, false, `a service is already installed here (${before.file}); this must run on a throwaway machine`);
  const file = before.file;

  step("refused from npx's cache, writing nothing");
  try {
    execFileSync('npx', ['-y', `--package=${tarball}`, 'local-review', 'service', 'install'], {
      cwd: work,
      env: { ...env, npm_config_cache: path.join(tmp, 'npm-cache') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('service install from npx should have been refused');
  } catch (e) {
    assert.equal(e.status, 1, `exit status: ${e.stderr}`);
    assert.match(e.stderr, /running from npx's cache.*`npm i -g local-review`/);
  }
  assert.ok(!fs.existsSync(file), 'nothing written');

  const port = await freePort();
  step(`service install --port ${port}`);
  installed = true;
  let o = lr('service', 'install', '--port', String(port));
  assert.match(o, new RegExp(`It's running: http://localhost:${port}`));
  console.log(o);
  assert.ok(await answers(port));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(cli), `the service runs the installed CLI (${cli}):\n${text}`);
  assert.ok(text.includes(data), 'with the data home');
  if (process.platform === 'darwin') execFileSync('plutil', ['-lint', file], { stdio: 'inherit' });

  step('again: unchanged');
  assert.match(lr('service', 'install'), /\(unchanged\)/);
  assert.ok(await answers(port));

  step('status');
  console.log(lr('service', 'status'));
  let s = statusJson();
  assert.equal(s.running, true);
  assert.equal(s.port, port);
  assert.equal(s.answering, true);
  assert.equal(s.cli, cli);
  assert.deepEqual(s.warnings, []);

  step(`killed (pid ${s.pid}): restarted by the service manager`);
  process.kill(s.pid, 'SIGKILL');
  const pid = s.pid;
  await until('a new process', () => {
    const n = statusJson();
    return n.running && n.pid !== pid && n.answering;
  }, 60000);
  s = statusJson();
  step(`back as pid ${s.pid}`);

  step('service restart');
  assert.match(lr('service', 'restart'), new RegExp(`^Restarted Local Review: http://localhost:${port}$`, 'm'));
  assert.ok(await answers(port));

  const port2 = await freePort();
  step(`a new port, ${port2}; then a reinstall without --port keeps it`);
  lr('service', 'install', '--port', String(port2));
  assert.ok(await answers(port2));
  await until(`nothing on ${port}`, async () => !(await answers(port)));
  o = lr('service', 'install');
  assert.match(o, /\(unchanged\)/);
  assert.match(o, new RegExp(`Port ${port2}, as it was installed`));

  step('service uninstall');
  const logs = path.join(data, 'logs');
  assert.ok(fs.readFileSync(path.join(logs, 'server.out.log'), 'utf8').includes(`Local Review on http://localhost:${port}`), 'it logged its start');
  const dataBefore = fs.readdirSync(data).sort();
  assert.match(lr('service', 'uninstall'), /^Removed Local Review's service \(.*\)\. Your data in .* is untouched\.$/m);
  installed = false;
  assert.ok(!fs.existsSync(file), 'the service file is gone');
  await until(`nothing on ${port2}`, async () => !(await answers(port2)));
  assert.equal(statusJson().loaded, false);
  // (the server may still add to it as it stops, e.g. its cache: only what was there matters)
  for (const f of dataBefore) assert.ok(fs.existsSync(path.join(data, f)), `${f} is still in the data home`);
  assert.ok(fs.readFileSync(path.join(logs, 'server.out.log'), 'utf8').includes('Local Review on'), 'the logs are kept');
  assert.match(lr('service', 'uninstall'), /wasn't installed as a service; nothing to do/);
  step('ok');
} finally {
  if (installed) {
    try {
      lr('service', 'uninstall');
    } catch (e) {
      console.error(`service-real: cleanup: ${e.message}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
