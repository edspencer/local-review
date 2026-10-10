// Generate every derived brand asset from the hand-authored mark (brand/mark.svg):
//
//   lockup-light.svg, lockup-dark.svg   mark + "Local Review" wordmark (text converted to paths)
//   favicon.svg                         the mark, as is
//   favicon.ico                         16/32/48 (PNG-in-ICO)
//   apple-touch-icon.png                180, full-bleed (iOS rounds the corners itself)
//   icon-192.png, icon-512.png          web manifest icons
//   og-image.png                        1200×630 Open Graph / Twitter card
//   social-preview.png                  1280×640 GitHub social preview
//
// Run: `node brand/generate.mjs`. No extra dependencies: it uses @resvg/resvg-js and opentype.js, which the server
// already depends on, and the OFL fonts bundled in server/fonts/. Output is deterministic, so re-run it and commit the
// results whenever the mark, colours or tagline change.
import { Resvg } from '@resvg/resvg-js';
import opentype from 'opentype.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAND = path.dirname(fileURLToPath(import.meta.url));
const FONTS = path.join(BRAND, '..', 'server', 'fonts');
const out = (name) => path.join(BRAND, name);

// Brand colours (documented in brand/README.md; the app header uses the same values in src/styles.css).
const PLUM = '#4a1942';
const PLUM_2 = '#5c1f52'; // the header gradient's far end
const AMBER = '#e8a33d';
const INK = '#2b0f27'; // text on amber
const LILAC = '#ead6e5'; // light text on plum

const TAGLINE = 'Review your PR stacks before you create them';
const taglineLines = [TAGLINE.slice(0, TAGLINE.indexOf(' before')), TAGLINE.slice(TAGLINE.indexOf(' before') + 1)];
const URL_TEXT = 'local-review.edspencer.net';

const markSvg = fs.readFileSync(out('mark.svg'), 'utf8');
/** The mark's drawing, without the outer <svg>, title or comments, for nesting into bigger compositions. */
const markInner = markSvg
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')
  .replace(/<title>[\s\S]*?<\/title>/, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\n\s*\n/g, '\n')
  .trim();
const nestedMark = (x, y, size, inner = markInner) =>
  `<g transform="translate(${x} ${y}) scale(${size / 32})">${inner}</g>`;

