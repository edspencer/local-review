// Images (project assets/): type sniffing, content-addressed create-only storage, the published-URL records, the
// markdown references, snapshots hard-linking them, `local-review asset add|url`, the HTTP routes (upload guards,
// traversal, wrong bytes, size, the SVG CSP) and `plan` rewriting / flagging them. All against throwaway data
// homes and repos in the OS temp dir.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Repo, tmpDir } from './fixture.ts';

const HOME = tmpDir('lr-test-assets-');
const PROJECTS = path.join(HOME, 'projects');
fs.mkdirSync(PROJECTS);
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const A = await import('../server/assets.ts');
const SA = await import('../shared/assets.ts');
const BK = await import('../server/backups.ts');
const P = await import('../server/projects.ts');
const PL = await import('../server/plan.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(HOME, { recursive: true, force: true });
});

// a real 1×1 PNG, and the starts of the other types
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- a box -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n');
const EVIL_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');

function project(slug: string, yaml: object = { title: slug, repos: [] }) {
  const dir = path.join(PROJECTS, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.yaml'), YAML.stringify(yaml));
  return dir;
}

describe('asset files', () => {
  test('sniff: magic numbers, and SVG by its root element', () => {
    assert.deepEqual([PNG, JPG, GIF, WEBP, SVG, EVIL_SVG].map((b) => A.sniff(b)), ['png', 'jpg', 'gif', 'webp', 'svg', 'svg']);
    for (const bad of [
      Buffer.from('hello'),
      Buffer.from('<html><svg></svg></html>'),
      Buffer.from('<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>'), // an internal subset (entities): refused
      Buffer.from('<svg>unterminated'),
      Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e]), // not UTF-8
      Buffer.from('RIFF\0\0\0\0WAVE'),
      Buffer.alloc(0),
    ])
      assert.equal(A.sniff(bad), null, bad.toString('latin1'));
    assert.equal(A.sniff(Buffer.from('﻿<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg/>')), 'svg');
  });

  test('add: named by content, create-only, the same bytes again is a no-op; wrong or missing types refused', () => {
    const dir = project('files');
    const a = A.addAsset(dir, PNG, 'png', 'Overview [v2]');
    assert.match(a.name, SA.ASSET_NAME);
    assert.match(a.name, /^[0-9a-f]{16}\.png$/);
    assert.equal(a.markdown, `![Overview v2](assets/${a.name})`);
    assert.equal(a.created, true);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'assets', a.name)), PNG);
    const again = A.addAsset(dir, PNG, 'png');
    assert.deepEqual([again.name, again.created], [a.name, false]);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'assets')), [a.name]); // no temp files, no copies
    // a hand-changed file under the same name is left alone
    fs.writeFileSync(path.join(dir, 'assets', a.name), Buffer.concat([PNG, Buffer.from('x')]));
    assert.throws(() => A.addAsset(dir, PNG, 'png'), (e: any) => e.status === 409 && /not replacing it/.test(e.message));
    assert.throws(() => A.addAsset(dir, PNG, 'jpg'), (e: any) => e.status === 415 && /says it's JPG but its contents are PNG/.test(e.message));
    assert.throws(() => A.addAsset(dir, Buffer.from('MZ\x90\0'), 'png'), (e: any) => e.status === 415);
    assert.throws(() => A.addAsset(dir, PNG, null), (e: any) => e.status === 415);
    assert.throws(() => A.addAsset(dir, Buffer.alloc(0), 'png'), (e: any) => e.status === 400);
    const big = Buffer.concat([PNG, Buffer.alloc(SA.MAX_ASSET_BYTES)]);
    assert.throws(() => A.addAsset(dir, big, 'png'), (e: any) => e.status === 413 && /limit is 5 MB/.test(e.message));
    assert.equal(A.addAsset(dir, SVG, 'svg').name.endsWith('.svg'), true);
  });

  test('assetFile only finds well-named regular files in the folder', () => {
    const dir = project('lookup');
    const { name } = A.addAsset(dir, GIF, 'gif');
    assert.equal(A.assetFile(dir, name), path.join(dir, 'assets', name));
    for (const bad of ['../project.yaml', `${name}/x`, `../${name}`, name.toUpperCase(), name.replace('.gif', '.exe'), `${name}.yaml`, '0123456789abcdef.png'])
      assert.equal(A.assetFile(dir, bad), null, bad);
    fs.symlinkSync(path.join(dir, 'project.yaml'), path.join(dir, 'assets', 'aaaaaaaaaaaaaaaa.png'));
    assert.equal(A.assetFile(dir, 'aaaaaaaaaaaaaaaa.png'), null); // a symlink isn't served
  });

  test('published URLs: recorded in <name>.yaml, other fields kept, bad records never overwritten', () => {
    const dir = project('urls');
    const { name } = A.addAsset(dir, PNG, 'png');
    assert.equal(A.publishedUrl(dir, name), null);
    assert.throws(() => A.setPublishedUrl(dir, name, 'javascript:alert(1)'), /not an http/);
    assert.throws(() => A.setPublishedUrl(dir, '0000000000000000.png', 'https://x'), /no asset/);
    assert.throws(() => A.setPublishedUrl(dir, '../x.png', 'https://x'), /bad asset name/);
    const file = A.setPublishedUrl(dir, name, 'https://example.com/a.png');
    assert.equal(A.publishedUrl(dir, name), 'https://example.com/a.png');
    fs.appendFileSync(file, '# where it came from\nnote: kept\n');
    A.setPublishedUrl(dir, name, 'https://example.com/b.png');
    assert.deepEqual(YAML.parse(fs.readFileSync(file, 'utf8')), { url: 'https://example.com/b.png', note: 'kept' });
    fs.writeFileSync(file, 'url: [unclosed\n');
    assert.equal(A.publishedUrl(dir, name), null);
    assert.throws(() => A.setPublishedUrl(dir, name, 'https://x'), (e: any) => e.status === 409);
    assert.equal(fs.readFileSync(file, 'utf8'), 'url: [unclosed\n');
  });

  test('markdown references: images, links, reference definitions and HTML; prose and other paths are not', () => {
    const n = '0123456789abcdef.png';
    const m = '89abcdef01234567.svg';
    const md = [
      `![A](assets/${n}) and ![B](./assets/${m} "title")`,
      `[link](assets/${n})`,
      `<img src="assets/${m}" width="200">`,
      `[ref]: assets/${n}`,
      `Prose mentioning assets/${n} isn't a reference, nor is ![x](other/assets/${n}) or ![y](assets/${n}x).`,
      `![bad name](assets/0123.png)`,
    ].join('\n');
    assert.deepEqual(SA.assetRefs(md), [n, m]);
    const out = SA.rewriteAssetRefs(md, (x) => (x === n ? 'https://cdn.example/n.png' : null));
    assert.match(out, /!\[A\]\(https:\/\/cdn\.example\/n\.png\)/);
    assert.match(out, /\[link\]\(https:\/\/cdn\.example\/n\.png\)/);
    assert.match(out, /^\[ref\]: https:\/\/cdn\.example\/n\.png$/m);
    assert.match(out, new RegExp(`!\\[B\\]\\(\\./assets/${m} "title"\\)`)); // no URL: left as it is
    assert.match(out, new RegExp(`Prose mentioning assets/${n} `));
    assert.equal(SA.assetNameOf(`assets/${n}`), n);
    assert.equal(SA.assetNameOf(`./assets/${n}`), n);
    for (const s of [`/assets/${n}`, `assets/${n}?x`, `assets/../${n}`, 'assets/x.png', `https://e.com/assets/${n}`]) assert.equal(SA.assetNameOf(s), null, s);
    assert.equal(SA.assetMarkdown(n, ''), `![image](assets/${n})`);
  });

  test('snapshots hard-link assets (one copy on disk) and copy everything else', () => {
    const home = tmpDir('lr-test-assets-snap-');
    try {
      const projects = path.join(home, 'projects');
      const dir = path.join(projects, 'snap');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'project.yaml'), 'title: snap\n');
      const { name } = A.addAsset(dir, PNG, 'png');
      A.setPublishedUrl(dir, name, 'https://x.example/a.png');
      const backups = path.join(home, 'backups');
      const s1 = BK.takeSnapshot(projects, backups)!;
      const src = fs.statSync(path.join(dir, 'assets', name));
      const snap = fs.statSync(path.join(backups, s1, 'snap', 'assets', name));
      assert.equal(snap.ino, src.ino);
      assert.equal(src.nlink, 2);
      // the record and the project.yaml are real copies
      assert.notEqual(fs.statSync(path.join(backups, s1, 'snap', 'assets', `${name}.yaml`)).ino, fs.statSync(path.join(dir, 'assets', `${name}.yaml`)).ino);
      assert.equal(BK.takeSnapshot(projects, backups), null); // unchanged: no new snapshot
      A.addAsset(dir, GIF, 'gif');
      const s2 = BK.takeSnapshot(projects, backups, new Date(Date.now() + 1000))!;
      assert.ok(s2);
      assert.equal(fs.statSync(path.join(dir, 'assets', name)).nlink, 3);
      assert.deepEqual(fs.readFileSync(path.join(backups, s2, 'snap', 'assets', name)), PNG);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const e: Record<string, string | undefined> = { ...process.env };
    delete e.LOCAL_REVIEW_PROJECTS_DIR;
    delete e.PORT;
    Object.assign(e, { LOCAL_REVIEW_HOME: HOME }, env);
    execFile(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), ...args], { env: e, cwd: ROOT, timeout: 20000 }, (err, stdout, stderr) =>
      res({ code: err ? Number((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });

describe('local-review asset', () => {
  test('add prints the markdown; again is a no-op; url records where it is published', async () => {
    const dir = project('cli');
    const img = path.join(HOME, 'Architecture diagram.png');
    fs.writeFileSync(img, PNG);
    const r = await run(['asset', 'add', 'cli', img]);
    assert.equal(r.code, 0, r.stderr);
    const name = /assets\/([0-9a-f]{16}\.png)\)$/.exec(r.stdout.trim())![1];
    assert.equal(r.stdout, `![Architecture diagram](assets/${name})\n`);
    assert.match(r.stderr, /^Added .*assets\/[0-9a-f]{16}\.png\n$/);
    const again = await run(['asset', 'add', 'cli', img, '--alt', 'Overview']);
    assert.equal(again.stdout, `![Overview](assets/${name})\n`);
    assert.match(again.stderr, /^Already there:/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'assets')), [name]);
    const u = await run(['asset', 'url', 'cli', `assets/${name}`, 'https://example.com/d.png']);
    assert.equal(u.code, 0, u.stderr);
    assert.equal(A.publishedUrl(dir, name), 'https://example.com/d.png');
  });

  test('refuses what isn’t an image, a mismatched extension, a too-big file, and bad usage', async () => {
    project('cli2');
    const txt = path.join(HOME, 'notes.png');
    fs.writeFileSync(txt, 'not a png');
    const jpgNamedPng = path.join(HOME, 'photo.png');
    fs.writeFileSync(jpgNamedPng, JPG);
    const exe = path.join(HOME, 'tool.exe');
    fs.writeFileSync(exe, PNG);
    const big = path.join(HOME, 'big.png');
    fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(SA.MAX_ASSET_BYTES)]));
    for (const [args, code, msg] of [
      [['asset', 'add', 'cli2', txt], 1, /isn't a PNG image/],
      [['asset', 'add', 'cli2', jpgNamedPng], 1, /says it's PNG but its contents are JPG/],
      [['asset', 'add', 'cli2', exe], 1, /not an image type/],
      [['asset', 'add', 'cli2', big], 1, /limit is 5 MB/],
      [['asset', 'add', 'cli2', path.join(HOME, 'nope.png')], 1, /can't read/],
      [['asset', 'add', 'no-such-project', exe], 1, /no project 'no-such-project'/],
      [['asset', 'add', '../evil', exe], 2, /bad project name/],
      [['asset', 'add', 'cli2'], 2, /needs an image file/],
      [['asset'], 2, /asset needs a command/],
      [['asset', 'rm', 'cli2', 'x'], 2, /unknown asset command 'rm'/],
      [['asset', 'url', 'cli2', '0123456789abcdef.png'], 2, /needs an asset name and a URL/],
      [['asset', 'url', 'cli2', '../../x', 'https://x'], 2, /bad asset name/],
      [['asset', 'url', 'cli2', '0123456789abcdef.png', 'https://x'], 1, /no asset 0123456789abcdef\.png/],
      [['asset', 'url', 'cli2', '0123456789abcdef.png', 'https://x', '--alt', 'a'], 2, /doesn't take --alt/],
      [['plan', 'cli2', '--alt', 'x'], 2, /plan doesn't take --alt/],
    ] as const) {
      const r = await run([...args]);
      assert.equal(r.code, code, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, msg, args.join(' '));
      assert.equal(r.stdout, '');
    }
    assert.equal(fs.existsSync(path.join(PROJECTS, 'cli2', 'assets')), false);
  });
});

describe('asset routes', () => {
  let server: ChildProcess;
  let port = 0;
  const slug = 'http';
  let dir = '';

  function req(method: string, p: string, opts: { body?: Buffer | string; headers?: Record<string, string> } = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; json: any }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          let json: any = null;
          try { json = JSON.parse(body.toString()); } catch { /* not JSON */ }
          resolve({ status: res.statusCode!, headers: res.headers, body, json });
        });
      });
      r.on('error', (e: any) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? resolve({ status: 0, headers: {}, body: Buffer.alloc(0), json: null }) : reject(e)));
      if (opts.body !== undefined) r.write(opts.body);
      r.end();
    });
  }
  const upload = (body: Buffer, type: string, headers: Record<string, string> = {}) => req('POST', `/api/projects/${slug}/assets?alt=Shot`, { body, headers: { 'content-type': type, ...headers } });

  before(async () => {
    dir = project(slug);
    port = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    server = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), 'serve'], {
      env: { ...process.env, PORT: String(port), LOCAL_REVIEW_DEV: '1', LOCAL_REVIEW_PROJECTS_DIR: PROJECTS },
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

  test('upload then serve: the same bytes, an allow-listed type, nosniff, the locked-down CSP', async () => {
    const u = await upload(PNG, 'image/png');
    assert.equal(u.status, 201, JSON.stringify(u.json));
    assert.match(u.json.name, /^[0-9a-f]{16}\.png$/);
    assert.equal(u.json.markdown, `![Shot](assets/${u.json.name})`);
    assert.equal((await upload(PNG, 'image/png')).status, 200); // already there
    const g = await req('GET', `/api/projects/${slug}/assets/${u.json.name}`);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body, PNG);
    assert.equal(g.headers['content-type'], 'image/png');
    assert.equal(g.headers['x-content-type-options'], 'nosniff');
    assert.equal(g.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(g.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'");
  });

  test('an SVG is stored as uploaded but served under a CSP that runs no script', async () => {
    const u = await upload(EVIL_SVG, 'image/svg+xml');
    assert.equal(u.status, 201, JSON.stringify(u.json));
    const g = await req('GET', `/api/projects/${slug}/assets/${u.json.name}`);
    assert.equal(g.headers['content-type'], 'image/svg+xml');
    assert.equal(g.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'");
    assert.equal(g.headers['x-content-type-options'], 'nosniff');
  });

  test('cross-origin, non-image and mismatched uploads are refused, and write nothing', async () => {
    const before = fs.readdirSync(path.join(dir, 'assets')).sort();
    const cases: [Promise<{ status: number; json: any }>, number, RegExp][] = [
      [upload(GIF, 'image/gif', { origin: 'http://evil.example' }), 403, /forbidden origin/],
      [upload(GIF, 'image/gif', { host: 'evil.example' }), 403, /forbidden host/],
      // the "simple" (no-preflight) types a cross-site form or fetch could send
      [upload(GIF, 'text/plain'), 415, /expected an image Content-Type/],
      [upload(GIF, 'multipart/form-data; boundary=x'), 415, /expected an image Content-Type/],
      [upload(GIF, 'application/x-www-form-urlencoded'), 415, /expected an image Content-Type/],
      [upload(GIF, 'application/json'), 415, /expected an image Content-Type/],
      [upload(GIF, 'image/bmp'), 415, /expected an image Content-Type/],
      [upload(Buffer.from('<html><script>alert(1)</script></html>'), 'image/svg+xml'), 415, /isn't a SVG image/],
      [upload(JPG, 'image/png'), 415, /says it's PNG but its contents are JPG/],
      [upload(Buffer.alloc(0), 'image/png'), 400, /empty/],
      [req('POST', '/api/projects/nope/assets', { body: GIF, headers: { 'content-type': 'image/gif' } }), 404, /no project/],
      [req('POST', '/api/projects/..%2F..%2Fx/assets', { body: GIF, headers: { 'content-type': 'image/gif' } }), 404, /no project/],
      // image types are only accepted on the upload route
      [req('PUT', `/api/projects/${slug}/description`, { body: PNG, headers: { 'content-type': 'image/png' } }), 415, /application\/json/],
    ];
    for (const [p, status, msg] of cases) {
      const r = await p;
      assert.equal(r.status, status, JSON.stringify(r.json));
      assert.match(r.json.error, msg);
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, 'assets')).sort(), before);
  });

  test('too large: refused from Content-Length, or as it streams, without being stored', async () => {
    const before = fs.readdirSync(path.join(dir, 'assets')).sort();
    const big = Buffer.concat([PNG, Buffer.alloc(SA.MAX_ASSET_BYTES)]);
    const r = await upload(big, 'image/png');
    assert.ok(r.status === 413 || r.status === 0, String(r.status)); // 0: the server answered and closed mid-send
    if (r.status) assert.match(r.json.error, /too large/);
    // chunked (no Content-Length): counted as it arrives
    const chunked = await new Promise<number>((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port, agent: false, method: 'POST', path: `/api/projects/${slug}/assets`, headers: { host: `127.0.0.1:${port}`, 'content-type': 'image/png', 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      q.on('error', (e: any) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? resolve(0) : reject(e)));
      for (let i = 0; i < 6; i++) q.write(Buffer.alloc(1024 * 1024));
      q.end();
    });
    assert.ok(chunked === 413 || chunked === 0, String(chunked));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'assets')).sort(), before);
  });

  test('serving: bad names, traversal and missing files are 404s', async () => {
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'TOP-SECRET-CONTENT');
    for (const p of [
      `/api/projects/${slug}/assets/..%2Fproject.yaml`,
      `/api/projects/${slug}/assets/..%2Fsecret.txt`,
      `/api/projects/${slug}/assets/%2e%2e%2fsecret.txt`,
      `/api/projects/${slug}/assets/0123456789abcdef.png`,
      `/api/projects/${slug}/assets/0123456789ABCDEF.png`,
      `/api/projects/${slug}/assets/0123456789abcdef.html`,
      `/api/projects/${slug}/assets/project.yaml`,
      `/api/projects/..%2F${slug}/assets/0123456789abcdef.png`,
      `/api/projects/nope/assets/0123456789abcdef.png`,
    ]) {
      const r = await req('GET', p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.body.toString(), /TOP-SECRET-CONTENT|title: http/);
    }
    const { name } = A.addAsset(dir, PNG, 'png');
    fs.writeFileSync(path.join(dir, 'assets', `${name}.yaml`), 'url: https://x\n');
    assert.equal((await req('GET', `/api/projects/${slug}/assets/${name}.yaml`)).status, 404);
  });
});

