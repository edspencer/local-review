// The demo GIF: one review round trip, in a dozen seconds. The reviewer comments on a range of lines, the agent's reply
// arrives in the thread live (written into the review's YAML file, as an agent would), the reviewer resolves the thread
// and marks the PR ready, and the sidebar's stack tally moves on.
//
//   npm run docs:media:gif                       seed a throwaway copy of the demo, boot the rig, shoot, encode
//   npm run docs:media:gif -- --skip-shoot       re-encode the frames from the last run
//
// Output, in tools/docs-media/out/: demo.gif (the README), demo.mp4 and demo-poster.png (the landing page's hero);
// `npm run docs:media:sync` copies them into place.
// It mutates its data (it adds a thread), so it always runs on a fresh seed under the system temp dir, never on demo/out.
// Needs Chromium (README.md) and ffmpeg on PATH.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from 'playwright';
import { parseDocument } from 'yaml';
import { seed } from '../../demo/seed.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const WORK = path.join(os.tmpdir(), 'local-review-demo-gif');
const FRAMES = path.join(WORK, 'frames');
const SKIP_SHOOT = process.argv.includes('--skip-shoot');

/** The window the story is shot in (CSS px, at 2x), and the width the GIF is scaled to. */
const VIEWPORT = { width: 1100, height: 690 };
const GIF_WIDTH = 1400;

const PR = 'f8'; // orchard-api "Send promotion notifications": a draft, the last PR of stack 3
const FILE = 'internal/notify/relay.go';
const LINES = [28, 32] as const; // the send loop: a failed send is retried every tick, forever
const COMMENT = 'A send that keeps failing is retried every tick, forever. Can we cap the attempts?';
const REPLY = 'Capped at 5 attempts with backoff in the amended commit; after that the message is marked failed and logged once.';

// ------------------------------------------------------------------------------------------------ the rig

const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

async function bootRig(seedDir: string): Promise<{ base: string; proc: ChildProcess }> {
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
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error(`the rig didn't start:\n${log}`);
}

const STILL_CSS = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
::-webkit-scrollbar { display: none; }
* { scrollbar-width: none !important; }
#demo-cursor { position: fixed; z-index: 99999; width: 22px; height: 22px; pointer-events: none; left: -40px; top: -40px;
  filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / .35)); }
`;
const CURSOR_SVG = `<svg viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10.1 13 L16 13 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

/** Edit the demo thread in a review file the way an agent does: parse, change, write the whole file atomically. */
function editReview(file: string, edit: (thread: any, doc: ReturnType<typeof parseDocument>) => void) {
  const doc = parseDocument(fs.readFileSync(file, 'utf8'));
  const t = (doc.get('threads') as any).items.find((it: any) => String(it.getIn(['comments', 0, 'body']) ?? '').startsWith(COMMENT.slice(0, 30)));
  if (!t) throw new Error(`the demo thread isn't in ${file}`);
  edit(t, doc);
  fs.writeFileSync(file + '.tmp', doc.toString());
  fs.renameSync(file + '.tmp', file);
}

// ------------------------------------------------------------------------------------------------ the shoot

interface Frame {
  file: string;
  hold: number; // seconds
}

