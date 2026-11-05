// `node scripts/service-real.mjs`: `local-review service …` against the machine's REAL service manager (launchd's
// gui/<uid> domain on macOS, systemd's user instance on Linux), with the package as a user gets it: packed, installed
// globally into a temp prefix, and run from there. CI only: it writes the real ~/Library/LaunchAgents or
// ~/.config/systemd/user file and loads it, so it refuses to run unless CI=true and LOCAL_REVIEW_REAL_SERVICE=1, and
// it must not run on a machine that uses Local Review as a service (the label is the real one). The data home is a
// throwaway. It removes what it installs, and checks that uninstall leaves the data home alone.
//
// What it checks: refused from npx's cache (writing nothing); install; it answers, with its version; a second install
// changes nothing; status and its exit codes (0, 3, 4); the server killed, and launchd's KeepAlive / systemd's
// Restart=always bringing it back; stop (stopped, still installed, not disabled) and start; logs; restart; restart
// rewriting a unit in the older two-log format; a new port; a reinstall without --port keeping it; uninstall removing
// the file and stopping it, and nothing else; start, stop, restart and logs exiting 4 with nothing installed.
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
/** Any exit status: { code, stdout, stderr }. */
const lrAny = (...args) => {
  try {
    return { code: 0, stdout: execFileSync(bin, args, { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (e) {
    if (typeof e.status !== 'number') throw e;
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  }
};
/** `service status --json`, checking its exit status agrees with what it says (cli-contract SPEC §2). */
const statusJson = () => {
  const r = lrAny('service', 'status', '--json');
  const s = JSON.parse(r.stdout);
  assert.equal(r.code, !s.installed ? 4 : s.running && s.answering ? 0 : 3, `status exit ${r.code} for ${r.stdout}`);
  return s;
};
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
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
const health = async (port) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};
const answers = async (port) => !!(await health(port));

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
  step('nothing installed: status, start, stop, restart and logs exit 4');
  assert.equal(lrAny('service', 'status').code, 4);
  for (const verb of ['start', 'stop', 'restart', 'logs']) {
    const r = lrAny('service', verb);
    assert.equal(r.code, 4, `service ${verb}: ${r.stderr}`);
    assert.match(r.stderr, /isn't installed as a service/);
  }
  assert.ok(!fs.existsSync(file), 'nothing written');

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
  assert.deepEqual(await health(port), { ok: true, version }, '/api/health has the version');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(cli), `the service runs the installed CLI (${cli}):\n${text}`);
  assert.ok(text.includes(data), 'with the data home');
  const log = path.join(data, 'logs', 'service.log');
  assert.equal(text.split(log).length - 1, 2, `stdout and stderr both to ${log}:\n${text}`);
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
  assert.equal(s.version, version);
  assert.equal(s.installedVersion, version);
  assert.equal(s.log, log);
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

  step('busy: not busy; runtime.json names the running service');
  const runtime = path.join(data, 'runtime.json');
  assert.equal(JSON.parse(fs.readFileSync(runtime, 'utf8')).pid, s.pid, 'the new process rewrote runtime.json');
  let b = lrAny('busy', '--json');
  assert.equal(b.code, 0, b.stderr);
  assert.deepEqual(JSON.parse(b.stdout), { running: true, busy: false, url: `http://127.0.0.1:${port}`, version, counts: { save: 0, snapshot: 0, sync: 0 } });

  step('service stop: stopped, still installed, not disabled');
  assert.match(lr('service', 'stop'), /^Stopped Local Review\. It starts again/);
  assert.ok(!(await answers(port)), 'nothing answers');
  await until('runtime.json removed by its clean exit on SIGTERM', async () => !fs.existsSync(runtime));
  b = lrAny('busy');
  assert.deepEqual([b.code, b.stdout], [3, "Local Review isn't running.\n"]);
  s = statusJson(); // exit 3
  assert.equal(s.installed, true);
  assert.equal(s.running, false);
  assert.ok(fs.existsSync(file), 'the service file stays');
  if (process.platform === 'linux') {
    const enabled = execFileSync('systemctl', ['--user', 'is-enabled', path.basename(file)], { encoding: 'utf8' }).trim();
    assert.equal(enabled, 'enabled', 'still enabled: the next login starts it');
  } else {
    // booted out, and not disabled: `launchctl print-disabled` doesn't list it as disabled
    const disabled = execFileSync('launchctl', ['print-disabled', `gui/${process.getuid()}`], { encoding: 'utf8' });
    assert.doesNotMatch(disabled, /"local-review\.server" => (true|disabled)/, disabled);
  }
  assert.match(lr('service', 'stop'), /wasn't running/);

  step('service start');
  assert.match(lr('service', 'start'), new RegExp(`^Started Local Review: http://localhost:${port}$`, 'm'));
  assert.ok(await answers(port));
  assert.match(lr('service', 'start'), /already running/);
  statusJson(); // exit 0

  step('service logs');
  o = lr('service', 'logs', '-n', '200');
  assert.ok(o.includes(`Local Review ${version}: http://localhost:${port}\n`), `its start is in its log:\n${o}`);
  assert.equal(lr('service', 'logs', '-n', '1').trimEnd().split('\n').length, 1);

  step('service restart');
  // with --force: with nothing under way it changes nothing, so no "Overriding:". (The next step restarts it without
  // --force. One restart here, not two: systemd refuses a sixth start within 10 seconds, its default StartLimitBurst.)
  b = lrAny('service', 'restart', '--force');
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stdout, new RegExp(`^Restarted Local Review: http://localhost:${port}$`, 'm'));
  assert.doesNotMatch(b.stderr, /Overriding/);
  assert.ok(await answers(port));

  step('service restart rewrites a unit an older version wrote (two log files)');
  const current = fs.readFileSync(file, 'utf8');
  const outLog = path.join(data, 'logs', 'server.out.log');
  const errLog = path.join(data, 'logs', 'server.err.log');
  let n = 0;
  fs.writeFileSync(file, current.split(log).map((part, i, all) => part + (i < all.length - 1 ? (n++ === 0 ? outLog : errLog) : '')).join(''));
  if (process.platform === 'linux') execFileSync('systemctl', ['--user', 'daemon-reload']);
  assert.match(statusJson().warnings.join('\n'), /older Local Review/);
  o = lr('service', 'restart');
  assert.match(o, /^Updated its /m);
  assert.equal(fs.readFileSync(file, 'utf8'), current, 'back to the current format');
  await until('it answers again', () => answers(port));
  assert.deepEqual(statusJson().warnings, []);

  const port2 = await freePort();
  step(`a new port, ${port2}; then a reinstall without --port keeps it`);
  lr('service', 'install', '--port', String(port2));
  assert.ok(await answers(port2));
  await until(`nothing on ${port}`, async () => !(await answers(port)));
  o = lr('service', 'install');
  assert.match(o, /\(unchanged\)/);
  assert.match(o, new RegExp(`Port ${port2}, as it was installed`));

  step('service uninstall');
  // its start, in the log. (That it uses the data home `service install` chose, from the service's file alone, the
  // busy step showed: its runtime.json is in that data home.)
  const logged = fs.readFileSync(log, 'utf8');
  // (the service runs `serve --quiet`: just the first line, cli-contract SPEC §3)
  assert.ok(logged.startsWith(`Local Review ${version}: http://localhost:${port}\n`), `it logged its start:\n${logged}`);
  const dataBefore = fs.readdirSync(data).sort();
  assert.match(lr('service', 'uninstall'), /^Removed Local Review's service \(.*\)\. Your data in .* is untouched\.$/m);
  installed = false;
  assert.ok(!fs.existsSync(file), 'the service file is gone');
  await until(`nothing on ${port2}`, async () => !(await answers(port2)));
  assert.equal(statusJson().loaded, false);
  // (the server may still add to it as it stops, e.g. its cache: only what was there matters)
  // all but runtime.json, which the server removes as it exits (cli-contract SPEC §4)
  for (const f of dataBefore.filter((f) => f !== 'runtime.json')) assert.ok(fs.existsSync(path.join(data, f)), `${f} is still in the data home`);
  await until('runtime.json removed by its clean exit', async () => !fs.existsSync(runtime));
  assert.ok(fs.readFileSync(log, 'utf8').includes(`Local Review ${version}: `), 'the logs are kept');
  assert.match(lr('service', 'uninstall'), /wasn't installed as a service; nothing to do/);
  for (const verb of ['status', 'start', 'logs']) assert.equal(lrAny('service', verb).code, 4, `service ${verb} after uninstall`);
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