describe('plan and images', () => {
  test('rewrites references with a published URL, warns for the rest, in md, json and yaml', async () => {
    const r = Repo.create();
    repos.push(r);
    r.commit('Initial', { 'base.txt': 'base\n' });
    r.git('checkout', '-q', '-b', 'feature');
    r.commit('Add A', { 'a.txt': 'a\n' });
    r.git('branch', 'tag-a');
    const slug = 'plan-images';
    const dir = project(slug, { title: 'Plan images', repos: [{ name: 'r', path: r.dir, branch: 'feature', base: 'main' }] });
    const pub = A.addAsset(dir, PNG, 'png').name;
    const local = A.addAsset(dir, SVG, 'svg').name;
    A.setPublishedUrl(dir, pub, 'https://example.com/pub.png');
    const yaml = YAML.parse(fs.readFileSync(path.join(dir, 'project.yaml'), 'utf8'));
    yaml.description = `Intro ![Diagram](assets/${pub})\n`;
    fs.writeFileSync(path.join(dir, 'project.yaml'), YAML.stringify(yaml));
    const sha = r.git('rev-parse', 'feature');
    fs.mkdirSync(path.join(dir, 'prs', 'r'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prs', 'r', `${sha}.yaml`), YAML.stringify({ commit: sha, branch: 'tag-a', body: `Before/after: ![Shot](assets/${local})\n\n<img src="assets/ffffffffffffffff.png">` }));
    const plan = await PL.buildPlan((await P.loadProject(slug))!);
    const pr = plan.prs[0];
    assert.match(pr.body, /^Intro !\[Diagram\]\(https:\/\/example\.com\/pub\.png\)/);
    assert.match(pr.body, new RegExp(`!\\[Shot\\]\\(assets/${local}\\)`));
    assert.deepEqual(pr.images.map((a) => [a.name, a.url, a.file && path.basename(a.file)]), [
      [pub, 'https://example.com/pub.png', pub],
      [local, null, local],
      ['ffffffffffffffff.png', null, null],
    ]);
    assert.ok(pr.warnings.some((w) => w.includes(`image assets/${local} has no published URL`) && w.includes(path.join(dir, 'assets', local)) && w.includes(`local-review asset url ${slug} ${local} <url>`)), pr.warnings.join('\n'));
    assert.ok(pr.warnings.some((w) => /image assets\/ffffffffffffffff\.png isn't in the project's assets folder/.test(w)));
    assert.ok(!pr.warnings.some((w) => w.includes(pub)));
    assert.ok(plan.warnings.some((w) => w.startsWith('r ') && w.includes(`assets/${local} has no published URL`)));
    // the CLI formats
    const md = await run(['plan', slug]);
    assert.equal(md.code, 0, md.stderr);
    assert.match(md.stdout, new RegExp(`- Images: \`assets/${pub}\` → https://example\\.com/pub\\.png, \`assets/${local}\` \\(no published URL\\), \`assets/ffffffffffffffff\\.png\` \\(missing\\)`));
    assert.match(md.stdout, /\*\*Warning:\*\* image assets\/[0-9a-f]{16}\.svg has no published URL/);
    const json = JSON.parse((await run(['plan', slug, '--format', 'json'])).stdout);
    assert.deepEqual(json.prs[0].images[0], { name: pub, file: path.join(dir, 'assets', pub), url: 'https://example.com/pub.png' });
    assert.ok(json.warnings.some((w: string) => w.includes('has no published URL')));
    const y = YAML.parse((await run(['plan', slug, '--format', 'yaml'])).stdout);
    assert.equal(y.prs[0].body, pr.body);
    assert.equal(y.prs[0].images.length, 3);
  });
});

// The project intro, a stack's note and a PR description take images the same way: one upload route into the one
// project assets/ folder, the same `![alt](assets/<name>)` stored verbatim by each layer's PUT, served from the same
// URL, rewritten by `plan` alike, and never removed when the text stops referring to it.
describe('images at every layer', () => {
  let server: ChildProcess;
  let port = 0;
  const slug = 'layers';
  let dir = '';
  let sha = '';
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

  before(async () => {
    const r = Repo.create();
    repos.push(r);
    r.commit('Initial', { 'base.txt': 'base\n' });
    r.git('checkout', '-q', '-b', 'feature');
    sha = r.commit('Add A', { 'a.txt': 'a\n' });
    dir = project(slug, { title: 'Layers', repos: [{ name: 'r', path: r.dir, branch: 'feature', base: 'main', stacks: [{ title: 'Only', starts_at: 'Add A' }] }] });
    port = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    server = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), 'serve'], {
      env: { ...process.env, PORT: String(port), LOCAL_REVIEW_DEV: '1', LOCAL_REVIEW_PROJECTS_DIR: PROJECTS },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start');
  });
  after(() => server?.kill());

  test('one upload, referenced from the intro, a stack note and a PR description: stored, served and planned alike', async () => {
    const up = await fetch(`http://127.0.0.1:${port}/api/projects/${slug}/assets?alt=Diagram`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
    assert.equal(up.status, 201);
    const { name, markdown } = await up.json();
    assert.equal(markdown, `![Diagram](assets/${name})`);
    const text = (who: string) => `${who} context.\n\n${markdown}\n`;

    const P_ = `/api/projects/${slug}`;
    assert.equal((await call('PUT', `${P_}/description`, { description: text('Project') })).status, 200);
    assert.equal((await call('PUT', `${P_}/repos/r/stacks/1/description`, { description: text('Stack'), title: 'Only' })).status, 200);
    assert.equal((await call('PUT', `${P_}/repos/r/commits/${sha}/pr`, { body: text('PR') })).status, 200);

    // each layer gives the reference back exactly as written
    const p = (await call('GET', P_)).json;
    assert.equal(p.description, text('Project'));
    assert.equal(p.repos[0].stacks[0].description, text('Stack').trimEnd());
    assert.equal((await call('GET', `${P_}/repos/r/commits/${sha}/pr`)).json.body, text('PR').trimEnd());
    for (const t of [p.description, p.repos[0].stacks[0].description]) assert.deepEqual(SA.assetRefs(t), [name]);
    // one file, in the one assets folder, served from the one URL whichever text shows it
    assert.deepEqual(fs.readdirSync(path.join(dir, 'assets')), [name]);
    const img = await fetch(`http://127.0.0.1:${port}${SA.assetUrl(slug, name)}`);
    assert.equal(img.status, 200);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

    // plan composes all three and reports the one image, unpublished, for each reference alike
    const before = await PL.buildPlan((await P.loadProject(slug))!);
    assert.equal(before.prs[0].body.split(`](assets/${name})`).length - 1, 3);
    assert.deepEqual(before.prs[0].images.map((a) => [a.name, a.url]), [[name, null]]);
    // once published, every layer's reference points at the URL
    A.setPublishedUrl(dir, name, 'https://example.com/d.png');
    const after_ = await PL.buildPlan((await P.loadProject(slug))!);
    assert.equal(after_.prs[0].body.split('](https://example.com/d.png)').length - 1, 3);
    assert.ok(!after_.prs[0].body.includes('assets/'));

    // removing the references from every layer leaves the image where it was (never deleted)
    assert.equal((await call('PUT', `${P_}/description`, { description: null })).status, 200);
    assert.equal((await call('PUT', `${P_}/repos/r/stacks/1/description`, { description: null, title: 'Only' })).status, 200);
    assert.equal((await call('PUT', `${P_}/repos/r/commits/${sha}/pr`, { body: null })).status, 200);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'assets', name)), PNG);
    assert.ok(fs.existsSync(path.join(dir, 'assets', `${name}.yaml`)));
  });
});
