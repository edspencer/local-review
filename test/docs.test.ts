// The docs site (website/, a separate package) keeps copies of a few things from the app, because Cloudflare builds
// it with website/ as its root and can't import from ../server. These tests keep the copies in step.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PORT } from '../server/port.ts';
import { SHOTS } from '../tools/docs-media/shots.ts';
import { referencedShots } from '../tools/docs-media/sync.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBSITE = path.join(ROOT, 'website');
const DOCS = path.join(WEBSITE, 'src', 'content', 'docs');
// Plain .mjs files without types: imported by URL, so they type as `any`.
const load = (rel: string): Promise<any> => import(pathToFileURL(path.join(ROOT, rel)).href);

function files(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p, ext) : ext.test(e.name) ? [p] : [];
  });
}

describe('docs site', () => {
  test("website/src/site.mjs's DEFAULT_PORT is server/port.ts's", async () => {
    const site = await load('website/src/site.mjs');
    assert.equal(site.DEFAULT_PORT, DEFAULT_PORT);
    assert.equal(site.LOCAL_URL, `http://localhost:${DEFAULT_PORT}`);
  });

  test('the agent guide pages are in sync with AGENT-GUIDE.md (cd website && node scripts/sync-agent-guide.mjs)', async () => {
    const { renderPages } = await load('website/scripts/sync-agent-guide.mjs');
    const pages: Record<string, string> = renderPages(fs.readFileSync(path.join(ROOT, 'AGENT-GUIDE.md'), 'utf8'));
    assert.ok(Object.keys(pages).length >= 4);
    for (const [rel, text] of Object.entries(pages)) {
      const file = path.join(DOCS, rel);
      assert.ok(fs.existsSync(file), `${rel} is missing`);
      assert.equal(fs.readFileSync(file, 'utf8'), text, `website/src/content/docs/${rel} is stale`);
    }
  });

  // Docs may write the port out (in code blocks, which can't interpolate it), so every `localhost:<port>` must be the
  // default, the dev API port next to it, or one of the few other ports that are mentioned on purpose.
  test(`every localhost:<port> in the docs is ${DEFAULT_PORT}, or deliberately another`, () => {
    const allowed = new Set([
      DEFAULT_PORT,
      DEFAULT_PORT + 1, // npm run dev's API
      5000, // the default before 0.2.0, in the upgrade notes
      5050, // the example of another port
    ]);
    const docs = [
      ...files(DOCS, /\.mdx?$/),
      ...['README.md', 'AGENT-GUIDE.md', 'CONTRIBUTING.md', 'examples/project.example.yaml'].map((f) => path.join(ROOT, f)),
    ];
    const bad: string[] = [];
    for (const f of docs) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/localhost:(\d+)/g)) {
        if (!allowed.has(Number(m[1]))) bad.push(`${path.relative(ROOT, f)}: ${m[0]}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test('every docs page is in the sidebar', () => {
    const config = fs.readFileSync(path.join(WEBSITE, 'astro.config.mjs'), 'utf8');
    const slugs = new Set([...config.matchAll(/slug: '([^']+)'/g)].map((m) => m[1]));
    const pages = files(DOCS, /\.mdx?$/).map((f) => path.relative(DOCS, f).replace(/\.mdx?$/, ''));
    assert.deepEqual(pages.filter((p) => !slugs.has(p)), [], 'pages missing from the sidebar in website/astro.config.mjs');
    assert.deepEqual([...slugs].filter((s) => !pages.includes(s)), [], 'sidebar entries without a page');
  });

  // Pages mark where a screenshot is wanted with `SHOT: <id>` comments, and the landing page had <Placeholder> frames;
  // the capture rig fills them (tools/docs-media/README.md). None may ship.
  test('no screenshot placeholders are left in the docs, the landing page or the README', () => {
    const left = [...files(path.join(WEBSITE, 'src'), /\.(mdx?|astro|ts)$/), path.join(ROOT, 'README.md')].flatMap((f) =>
      fs.readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (/\bSHOT:|<Placeholder\b/.test(line) ? [`${path.relative(ROOT, f)}:${i + 1}`] : [])),
    );
    assert.deepEqual(left, []);
  });

  test('every screenshot the site uses is a shot in tools/docs-media/shots.ts, and is committed', () => {
    const names = new Set([...SHOTS.map((s) => s.name), 'demo-poster']);
    const refs = referencedShots();
    assert.ok(refs.length >= 20);
    for (const r of refs) {
      assert.ok(names.has(r.name), `${r.from}: ${r.name} isn't a shot in shots.ts`);
      assert.ok(fs.existsSync(path.join(WEBSITE, 'src', 'assets', r.dir, `${r.name}.png`)), `${r.from}: website/src/assets/${r.dir}/${r.name}.png is missing (npm run docs:media:sync)`);
    }
  });

  test("the README's images are committed where its raw.githubusercontent.com URLs point", () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const urls = [...readme.matchAll(/https:\/\/raw\.githubusercontent\.com\/edspencer\/local-review\/main\/([^"')\s]+)/g)].map((m) => m[1]);
    assert.ok(urls.some((u) => u.startsWith('docs/media/')));
    for (const u of urls) assert.ok(fs.existsSync(path.join(ROOT, u)), `README.md points at ${u}, which isn't in the repo`);
  });
});