const loadFont = (file) => {
  const b = fs.readFileSync(path.join(FONTS, file));
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const interBold = loadFont('Inter_700Bold.ttf');

/** Lay out `text` in `font` as one SVG path (with kerning and optional tracking in em), so the SVG needs no font. */
function textPath(font, text, size, x, baseline, trackingEm = 0) {
  const scale = size / font.unitsPerEm;
  const glyphs = [...text].map((ch) => font.charToGlyph(ch)); // no GSUB shaping: opentype.js chokes on Inter's
  let pen = x;
  const d = [];
  glyphs.forEach((g, i) => {
    d.push(g.getPath(pen, baseline, size).toPathData(2));
    pen += g.advanceWidth * scale + trackingEm * size;
    if (i < glyphs.length - 1) pen += font.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  return { d: d.join(''), width: pen - x - trackingEm * size };
}

// ---------- lockups ----------
// 48 units tall: the 48×48 mark, a 14-unit gap, then the wordmark with its cap height centred on the mark.
function lockup(textColour) {
  const size = 30;
  const capHeight = (interBold.tables.os2.sCapHeight / interBold.unitsPerEm) * size;
  const { d, width } = textPath(interBold, 'Local Review', size, 62, 24 + capHeight / 2, -0.01);
  const w = Math.ceil(62 + width + 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 48" width="${w * 2}" height="96">
  <title>Local Review</title>
  ${nestedMark(0, 0, 48)}
  <path fill="${textColour}" d="${d}"/>
</svg>
`;
}
fs.writeFileSync(out('lockup-light.svg'), lockup(PLUM)); // for light backgrounds
fs.writeFileSync(out('lockup-dark.svg'), lockup('#ffffff')); // for dark backgrounds
fs.writeFileSync(out('favicon.svg'), markSvg);

// ---------- raster icons ----------
const render = (svg, width) =>
  new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles: fs.readdirSync(FONTS).filter((f) => f.endsWith('.ttf')).map((f) => path.join(FONTS, f)), loadSystemFonts: false, defaultFontFamily: 'Inter' },
  }).render().asPng();

const fullBleed = markSvg.replace(/(<rect id="tile"[^>]*?) rx="[\d.]+"/, '$1');
fs.writeFileSync(out('apple-touch-icon.png'), render(fullBleed, 180));
fs.writeFileSync(out('icon-192.png'), render(markSvg, 192));
fs.writeFileSync(out('icon-512.png'), render(markSvg, 512));

// favicon.ico: an ICONDIR followed by one PNG per size (PNG entries are valid ICO since Windows Vista).
const icoSizes = [16, 32, 48];
const pngs = icoSizes.map((s) => render(markSvg, s));
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach((png, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(icoSizes[i], e); // width
  header.writeUInt8(icoSizes[i], e + 1); // height
  header.writeUInt8(0, e + 2); // palette colours
  header.writeUInt8(0, e + 3); // reserved
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(png.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
fs.writeFileSync(out('favicon.ico'), Buffer.concat([header, ...pngs]));

// ---------- social cards ----------
// Plum like the app header, with its amber underline along the bottom, a large faint copy of the stack bleeding off
// the right edge, and the lockup, tagline and URL on the left. Everything scales from the card's height.
function card(W, H) {
  const k = H / 630;
  const pad = Math.round(88 * k);
  const markSize = Math.round(124 * k);
  const titleSize = Math.round(96 * k);
  const capHeight = (interBold.tables.os2.sCapHeight / interBold.unitsPerEm) * titleSize;
  const title = textPath(interBold, 'Local Review', titleSize, pad + markSize + Math.round(32 * k), 0, -0.015);
  const titleY = Math.round(232 * k);
  const pillW = Math.round(176 * k);
  const pillH = Math.round(40 * k);
  // on a plum background the plum tile needs a faint edge, or it reads as a stray dark square
  const onPlum = markInner.replace(/(<rect id="tile"[^>]*?)\/>/, '$1 stroke="#ffffff" stroke-opacity="0.22" stroke-width="0.5"/>');
  // the watermark: the mark's cards alone (no tile), huge and faint
  const cardsOnly = markInner.replace(/<rect id="tile"[^>]*\/>/, '').replace(/fill="#4a1942"/g, 'fill="none"');
  const wm = Math.round(560 * k);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${PLUM}"/><stop offset="1" stop-color="${PLUM_2}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g opacity="0.13">${nestedMark(W - wm * 0.62, H * 0.12, wm, cardsOnly)}</g>
  <rect y="${H - Math.round(14 * k)}" width="${W}" height="${Math.round(14 * k)}" fill="${AMBER}"/>
  ${nestedMark(pad, titleY - capHeight / 2 - markSize / 2, markSize, onPlum)}
  <path fill="#ffffff" transform="translate(0 ${titleY})" d="${title.d}"/>
  <g font-family="Inter">
    ${taglineLines.map((line, i) => `<text x="${pad}" y="${Math.round((360 + 58 * i) * k)}" font-size="${Math.round(46 * k)}" font-weight="400" fill="${LILAC}">${line}</text>`).join('\n    ')}
    <rect x="${pad}" y="${Math.round(486 * k)}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${AMBER}"/>
    <text x="${pad + pillW / 2}" y="${Math.round(486 * k) + pillH / 2 + Math.round(8 * k)}" text-anchor="middle" font-size="${Math.round(22 * k)}" font-weight="600" fill="${INK}">not on GitHub</text>
    <text x="${pad + pillW + Math.round(24 * k)}" y="${Math.round(486 * k) + pillH / 2 + Math.round(9 * k)}" font-family="JetBrains Mono" font-size="${Math.round(26 * k)}" fill="${AMBER}">${URL_TEXT}</text>
  </g>
</svg>`;
}
fs.writeFileSync(out('og-image.png'), render(card(1200, 630), 1200));
fs.writeFileSync(out('social-preview.png'), render(card(1280, 640), 1280));

console.log('Wrote brand/: lockup-light.svg lockup-dark.svg favicon.svg favicon.ico apple-touch-icon.png icon-192.png icon-512.png og-image.png social-preview.png');
