// Copy the captures the docs site and the README use out of tools/docs-media/out/ and into the places they're committed.
//
//   npm run docs:media:sync      after `npm run docs:media` and `npm run docs:media:gif`
//
// What gets copied is read from the pages themselves, so there's no second list to keep in step: every
// `assets/shots/<shot>.png` or `assets/landing/<shot>.png` referenced under website/src/ is copied from out/<shot>.png.
// Astro optimises those (webp, srcset) at build time, so they're committed as the rig's 2x PNGs. On top of that:
//
//   website/public/demo/demo.mp4     the landing hero's video (gif.ts), served as is
//   docs/media/demo.gif              the README's GIF (gif.ts)
//   docs/media/readme-hero.png       pr-conversation, scaled to 1600px and palette-quantised (ffmpeg): the README is
//                                    read on GitHub and npm, which serve it as is, so it has to be small already
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS } from './shots.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const WEBSITE_SRC = path.join(ROOT, 'website', 'src');

/** Every `assets/(shots|landing)/<name>.png` referenced by a page, component or copy file under website/src. */
export function referencedShots(): { dir: 'shots' | 'landing'; name: string; from: string }[] {
  const found = new Map<string, { dir: 'shots' | 'landing'; name: string; from: string }>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|mdx|astro|ts|mjs)$/.test(e.name))
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/assets\/(shots|landing)\/([\w-]+)\.png/g))
          found.set(`${m[1]}/${m[2]}`, { dir: m[1] as 'shots' | 'landing', name: m[2], from: path.relative(ROOT, p) });
    }
  };
  walk(WEBSITE_SRC);
  return [...found.values()].sort((a, b) => `${a.dir}/${a.name}`.localeCompare(`${b.dir}/${b.name}`));
}

/** Shots that aren't in shots.ts but come from gif.ts. */
const GIF_OUTPUTS = new Set(['demo-poster']);

function put(src: string, dest: string, make?: (src: string, dest: string) => void) {
  if (!fs.existsSync(src)) throw new Error(`${path.relative(ROOT, src)} is missing: run npm run docs:media${src.includes('demo') ? ':gif' : ''} first`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (make) make(src, dest);
  else fs.copyFileSync(src, dest);
  console.log(`  ✓ ${path.relative(ROOT, dest)} (${Math.round(fs.statSync(dest).size / 1024)} KB)`);
}

function readmeHero(src: string, dest: string) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vf', 'scale=1600:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none', '-frames:v', '1', dest]);
}

function main() {
  const names = new Set(SHOTS.map((s) => s.name));
  const refs = referencedShots();
  for (const r of refs) {
    if (!names.has(r.name) && !GIF_OUTPUTS.has(r.name)) throw new Error(`${r.from} uses ${r.dir}/${r.name}.png, but there's no shot named ${r.name} in shots.ts`);
    put(path.join(OUT, `${r.name}.png`), path.join(WEBSITE_SRC, 'assets', r.dir, `${r.name}.png`));
  }
  put(path.join(OUT, 'demo.mp4'), path.join(ROOT, 'website', 'public', 'demo', 'demo.mp4'));
  put(path.join(OUT, 'demo.gif'), path.join(ROOT, 'docs', 'media', 'demo.gif'));
  put(path.join(OUT, 'pr-conversation.png'), path.join(ROOT, 'docs', 'media', 'readme-hero.png'), readmeHero);

  // copies nothing references any more
  for (const dir of ['shots', 'landing'] as const) {
    const d = path.join(WEBSITE_SRC, 'assets', dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d))
      if (f.endsWith('.png') && !refs.some((r) => r.dir === dir && `${r.name}.png` === f)) {
        fs.rmSync(path.join(d, f));
        console.log(`  - ${path.relative(ROOT, path.join(d, f))} (no longer used)`);
      }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