async function shoot(): Promise<Frame[]> {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  const seedDir = path.join(WORK, 'seed');
  const m = seed(seedDir);
  const sha = m.lock.repos['orchard-api'][PR];
  const reviewFile = path.join(m.localReviewHome, 'projects', 'waitlists', 'reviews', 'orchard-api', `${sha}.yaml`);

  const { base, proc } = await bootRig(seedDir);
  const browser = await chromium.launch();
  const frames: Frame[] = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'UTC' });
    await context.clock.setFixedTime(new Date(m.now));
    await context.addInitScript('globalThis.__name = (f) => f;');
    await context.addInitScript(() => localStorage.setItem('lr.diffStyle', '"unified"'));
    const page = await context.newPage();

    let n = 0;
    const snap = async (hold: number) => {
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(FRAMES, `${String(n++).padStart(3, '0')}.png`);
      await page.screenshot({ path: file });
      frames.push({ file, hold });
    };
    const cursorTo = async (x: number, y: number) => {
      await page.mouse.move(x, y);
      await page.evaluate(([x, y]) => {
        let c = document.getElementById('demo-cursor');
        if (!c) {
          c = document.createElement('div');
          c.id = 'demo-cursor';
          c.innerHTML = (globalThis as any).__cursorSvg;
          document.body.appendChild(c);
        }
        c.style.left = `${x - 3}px`;
        c.style.top = `${y - 2}px`;
      }, [x, y]);
    };
    // out of the way: the empty foot of the file tree, where nothing has a hover state
    const park = () => cursorTo(440, VIEWPORT.height - 24);
    const centre = async (l: Locator) => {
      const b = (await l.boundingBox())!;
      return [b.x + b.width / 2, b.y + b.height / 2] as const;
    };
    const glide = async (l: Locator, steps = 0) => {
      // a couple of in-between frames make the pointer's travel readable without filming it
      const [x, y] = await centre(l);
      const from = await page.evaluate(() => {
        const c = document.getElementById('demo-cursor');
        return c ? [parseFloat(c.style.left) + 3, parseFloat(c.style.top) + 2] : null;
      });
      if (from && steps)
        for (let i = 1; i <= steps; i++) {
          await cursorTo(from[0] + ((x - from[0]) * i) / (steps + 1), from[1] + ((y - from[1]) * i) / (steps + 1));
          await snap(0.06);
        }
      await cursorTo(x, y);
    };

    await page.addInitScript((svg: string) => ((globalThis as any).__cursorSvg = svg), CURSOR_SVG);
    await page.goto(`${base}/waitlists/orchard-api/${sha.slice(0, 8)}?tab=files&file=${encodeURIComponent(FILE)}`, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: STILL_CSS });
    const card = page.locator(`.file-card:has-text("${FILE}")`).first();
    const lineNo = (l: number) => card.locator(`[data-column-number="${l}"]`).first();
    await lineNo(LINES[1]).waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const showLines = async () => {
      // the send loop near the top of the window, the PR header scrolled off
      await lineNo(LINES[0]).evaluate((el) => {
        el.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -170);
      });
      await page.waitForTimeout(300);
    };
    // 0. the PR, a draft; then down to the code
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await park();
    await snap(1.8);
    await showLines();
    await snap(1.0);

    // 1. select the lines by dragging down their numbers: the comment form opens
    await glide(lineNo(LINES[0]), 3);
    await snap(0.3);
    await page.mouse.down();
    for (let l = LINES[0] + 1; l <= LINES[1]; l++) {
      await glide(lineNo(l));
      await snap(0.08);
    }
    await page.mouse.up();
    const textarea = card.locator('textarea').first();
    await textarea.waitFor({ state: 'visible' });
    await snap(0.5);

    // 2. type the comment, a few characters a frame
    await textarea.focus();
    for (let i = 0; i < COMMENT.length; ) {
      const step = Math.min(6, COMMENT.length - i);
      await page.keyboard.type(COMMENT.slice(i, i + step));
      i += step;
      await snap(0.06);
    }
    await snap(0.6);
    const submit = card.locator('button:has-text("Comment")').last();
    await glide(submit, 2);
    await snap(0.35);
    await submit.click();
    const thread = card.locator('.thread').filter({ hasText: COMMENT.slice(0, 30) }).first();
    await thread.waitFor({ state: 'visible' });
    // The server stamps the comment with the real time, but the page's clock is pinned to the demo's "now" (so the
    // seeded ages hold still), which would make the new comment weeks old. Re-date it to the demo's "now".
    for (let i = 0; !fs.readFileSync(reviewFile, 'utf8').includes(COMMENT.slice(0, 30)); i++) {
      if (i > 50) throw new Error(`the new thread never reached ${reviewFile}`);
      await page.waitForTimeout(100);
    }
    editReview(reviewFile, (t) => t.get('comments').get(0).set('created', m.now));
    await thread.locator(':text("just now")').first().waitFor({ state: 'visible', timeout: 10_000 });
    await showLines();
    await page.waitForTimeout(500); // the range tint is applied after the diff re-renders
    await park();
    await snap(1.4);

    // 3. the agent replies, in the YAML file, the way an agent would; the server pushes it to the page
    editReview(reviewFile, (t, doc) => t.get('comments').add(doc.createNode({ author: 'claude', created: new Date(Date.parse(m.now) + 20_000).toISOString(), body: REPLY + '\n' })));
    await thread.locator(`:text("${REPLY.slice(0, 24)}")`).first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(300);
    await snap(2.6);

    // 4. resolve it
    const resolve = thread.locator('button:has-text("Resolve conversation")').first();
    await resolve.scrollIntoViewIfNeeded();
    await glide(resolve, 3);
    await snap(0.4);
    await resolve.click();
    await page.waitForTimeout(400);
    await snap(1.4);

    // 5. back up to the header, and mark the PR ready: the sidebar's badge and stack tally follow
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const ready = page.locator('.readiness-control button:has-text("Ready")').first();
    await glide(ready, 3);
    await snap(0.4);
    await ready.click();
    await page.locator('.sidebar :text("2/3 ready")').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(300);
    await snap(0.6);
    await park();
    await snap(2.8);

    // the leak scan, as for every still (capture.ts)
    const text = await page.evaluate(() => document.body.innerText);
    const leak = text.match(/\/(?:tmp|data|var|private|Users|home|root)\/|127\.0\.0\.1|localhost:\d+/);
    if (leak) throw new Error(`the page shows ${JSON.stringify(leak[0])}; not encoding`);
    await context.close();
  } finally {
    await browser.close();
    proc.kill();
  }
  fs.writeFileSync(path.join(WORK, 'frames.json'), JSON.stringify(frames, null, 2));
  return frames;
}

