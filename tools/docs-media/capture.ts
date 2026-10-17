// The capture rig: boots Local Review on the demo test bed and takes every shot in shots.ts, deterministically.
//
//   npm run docs:media                        seed demo/out if needed, boot the rig, take every shot
//   npm run docs:media -- --only crop-readiness,pr-threads
//   npm run docs:media -- --base http://localhost:5050    use a rig you started yourself (serve.sh)
//   npm run docs:media -- --out /tmp/shots --seed /tmp/demo
//
// Output: <out>/<name>.png (light mode, 2x), <out>/provenance.json (what each shot is of, and from which build and
// seed), <out>/contact-sheet.png (all of them on one page, for checking at a glance). Needs Chromium:
// `npx playwright install chromium` (README.md).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { DEFAULT_PORT } from '../../server/port.ts';
import { seed, type Manifest } from '../../demo/seed.ts';
import { DEFAULT_VIEWPORT, SHOTS, type ComposeContext, type Crop, type Rig, type Shot } from './shots.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = path.resolve(arg('--out') ?? path.join(HERE, 'out'));
const SEED = path.resolve(arg('--seed') ?? path.join(ROOT, 'demo', 'out'));
const ONLY = arg('--only')?.split(',');
let BASE = arg('--base');

/** Device pixels per CSS pixel for every shot (a crop's `zoom` multiplies it). */
const SCALE = 2;

// ------------------------------------------------------------------------------------------------ the rig

function loadSeed(): Manifest {
  const file = path.join(SEED, 'manifest.json');
  if (!fs.existsSync(file)) {
    console.log(`No demo seed in ${SEED}: seeding it`);
    return seed(SEED);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

async function bootRig(seedDir = SEED): Promise<{ base: string; proc: ChildProcess }> {
  const port = await freePort();
  const proc = spawn(path.join(HERE, 'serve.sh'), [seedDir, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 600; i++) {
    if (proc.exitCode !== null) throw new Error(`the rig exited (${proc.exitCode}):\n${log}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, proc };
    } catch {
      /* not up yet (the first run builds dist/) */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error(`the rig didn't start:\n${log}`);
}

// ------------------------------------------------------------------------------------------------ hygiene

/**
 * What the shots must never show: paths and hosts of the machine they were taken on, and anything that isn't the
 * demo's fictional world. Extra patterns (your own hostnames, say) go in $LR_LEAK_EXTRA, as regex alternatives;
 * they're not written here because this file is public.
 */
function leakPattern(port: string) {
  return new RegExp(
    [
      String.raw`/(?:tmp|data|var|private|Users|home|root)/`,
      String.raw`[A-Za-z]:\\`,
      String.raw`127\.0\.0\.1`,
      String.raw`\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+`,
      String.raw`localhost:(?!${DEFAULT_PORT}\b)\d+`,
      String.raw`[\w.+-]+@(?![\w-]+\.example\b)[\w-]+\.[a-z]{2,}`,
      `:${port}\\b`,
      ...(process.env.LR_LEAK_EXTRA ? [process.env.LR_LEAK_EXTRA] : []),
    ].join('|'),
    'g',
  );
}

async function assertClean(page: Page, name: string, port: string) {
  const text = await page.evaluate(() => document.body.innerText);
  const found = [...new Set(text.match(leakPattern(port)) ?? [])];
  if (found.length) throw new Error(`${name}: the page shows ${found.map((f) => JSON.stringify(f)).join(', ')}; shot not written`);
}

/** No animations, transitions, blinking carets or hover leftovers; scrollbars hidden. */
const STILL_CSS = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
::-webkit-scrollbar { display: none; }
* { scrollbar-width: none !important; }
`;

// ------------------------------------------------------------------------------------------------ shooting

/** `local-review <args>` from source against a data home, with the same scrubbed environment as serve.sh. */
function runCli(home: string, args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], // stderr is in the error if it fails; otherwise only chatter (`Added …`)
    env: { PATH: process.env.PATH, HOME: home, LOCAL_REVIEW_HOME: path.join(home, '.local-review'), LOCAL_REVIEW_USER: 'maya', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', TZ: 'UTC', LANG: 'C.UTF-8' },
  });
}

/**
 * A rig other than the demo seed (shots.ts `rig:`): a throwaway copy of the seed, or an empty data home, in the
 * system temp dir, prepared by the rig's own steps and served on a port of its own. Never demo/out itself.
 */
async function bootExtraRig(rig: Rig): Promise<{ base: string; proc: ChildProcess; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lr-docs-media-${rig.name}-`));
  if (rig.from === 'demo') fs.cpSync(SEED, dir, { recursive: true });
  else {
    fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ generator: 'local-review docs-media', rig: rig.name }) + '\n');
  }
  const home = path.join(dir, 'home');
  rig.prepare?.({
    file: (rel) => path.join(home, rel),
    cli: (args) => runCli(home, args),
  });
  const r = await bootRig(dir);
  return { ...r, dir };
}

