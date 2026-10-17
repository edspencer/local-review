// The `local-review` CLI's own commands (`plan` is in branches.test.ts): init, guide, --version / --help, usage
// errors and serve's port handling. Runs from source via tsx, against a throwaway data home in the OS temp dir.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
    assert.match(h.stdout, /^Usage: local-review \[serve\]/);
    assert.match(h.stdout, /--port <n> +the port \(default 5622, or \$PORT\)/);
    for (const cmd of ['plan', 'init', 'guide']) assert.match(h.stdout, new RegExp(`^  ${cmd} `, 'm'));
    for (const sub of ['install', 'uninstall', 'status', 'restart']) assert.match(h.stdout, new RegExp(`^  service ${sub}$`, 'm'));
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
      [['service'], /service needs one of: install, uninstall, status, restart/],
      [['service', 'frob'], /unknown service command 'frob'; service needs one of/],
      [['service', 'install', '--port', '0'], /--port must be a port number \(1-65535\), not '0'/],
      [['service', 'install', '--json'], /service install doesn't take --json/],
      [['service', 'status', '--port', '1'], /service status doesn't take --port/],
      [['service', 'uninstall', 'x'], /unexpected argument 'x'/],
      [['init', 'x', '--from-checkout'], /init doesn't take --from-checkout/],
    ] as const) {
      const r = await lr([...args]);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, msg);
      assert.match(r.stderr, /Usage: local-review/);
    }
    assert.ok(!fs.existsSync(PROJECTS), 'no usage error wrote anything');
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
