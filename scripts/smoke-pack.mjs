// `npm run smoke:pack`: check the npm package as a user gets it. Packs it (prepack builds it), installs the tarball
// globally into a temp prefix, then runs the installed `local-review` from a temp directory with a throwaway HOME and
// LOCAL_REVIEW_HOME: --version, --help, guide, service install --dry-run, init, asset add, and the server (on a free
// port: the startup text, /llms.txt and its siblings, /api/me, /, a UI asset, the favicons, the project list, a stack
// PNG drawn with the bundled fonts, the added image, adding and removing the example projects). Cleans up after
// itself. Linux and macOS.
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-smoke-')));
const prefix = path.join(tmp, 'prefix');
const home = path.join(tmp, 'home');
const data = path.join(tmp, 'data');
const work = path.join(tmp, 'work'); // run from somewhere unrelated, so nothing depends on the cwd
for (const d of [prefix, home, data, work]) fs.mkdirSync(d);

const step = (s) => console.log(`smoke:pack: ${s}`);
let server;

// the installed bin, run as a user would: a fresh HOME and data home, none of this checkout's environment
const env = { ...process.env, HOME: home, LOCAL_REVIEW_HOME: data };
for (const k of ['PORT', 'LOCAL_REVIEW_PROJECTS_DIR', 'LOCAL_REVIEW_DEV', 'LOCAL_REVIEW_USER', 'NODE_OPTIONS']) delete env[k];
const bin = path.join(prefix, 'bin', 'local-review');
const run = (...args) => execFileSync(bin, args, { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function fails(args, status, pattern) {
  try {
    run(...args);
  } catch (e) {
    assert.equal(e.status, status, `local-review ${args.join(' ')}: exit ${e.status}`);
    assert.match(e.stderr, pattern);
    return;
  }
  assert.fail(`local-review ${args.join(' ')} should have failed`);
}

async function get(base, p, type) {
  const res = await fetch(base + p);
  assert.equal(res.status, 200, `GET ${p}: ${res.status} ${await res.clone().text()}`);
  assert.match(res.headers.get('content-type') ?? '', type, `GET ${p}: content-type`);
  return res;
}

try {
  step('npm pack');
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  // prepack's build output comes first; the JSON starts at a line that is just "["
  const tarball = path.join(tmp, JSON.parse(out.slice(out.search(/^\[$/m))).at(-1).filename);
  step(`installing ${path.basename(tarball)} into ${prefix}`);
  execFileSync('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball], { stdio: ['ignore', 'ignore', 'inherit'] });

  const installed = path.join(prefix, 'lib', 'node_modules', 'local-review');
  const deps = fs.readdirSync(path.join(installed, 'node_modules'));
  for (const dev of ['react', 'react-dom', 'vite', 'tsx', 'typescript', '@pierre', 'marked', 'dompurify'])
    assert.ok(!deps.includes(dev), `${dev} is a build-time dependency; it shouldn't be installed`);

  step('--version, --help, guide');
  assert.equal(run('--version').trim(), pkg.version);
  assert.match(run('--help'), /^Usage: local-review \[serve\]/);
  assert.equal(run('guide'), fs.readFileSync(path.join(root, 'AGENT-GUIDE.md'), 'utf8'));
  fails(['frobnicate'], 2, /unknown command 'frobnicate'/);

  step('service install --dry-run');
  const homeBefore = fs.readdirSync(home);
  const dry = run('service', 'install', '--dry-run');
  assert.match(dry, /^Would write the (LaunchAgent|systemd user unit) .* \(--dry-run: nothing written, nothing started\):/);
  assert.ok(dry.includes(fs.realpathSync(path.join(installed, 'dist', 'server', 'cli.js'))), `the service would run the installed CLI:\n${dry}`);
  assert.ok(dry.includes('LOCAL_REVIEW_HOME') && dry.includes(data), 'with this data home');
  assert.deepEqual(fs.readdirSync(home), homeBefore, 'nothing written');

  step('init demo');
  assert.match(run('init', 'demo'), /^Created .*demo\/project\.yaml/);
  const yaml = path.join(data, 'projects', 'demo', 'project.yaml');
  assert.match(fs.readFileSync(yaml, 'utf8'), /^title: demo$/m);
  fails(['init', 'demo'], 1, /already exists; not replacing it/);
  fails(['plan', 'missing'], 1, /no project 'missing'/);

  step('asset add');
  const image = path.join(root, 'brand', 'icon-192.png');
  const snippet = run('asset', 'add', 'demo', image).trim();
  const assetName = snippet.match(/^!\[icon-192\]\(assets\/([0-9a-f]{16}\.png)\)$/)?.[1];
  assert.ok(assetName, `asset add prints the markdown: ${snippet}`);
  fails(['asset', 'add', 'demo', yaml], 1, /not an image type/);

  step('serve');
  server = spawn(bin, ['--port', '0'], { cwd: work, env, stdio: ['ignore', 'pipe', 'inherit'] });
  let printed = '';
  const base = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`the server didn't start: ${buf}`)), 30000);
    server.stdout.on('data', (d) => {
      buf += d;
      printed += d;
      const m = buf.match(/Local Review on (http:\/\/localhost:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    server.on('exit', (code) => reject(new Error(`the server exited (${code}): ${buf}`)));
  });
  step(`serving on ${base}`);
  // piped, so no banner: the line (after any [backups] note), then the hint for agents (server/banner.ts)
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(/^Local Review on /m.test(printed) && !printed.includes('█'), `no banner when piped: ${printed}`);
  assert.ok(printed.includes(`Point Claude Code/Codex/pi/whatever at ${base}/llms.txt then ask it`), `the hint for agents: ${printed}`);

  step('llms.txt, llms-full.txt, agent-guide.md');
  const llms = await (await get(base, '/llms.txt', /^text\/plain/)).text();
  assert.match(llms, /^# Local Review\n\n> /);
  assert.ok(llms.includes(`Projects directory: \`${path.join(data, 'projects')}\``), 'the live projects directory');
  assert.ok(llms.includes(`\`demo\`: demo, ${base}/demo`), 'the existing project');
  assert.ok(llms.includes(`version ${pkg.version}`) && llms.includes(fs.readFileSync(path.join(root, 'examples', 'project.example.yaml'), 'utf8').split('\n')[0]));
  assert.ok((await (await get(base, '/llms-full.txt', /^text\/plain/)).text()).includes('## Handling review threads'));
  await get(base, '/agent-guide.md', /^text\/markdown/); // (a foreign Host gets a 403: hardening.test.ts; fetch can't set Host)
  const me = await (await get(base, '/api/me', /json/)).json();
  assert.equal(typeof me.id, 'string');
  const html = await (await get(base, '/', /html/)).text();
  assert.equal(html, fs.readFileSync(path.join(installed, 'dist', 'web', 'index.html'), 'utf8'));
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset, 'index.html loads a script from /assets/');
  await get(base, asset, /javascript/);
  // the favicons: from brand/, hashed into the built UI's assets by Vite (brand/ itself isn't in the package)
  const icons = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(icons.length, 3, `index.html links the three favicons: ${icons}`);
  for (const icon of icons) {
    assert.match(icon, /^\/assets\//, `${icon} comes from the built UI`);
    await get(base, icon, /^image\//);
  }
  assert.equal((await fetch(base + '/demo')).status, 200, 'a client-side route serves the UI');
  const projects = await (await get(base, '/api/projects', /json/)).json();
  assert.deepEqual(projects.projects.map((p) => p.slug), ['demo']);
  const png = Buffer.from(await (await get(base, '/api/projects/demo/stack.png', /image\/png/)).arrayBuffer());
  assert.ok(png.subarray(1, 4).toString() === 'PNG' && png.length > 1000, 'a stack PNG, drawn with the bundled fonts');
  const img = await get(base, `/api/projects/demo/assets/${assetName}`, /^image\/png$/);
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), fs.readFileSync(image), 'the added image, as added');

  step('the example projects (built from dist/demo, no network)');
  const post = (p) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const added = await post('/api/examples');
  assert.equal(added.status, 201, await added.clone().text());
  const withExamples = await (await get(base, '/api/projects', /json/)).json();
  assert.equal(withExamples.examples, 'present');
  assert.deepEqual(withExamples.projects.map((p) => p.slug).sort(), ['demo', 'example-calendar-feed', 'example-calendar-reminders', 'example-waitlists', 'example-webhook-retries']);
  const waitlists = await (await get(base, '/api/projects/example-waitlists', /json/)).json();
  assert.deepEqual(waitlists.repos.map((r) => [r.name, r.error, r.commits.length]), [['orchard-api', null, 10], ['orchard-sdk', null, 4], ['orchard-web', null, 5], ['orchard-infra', null, 3]]);
  // linked projects: calendar reminders builds on the calendar feed, in the same repo
  const reminders = await (await get(base, '/api/projects/example-calendar-reminders', /json/)).json();
  assert.deepEqual([reminders.after?.slug, reminders.repos[0].startsAfter, reminders.repos[0].commits.length, reminders.warnings], ['example-calendar-feed', true, 3, []]);
  assert.equal((await post('/api/examples/remove')).status, 200);
  assert.deepEqual((await (await get(base, '/api/projects', /json/)).json()).projects.map((p) => p.slug), ['demo']);
  console.log('smoke:pack: ok');
} finally {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