/** For composed shots: earlier shots, seed files, and the CLI run against the seed (from source, scrubbed env). */
function composeContext(m: Manifest): ComposeContext {
  return {
    shot: (name) => {
      const f = path.join(OUT, `${name}.png`);
      if (!fs.existsSync(f)) throw new Error(`compose: no ${name}.png yet (shoot it first, earlier in SHOTS)`);
      return `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
    },
    seedFile: (rel) => fs.readFileSync(path.join(m.home, rel), 'utf8'),
    cli: (args) => runCli(m.home, args),
  };
}

function resolveRoute(route: string, m: Manifest) {
  return route.replace(/\{([^:}]+):([^}]+)\}/g, (_, repo: string, key: string) => {
    const sha = m.lock.repos[repo]?.[key];
    if (!sha) throw new Error(`route ${route}: no commit "${key}" in ${repo} (see demo/shas.json)`);
    return sha.slice(0, 8);
  });
}

/** Wait until the app has rendered real content: no "Loading…", fonts loaded, images decoded. */
async function settle(page: Page) {
  await page.waitForFunction(() => !/Loading…|Loading the/.test(document.querySelector('.main, main, #root')?.textContent ?? 'Loading…'), null, { timeout: 30_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => (i.complete ? null : i.decode().catch(() => null))));
  });
  await page.waitForTimeout(300);
}

async function cropBox(page: Page, crop: Crop) {
  const sels = Array.isArray(crop.selector) ? crop.selector : [crop.selector];
  const first = page.locator(sels[0]).first();
  await first.waitFor({ state: 'visible', timeout: 15_000 });
  await first.scrollIntoViewIfNeeded();
  const boxes = [];
  for (const s of sels) {
    const b = await page.locator(s).first().boundingBox();
    if (!b) throw new Error(`crop: ${s} has no box`);
    boxes.push(b);
  }
  const p = typeof crop.pad === 'object' ? crop.pad : { top: crop.pad, right: crop.pad, bottom: crop.pad, left: crop.pad };
  const pad = { top: p.top ?? 16, right: p.right ?? 16, bottom: p.bottom ?? 16, left: p.left ?? 16 };
  const vp = page.viewportSize()!;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad.left);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad.top);
  const right = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad.right);
  const bottom = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad.bottom);
  if (Math.max(...boxes.map((b) => b.y + b.height)) + pad.bottom > vp.height + 1) console.warn(`  ! crop runs past the viewport (${vp.height}px): give the shot a taller viewport`);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
}

async function takeShot(browser: Browser, shot: Shot, m: Manifest, base: string) {
  const port = new URL(base).port;
  const crop = typeof shot.capture === 'object' ? shot.capture : null;
  const viewport = shot.viewport ?? DEFAULT_VIEWPORT;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: SCALE * (crop?.zoom ?? 1),
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-GB',
    timezoneId: 'UTC',
  });
  // relative times ("2 days ago") are computed from Date.now(): pin it to the demo's "now"
  await context.clock.setFixedTime(new Date(m.now));
  // tsx (esbuild) wraps named functions in __name(); functions sent to the page need it to exist there too
  await context.addInitScript('globalThis.__name = (f) => f;');
  await context.addInitScript((entries: Record<string, string>) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, shot.storage ?? {});
  const page = await context.newPage();
  try {
    let route: string;
    if (shot.compose) {
      route = '(composed)';
      await page.setContent(shot.compose(composeContext(m)), { waitUntil: 'load' });
      await page.addStyleTag({ content: STILL_CSS });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((i) => i.decode().catch(() => null)));
      });
    } else {
      if (!shot.route) throw new Error(`${shot.name}: no route (and no compose)`);
      route = resolveRoute(shot.route, m);
      await page.goto(base + route, { waitUntil: 'domcontentloaded' });
      await page.addStyleTag({ content: STILL_CSS });
      await settle(page);
    }
    for (const a of shot.actions ?? []) {
      if ('click' in a) await page.locator(a.click).first().click();
      else if ('hover' in a) await page.locator(a.hover).first().hover();
      else if ('press' in a) await page.keyboard.press(a.press);
      else if ('waitFor' in a) await page.locator(a.waitFor).first().waitFor({ state: 'visible', timeout: 15_000 });
      else if ('wait' in a) await page.waitForTimeout(a.wait);
      else if ('fill' in a) await page.locator(a.fill).first().fill(a.text);
      else if ('reload' in a) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.addStyleTag({ content: STILL_CSS });
        await settle(page);
      }
      else if ('scrollTo' in a)
        await page
          .locator(a.scrollTo)
          .first()
          .evaluate((el, { block, offset }) => {
            el.scrollIntoView({ block });
            if (offset) window.scrollBy(0, offset);
          }, { block: a.block ?? 'start', offset: a.offset ?? 0 });
      await page.waitForTimeout(150);
    }
    await page.mouse.move(0, viewport.height - 1); // no stray hover state
    if (!shot.compose) await settle(page);
    await assertClean(page, shot.name, port);
    const file = path.join(OUT, `${shot.name}.png`);
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (crop) {
      clip = await cropBox(page, crop);
      await page.screenshot({ path: file, clip });
    } else await page.screenshot({ path: file, fullPage: shot.capture === 'page' });
    return { file, route, viewport, scale: SCALE * (crop?.zoom ?? 1), clip, title: await page.title() };
  } finally {
    await context.close();
  }
}

/** One image with every shot on it, labelled, to look over a run at a glance. */
async function contactSheet(browser: Browser, files: string[]) {
  const cells = files
    .map((f) => {
      const data = fs.readFileSync(f).toString('base64');
      return `<figure><img src="data:image/png;base64,${data}"><figcaption>${path.basename(f)}</figcaption></figure>`;
    })
    .join('');
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 });
  await page.addInitScript('globalThis.__name = (f) => f;');
  await page.setContent(`<style>
    body { margin: 16px; font: 13px system-ui, sans-serif; background: #eee; }
    main { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; align-items: start; }
    figure { margin: 0; background: white; padding: 8px; border-radius: 6px; }
    img { width: 100%; border: 1px solid #ddd; display: block; }
    figcaption { margin-top: 6px; color: #444; }
  </style><main>${cells}</main>`);
  await page.evaluate(async () => Promise.all([...document.images].map((i) => i.decode())));
  const out = path.join(OUT, 'contact-sheet.png');
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  return out;
}

async function main() {
  const m = loadSeed();
  const shots = SHOTS.filter((s) => !ONLY || ONLY.includes(s.name));
  if (ONLY) for (const n of ONLY) if (!SHOTS.some((s) => s.name === n)) throw new Error(`no shot named ${n}`);
  fs.mkdirSync(OUT, { recursive: true });

  let rig: ChildProcess | undefined;
  if (!BASE) {
    console.log('Booting the rig (serve.sh)…');
    const r = await bootRig();
    BASE = r.base;
    rig = r.proc;
  }
  const extra = new Map<string, Awaited<ReturnType<typeof bootExtraRig>>>();
  const baseFor = async (shot: Shot) => {
    if (!shot.rig) return BASE!;
    if (!extra.has(shot.rig.name)) {
      console.log(`Booting the "${shot.rig.name}" rig…`);
      extra.set(shot.rig.name, await bootExtraRig(shot.rig));
    }
    return extra.get(shot.rig.name)!.base;
  };
  const browser = await chromium.launch();
  const provenance: Record<string, unknown> = {};
  const seedHash = crypto.createHash('sha256').update(JSON.stringify(m.lock)).digest('hex').slice(0, 12);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const failures: string[] = [];
  try {
    for (const shot of shots) {
      try {
        const r = await takeShot(browser, shot, m, await baseFor(shot));
        console.log(`  ✓ ${path.relative(process.cwd(), r.file)}`);
        provenance[`${shot.name}.png`] = { doc: shot.doc, ...(shot.rig ? { rig: shot.rig.name } : {}), route: r.route, viewport: r.viewport, scale: r.scale, ...(r.clip ? { clip: r.clip } : {}), page_title: r.title, now: m.now };
      } catch (e) {
        failures.push(`${shot.name}: ${(e as Error).message.split('\n')[0]}`);
        console.error(`  ✗ ${shot.name}: ${(e as Error).message}`);
      }
    }
    const all = SHOTS.map((s) => path.join(OUT, `${s.name}.png`)).filter((f) => fs.existsSync(f));
    console.log(`  ✓ ${path.relative(process.cwd(), await contactSheet(browser, all))}`);
  } finally {
    await browser.close();
    rig?.kill();
    for (const r of extra.values()) {
      r.proc.kill();
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  }
  const provFile = path.join(OUT, 'provenance.json');
  const prev = fs.existsSync(provFile) && ONLY ? JSON.parse(fs.readFileSync(provFile, 'utf8')).shots : {};
  fs.writeFileSync(provFile, JSON.stringify({ app_version: pkg.version, seed: seedHash, shots: { ...prev, ...provenance } }, null, 2) + '\n');
  if (failures.length) {
    console.error(`\n${failures.length} shot(s) failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