// ------------------------------------------------------------------------------------------------ the encode

const ff = (args: string[]) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });

function encode(frames: Frame[]) {
  // the concat demuxer: each frame with its hold (the last one listed twice, which is how concat honours its duration)
  const list = path.join(WORK, 'frames.txt');
  const lines = frames.flatMap((f) => [`file '${f.file}'`, `duration ${f.hold}`]);
  lines.push(`file '${frames.at(-1)!.file}'`);
  fs.writeFileSync(list, lines.join('\n') + '\n');
  fs.mkdirSync(OUT, { recursive: true });

  const gif = path.join(OUT, 'demo.gif');
  const scale = `scale=${GIF_WIDTH}:-2:flags=lanczos`;
  // stats_mode=diff spends the palette on what changes; rectangle diff_mode only re-encodes the changed region per frame
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=15,${scale},split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', gif]);

  const mp4 = path.join(OUT, 'demo.mp4');
  // the landing hero shows it ~600 CSS px wide, so the GIF's width is still 2x there
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=30,${scale},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', '-an', mp4]);
  // the opening frame (the PR, a draft) is the poster: what shows before it plays, and instead of it with reduced motion
  fs.copyFileSync(frames[0].file, path.join(OUT, 'demo-poster.png'));

  const total = frames.reduce((s, f) => s + f.hold, 0);
  for (const f of [gif, mp4]) console.log(`  ✓ ${path.relative(process.cwd(), f)} (${(fs.statSync(f).size / 1e6).toFixed(2)} MB)`);
  console.log(`  ${frames.length} frames, ${total.toFixed(1)}s`);
}

async function main() {
  const frames = SKIP_SHOOT ? (JSON.parse(fs.readFileSync(path.join(WORK, 'frames.json'), 'utf8')) as Frame[]) : await shoot();
  encode(frames);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
