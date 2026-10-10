// Stack visualization: a project's PR stacks drawn like the sidebar, but wider, as an SVG; and a PNG of it via
// resvg. Everything is rendered on the server with bundled fonts (Inter, JetBrains Mono; OFL, in server/fonts/)
// and text is measured with those fonts' own glyph advances, so the image looks the same everywhere and
// needs no browser or DOM.
import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';
import { Resvg } from '@resvg/resvg-js';
import { FONT_DIR } from './config.js';
import { reconcileBranch } from './branches.js';
import { filesOf } from './commits.js';
import { inspectOrphan, liveCommits } from './context.js';
import { loadPrs } from './prs.js';
import { FOLLOW_ON_COLOR, type LoadedProject, type LoadedRepo } from './projects.js';
import { repoLabel } from '../shared/repoLabel.js';
import { aggregate, num, plural, summary } from '../shared/totals.js';

// ---------------------------------------------------------------- model
export interface VizPr {
  position: number; // 1..n across the repo, as in the sidebar
  sha: string;
  short: string;
  title: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  paths?: string[]; // the files it changes, for a stack's distinct file count
  branch?: string | null; // the PR's branch (display name), shown under its title
  branchMissing?: boolean; // recorded, but no longer in git: drawn struck through
  pr?: number | null; // the GitHub PR number, if it has been published
  merged?: boolean; // landed on GitHub (prs/ `landed:`): a purple number, left out of the totals
}
export interface VizStack {
  label: string; // "Stack 1 · Groundwork", or "Unstacked"
  color: string; // a palette name or #hex
  implicit?: 'unstacked' | 'branch';
  follow_on?: boolean; // parked work: drawn muted, with a "follow-on" tag
  prs: VizPr[];
}
export interface VizRepo {
  name: string;
  branch: string; // the label beside the name (shared/repoLabel.ts); '' for none
  merged?: boolean; // the label is `merged`: nothing live, its PRs landed (purple)
  stacks: VizStack[];
  error?: string | null;
}
export interface VizModel {
  title: string;
  repos: VizRepo[];
  current?: { repo: string; sha: string } | null; // the highlighted PR
}
export type VizScope = 'project' | 'repo' | 'stack';
export type VizScale = 'sqrt' | 'linear';

export interface Totals {
  additions: number;
  deletions: number;
  prs: number;
  files: number; // distinct paths if every PR has `paths`, else the sum of per-PR counts
}

export function stackTotals(prs: VizPr[]): Totals {
  const additions = prs.reduce((a, p) => a + p.additions, 0);
  const deletions = prs.reduce((a, p) => a + p.deletions, 0);
  const files = prs.every((p) => p.paths) ? new Set(prs.flatMap((p) => p.paths!)).size : prs.reduce((a, p) => a + p.filesChanged, 0);
  return { additions, deletions, prs: prs.length, files };
}

export function sumTotals(ts: Totals[]): Totals {
  return ts.reduce((a, t) => ({ additions: a.additions + t.additions, deletions: a.deletions + t.deletions, prs: a.prs + t.prs, files: a.files + t.files }), { additions: 0, deletions: 0, prs: 0, files: 0 });
}

const isCurrent = (m: VizModel, repo: string, sha: string) => !!m.current && m.current.repo === repo && m.current.sha === sha;

/** Narrow the model to the current PR's repo or stack (no current PR: unchanged). */
export function scopeModel(m: VizModel, scope: VizScope): VizModel {
  if (scope === 'project' || !m.current) return m;
  const repos = m.repos.filter((r) => r.name === m.current!.repo);
  if (scope === 'repo') return { ...m, repos };
  return { ...m, repos: repos.map((r) => ({ ...r, stacks: r.stacks.filter((s) => s.prs.some((p) => p.sha === m.current!.sha)) })) };
}

/**
 * Bar length, as a fraction of the full bar, for `n` changed lines when the heaviest thing in the image has
 * `max`. One scale for the whole image (stacks and PRs alike), so every bar is comparable. sqrt keeps a small
 * PR visible next to a big stack while still ordering them correctly.
 */
export function barFraction(n: number, max: number, scale: VizScale = 'sqrt'): number {
  if (n <= 0 || max <= 0) return 0;
  const f = scale === 'linear' ? n / max : Math.sqrt(n / max);
  return Math.min(1, f);
}

/** Green and red segment lengths for a bar `width` long at full scale. Nonzero segments are at least 2px. */
export function barSegments(additions: number, deletions: number, max: number, width: number, scale: VizScale = 'sqrt') {
  const total = additions + deletions;
  const len = barFraction(total, max, scale) * width;
  if (!len) return { add: 0, del: 0 };
  let add = (len * additions) / total;
  let del = len - add;
  if (additions > 0 && add < 2) add = 2;
  if (deletions > 0 && del < 2) del = 2;
  return { add, del };
}

// ---------------------------------------------------------------- building it from a loaded project
export const stackLabel = (g: { number: number | null; title: string; implicit?: string }) => (g.number !== null && !g.implicit ? `Stack ${g.number} · ${g.title}` : g.title);

export async function vizModel(project: LoadedProject, current?: { repo: string; sha: string } | null): Promise<VizModel> {
  const repos = await Promise.all(
    project.repos.map(async (r): Promise<VizRepo> => {
      const prs = await loadPrs(r.prsDir, liveCommits(r.cfg, r.info), inspectOrphan(r.cfg, r.info)).catch(() => new Map());
      const refs = r.refIndex;
      const tip = r.cfg.branch ?? r.info.end ?? null;
      const bySha = new Map(
        await Promise.all(
          r.info.commits.map(async (cm, i): Promise<[string, VizPr]> => {
            const paths = await filesOf(r.cfg.path, cm).then((fs) => fs.map((f) => f.path), () => undefined);
            const override = prs.get(cm.sha)?.override;
            // the same branch the sidebar shows (recorded, reconciled with git, else discovered)
            const b = reconcileBranch(refs, cm.sha, override, tip);
            return [cm.sha, { position: i + 1, sha: cm.sha, short: cm.short, title: override?.title ?? cm.subject, additions: cm.additions, deletions: cm.deletions, filesChanged: cm.filesChanged, paths, branch: b?.name ?? null, branchMissing: b?.status === 'missing', pr: override?.github?.number ?? null, ...(cm.landed ? { merged: true } : {}) }];
          }),
        ),
      );
      const label = repoLabel(r.info, r.info.commits.filter((c) => c.landed).length);
      return {
        name: r.cfg.name,
        branch: label?.text ?? '',
        ...(label?.merged ? { merged: true } : {}),
        error: r.info.error ?? null,
        // empty stacks (a selector that matched nothing) would only be noise in a picture
        stacks: r.stacks.filter((g) => g.shas.length).map((g) => ({ label: stackLabel(g), color: g.color, implicit: g.implicit, ...(g.follow_on ? { follow_on: true } : {}), prs: g.shas.map((s) => bySha.get(s)!).filter(Boolean) })),
      };
    }),
  );
  return { title: project.cfg.title, repos, current: current ?? null };
}

/** Each stack's weight (PRs, distinct files, +/−), by index into `r.stacks`, as in the picture. */
export async function stackWeights(r: LoadedRepo): Promise<Totals[]> {
  const bySha = new Map(r.info.commits.map((cm) => [cm.sha, cm]));
  return Promise.all(
    r.stacks.map(async (g) => {
      const prs = await Promise.all(
        g.shas.map(async (sha): Promise<VizPr | null> => {
          const cm = bySha.get(sha);
          if (!cm) return null;
          const paths = await filesOf(r.cfg.path, cm).then((fs) => fs.map((f) => f.path), () => undefined);
          return { position: 0, sha, short: cm.short, title: cm.subject, additions: cm.additions, deletions: cm.deletions, filesChanged: cm.filesChanged, paths, ...(cm.landed ? { merged: true } : {}) };
        }),
      );
      return stackTotals(prs.filter((p): p is VizPr => !!p));
    }),
  );
}

// ---------------------------------------------------------------- fonts and text measurement
const FONT_FILES = {
  regular: 'Inter_400Regular.ttf',
  semibold: 'Inter_600SemiBold.ttf',
  bold: 'Inter_700Bold.ttf',
  mono: 'JetBrainsMono_400Regular.ttf',
} as const;
type Face = keyof typeof FONT_FILES;
const FACE_ATTRS: Record<Face, string> = {
  regular: `font-family="Inter" font-weight="400"`,
  semibold: `font-family="Inter" font-weight="600"`,
  bold: `font-family="Inter" font-weight="700"`,
  mono: `font-family="JetBrains Mono" font-weight="400"`,
};

let loaded: Record<Face, opentype.Font> | null = null;
function fonts() {
  if (!loaded) {
    const load = (f: string) => {
      const b = fs.readFileSync(path.join(FONT_DIR, f));
      return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    };
    loaded = Object.fromEntries(Object.entries(FONT_FILES).map(([k, f]) => [k, load(f)])) as Record<Face, opentype.Font>;
  }
  return loaded;
}

const advanceCache = new Map<string, number>(); // face\0char -> advance in em
/** Width in px of `s` in `face` at `size`, from the font's glyph advances (no kerning: slightly generous). */
export function textWidth(s: string, face: Face, size: number, letterSpacing = 0): number {
  let em = 0;
  let n = 0;
  for (const ch of s) {
    const key = face + '\0' + ch;
    let a = advanceCache.get(key);
    if (a === undefined) {
      const f = fonts()[face];
      const g = f.charToGlyph(ch);
      // a character the font lacks: resvg draws a box about this wide
      a = g && g.index !== 0 ? (g.advanceWidth ?? 0) / f.unitsPerEm : 0.6;
      advanceCache.set(key, a);
    }
    em += a;
    n++;
  }
  return em * size + letterSpacing * n;
}

/**
 * `s` with its middle cut out ("me/feature/02-pa…-parser") so that it fits in `max` px: for branch names,
 * whose start is shared across a stack and whose end tells them apart. The end keeps a bit less than half.
 */
export function truncateMiddle(s: string, face: Face, size: number, max: number): string {
  if (textWidth(s, face, size) <= max) return s;
  const chars = Array.from(s);
  const cut = (k: number) => {
    const tail = Math.floor(k * 0.45);
    return chars.slice(0, k - tail).join('') + '…' + (tail ? chars.slice(chars.length - tail).join('') : '');
  };
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(cut(mid), face, size) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? cut(lo) : '…';
}

/** `s`, cut at a character boundary with "…" so that it fits in `max` px. */
export function truncate(s: string, face: Face, size: number, max: number, letterSpacing = 0): string {
  if (textWidth(s, face, size, letterSpacing) <= max) return s;
  const chars = Array.from(s);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(chars.slice(0, mid).join('').trimEnd() + '…', face, size, letterSpacing) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? chars.slice(0, lo).join('').trimEnd() + '…' : '…';
}

// ---------------------------------------------------------------- SVG
// the app's light theme (src/styles.css)
const C = {
  fg: '#1f2328',
  muted: '#59636e',
  faint: '#8c959f',
  border: '#d0d7de',
  track: '#eaeef2',
  add: '#1a7f37',
  addBar: '#2da44e',
  del: '#cf222e',
  delBar: '#e5534b',
  accent: '#0969da',
  accentSubtle: '#ddf4ff',
  plum: '#4a1942',
  plum2: '#6b2a60',
  plumTint: '#f7eff6',
  plumLine: '#e6d3e3',
  amber: '#f0b429',
  // follow-on stacks: GitHub's attention yellow (text on white 4.9:1; the border 3:1, enough for a line)
  foFg: '#9a6700',
  foBorder: '#bf8700',
  foSubtle: '#fff8c5',
  foPillLine: '#d4a72c',
  merged: '#8250df', // GitHub's merged purple
  mergedSubtle: '#f0eafb', // it at 12% on white, like the UI's .branch-name.is-merged
};
export const STACK_HEX: Record<string, string> = {
  blue: '#0969da',
  green: '#1a7f37',
  purple: '#8250df',
  orange: '#bc4c00',
  pink: '#bf3989',
  teal: '#1b7c83',
  red: '#cf222e',
  yellow: C.foBorder, // reserved for follow-on stacks
  gray: '#8c959f',
};
const hex = (c: string) => (c.startsWith('#') ? c : (STACK_HEX[c] ?? STACK_HEX.gray));

export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const r1 = (n: number) => Math.round(n * 10) / 10;

interface TextOpts {
  face?: Face;
  size?: number;
  fill?: string;
  anchor?: 'start' | 'middle' | 'end';
  spacing?: number;
}
function text(x: number, y: number, s: string, o: TextOpts = {}) {
  const { face = 'regular', size = 13, fill = C.fg, anchor = 'start', spacing } = o;
  return `<text x="${r1(x)}" y="${r1(y)}" ${FACE_ATTRS[face]} font-size="${size}" fill="${fill}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(s)}</text>`;
}

export const WIDTH = 680;
const PAD = 24;
const ROW = 30;
const ROW2 = 40; // a row with a second line: the branch and the GitHub PR number
// columns, as x positions (box from PAD to WIDTH - PAD)
const BOX_L = PAD;
const BOX_R = WIDTH - PAD;
const NUM_X = BOX_L + 22;
const TITLE_X = BOX_L + 42;
const BAR_W = 100;
const BAR_X = BOX_R - 14 - BAR_W;
const DEL_R = BAR_X - 14; // right edges of the − and + columns
const ADD_R = DEL_R - 44;
const SHA_X = ADD_R - 48 - 58;
const MARKER = '◀ this PR';
const FOLLOW_ON_TAG = 'follow-on';
// the border, weight and rows of a follow-on stack; its label and tag stay at full strength. As the sidebar's rows.
const FOLLOW_ON_OPACITY = 0.72;

export interface RenderOpts {
  scale?: VizScale;
  title?: boolean; // the project title and summary line at the top (default: shown)
}

/** The whole picture as a standalone SVG document (680px wide; the PNG is rendered from it at 2x). */
export function renderStackSvg(m: VizModel, opts: RenderOpts = {}): string {
  const scale = opts.scale ?? 'sqrt';
  const out: string[] = [];
  let clip = 0;
  const all = m.repos.flatMap((r) => r.stacks.map((s) => ({ r, s, t: stackTotals(s.prs) })));
  // one scale for every bar in the image: the heaviest stack is the full width
  const max = Math.max(1, ...all.map((x) => x.t.additions + x.t.deletions));
  // the header totals leave follow-on stacks out (shared/totals.ts, as in the UI)
  const statOf = (s: VizStack, t: Totals) => {
    const m = s.prs.filter((p) => p.merged);
    return { follow_on: s.follow_on, prs: t.prs, additions: t.additions, deletions: t.deletions, merged: { prs: m.length, additions: m.reduce((a, p) => a + p.additions, 0), deletions: m.reduce((a, p) => a + p.deletions, 0) } };
  };
  // the side note: "+1 follow-on stack (2 PRs) · +9 merged", yellow if it mentions follow-on work, else purple
  const sideNote = (x: { note: string | null; merged: string | null }) => {
    const t = [x.note, x.merged].filter(Boolean).join(' · ');
    return t ? { text: t, fill: x.note ? C.foFg : C.merged } : null;
  };
  const grand = summary(aggregate(all.map((x) => statOf(x.s, x.t))), m.repos.length);
  // once any PR has a branch or a GitHub number, every row gets a second line for them (the sha moves there)
  const twoLine = all.some((x) => x.s.prs.some((p) => p.branch || p.pr));
  const rowH = twoLine ? ROW2 : ROW;

  const bar = (x: number, cy: number, w: number, h: number, a: number, d: number) => {
    const { add, del } = barSegments(a, d, max, w, scale);
    const y = cy - h / 2;
    const parts = [`<rect x="${r1(x)}" y="${r1(y)}" width="${w}" height="${h}" rx="${h / 2}" fill="${C.track}"/>`];
    if (add + del > 0) {
      const id = `b${++clip}`;
      parts.push(
        `<clipPath id="${id}"><rect x="${r1(x)}" y="${r1(y)}" width="${r1(add + del)}" height="${h}" rx="${h / 2}"/></clipPath>`,
        `<g clip-path="url(#${id})">`,
        add ? `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(add)}" height="${h}" fill="${C.addBar}"/>` : '',
        del ? `<rect x="${r1(x + add)}" y="${r1(y)}" width="${r1(del)}" height="${h}" fill="${C.delBar}"/>` : '',
        `</g>`,
      );
    }
    return parts.join('');
  };
  // "+1,234 −56" right-aligned on `right`, as two tspans so each keeps its colour
  const addDel = (right: number, y: number, a: number, d: number, size = 12) =>
    `<text x="${r1(right)}" y="${r1(y)}" ${FACE_ATTRS.semibold} font-size="${size}" text-anchor="end"><tspan fill="${C.add}">+${num(a)}</tspan><tspan fill="${C.del}" dx="6">−${num(d)}</tspan></text>`;
  const addDelWidth = (a: number, d: number, size = 12) => textWidth(`+${num(a)}`, 'semibold', size) + 6 + textWidth(`−${num(d)}`, 'semibold', size);

  // ---- header: a thin plum and amber rule (the app's "not GitHub" colours), the title, totals
  let y = 0;
  out.push(`<rect x="0" y="0" width="${WIDTH}" height="4" fill="${C.plum}"/><rect x="0" y="4" width="${WIDTH}" height="1.5" fill="${C.amber}"/>`);
  if (opts.title === false) {
    // no title area: the first repo heading moves up to sit as far below the rule as the title would
    y = 6;
  } else {
    y = 38;
    out.push(text(PAD, y, truncate(m.title, 'bold', 19, WIDTH - 2 * PAD), { face: 'bold', size: 19 }));
    y += 22;
    // "2 repos · 4 stacks · 12 PRs · +3,477 −155 · +1 follow-on stack (2 PRs)"
    const gn = sideNote(grand);
    const note = gn ? `<tspan fill="${C.muted}"> · </tspan><tspan ${FACE_ATTRS.semibold} fill="${gn.fill}">${esc(gn.text)}</tspan>` : '';
    out.push(
      `<text x="${PAD}" y="${y}" ${FACE_ATTRS.regular} font-size="12.5" fill="${C.muted}">${esc(grand.counts + ' · ')}<tspan ${FACE_ATTRS.semibold} fill="${C.add}">+${num(grand.additions)}</tspan><tspan ${FACE_ATTRS.semibold} fill="${C.del}" dx="5">−${num(grand.deletions)}</tspan>${note}</text>`,
    );
    y += 12;
  }

  for (const repo of m.repos) {
    // ---- repo heading: name · branch pill, its totals on the right
    y += 30;
    // "11 PRs  +3,374 −140 · +1 follow-on stack (2 PRs)", right-aligned
    const rt = summary(aggregate(repo.stacks.map((s) => statOf(s, stackTotals(s.prs)))));
    const rn = sideNote(rt);
    const right = rt.counts;
    const DOT_GAP = 14; // "·" centred between the − number and the note
    const noteW = rn ? textWidth(rn.text, 'semibold', 12) + DOT_GAP : 0;
    const rightW = textWidth(right + '  ', 'regular', 12) + addDelWidth(rt.additions, rt.deletions) + noteW;
    const name = truncate(repo.name, 'bold', 14.5, 260);
    out.push(text(PAD, y, name, { face: 'bold', size: 14.5 }));
    const bx = PAD + textWidth(name, 'bold', 14.5) + 10;
    if (repo.branch) {
      const branch = truncate(repo.branch, 'mono', 11.5, BOX_R - rightW - 20 - bx - 14);
      const bw = textWidth(branch, 'mono', 11.5) + 14;
      const [bg, fg] = repo.merged ? [C.mergedSubtle, C.merged] : [C.accentSubtle, C.accent];
      out.push(`<rect x="${r1(bx)}" y="${y - 13.5}" width="${r1(bw)}" height="19" rx="9.5" fill="${bg}"/>`, text(bx + 7, y, branch, { face: 'mono', size: 11.5, fill: fg }));
    }
    if (repo.stacks.some((s) => s.prs.length)) {
      if (rn) {
        // laid out left to right from the measured widths (an end-anchored "+a −d" ignores its dx, so would overlap)
        const adW = addDelWidth(rt.additions, rt.deletions);
        const countsW = textWidth(right, 'regular', 12);
        const x0 = BOX_R - (countsW + 10 + adW + noteW);
        const ax = x0 + countsW + 10;
        out.push(
          text(x0, y, right, { size: 12, fill: C.muted }),
          `<text x="${r1(ax)}" y="${r1(y)}" ${FACE_ATTRS.semibold} font-size="12"><tspan fill="${C.add}">+${num(rt.additions)}</tspan><tspan fill="${C.del}" dx="6">−${num(rt.deletions)}</tspan></text>`,
          text(ax + adW + DOT_GAP / 2, y, '·', { size: 12, fill: C.muted, anchor: 'middle' }),
          text(ax + adW + DOT_GAP, y, rn.text, { face: 'semibold', size: 12, fill: rn.fill }),
        );
      } else {
        out.push(addDel(BOX_R, y, rt.additions, rt.deletions));
        out.push(text(BOX_R - addDelWidth(rt.additions, rt.deletions) - 10, y, right, { size: 12, fill: C.muted, anchor: 'end' }));
      }
    }
    if (repo.error) {
      y += 24;
      out.push(text(PAD, y, truncate(`⚠ ${repo.error}`, 'regular', 12, WIDTH - 2 * PAD), { size: 12, fill: C.del }));
      continue;
    }
    if (!repo.stacks.length) {
      y += 24;
      out.push(text(PAD, y, 'No commits.', { size: 12, fill: C.muted }));
      continue;
    }
    y += 10;

    for (const s of repo.stacks) {
      // ---- one stack: a coloured rounded border with the title inset on its top line
      const t = stackTotals(s.prs);
      // follow-on stacks are always yellow, whatever their colour says: a darker yellow for the label text
      const color = s.follow_on ? C.foBorder : s.implicit === 'unstacked' ? STACK_HEX.gray : hex(s.color);
      const labelColor = s.follow_on ? C.foFg : color;
      const here = s.prs.some((p) => isCurrent(m, repo.name, p.sha));
      const top = y + 16;
      const bottom = top + 12 + s.prs.length * rowH + 8;
      // follow-on (held back): the stack faded a little; its label and tag (drawn after the rows) at full strength
      if (s.follow_on) out.push(`<g opacity="${FOLLOW_ON_OPACITY}">`);
      out.push(
        `<rect x="${BOX_L}" y="${top}" width="${BOX_R - BOX_L}" height="${bottom - top}" rx="9" fill="${here ? color : 'none'}" fill-opacity="${here ? 0.045 : 0}" stroke="${color}" stroke-width="${here ? 2.5 : 1.75}"${s.implicit === 'unstacked' ? ' stroke-dasharray="5 4"' : ''}/>`,
      );
      // the right inset: "4 PRs · 31 files  +1,111 −6" and the stack's weight bar, in the PR bar column
      const meta = `${plural(t.prs, 'PR')} · ${plural(t.files, 'file')}`;
      const adW = addDelWidth(t.additions, t.deletions, 11.5);
      const metaW = textWidth(meta, 'regular', 11.5);
      const insetL = DEL_R - adW - 10 - metaW - 8;
      out.push(`<rect x="${r1(insetL)}" y="${top - 8}" width="${r1(BOX_R - 12 - insetL)}" height="16" fill="#fff"/>`);
      out.push(text(insetL + 4, top + 4, meta, { size: 11.5, fill: C.muted }));
      out.push(addDel(DEL_R, top + 4, t.additions, t.deletions, 11.5));
      out.push(bar(BAR_X, top, BAR_W, 8, t.additions, t.deletions));
      // the left inset: "STACK 1 · GROUNDWORK"
      const spacing = 1.1;
      const tagW = s.follow_on ? textWidth(FOLLOW_ON_TAG, 'semibold', 10) + 12 : 0;
      const label = truncate(s.label.toUpperCase(), 'bold', 11, insetL - (BOX_L + 16) - 28 - (tagW ? tagW + 6 : 0), spacing);
      const lw = textWidth(label, 'bold', 11, spacing);
      const labelSvg = [`<rect x="${BOX_L + 10}" y="${top - 8}" width="${r1(lw + 12 + (tagW ? tagW + 6 : 0))}" height="16" fill="#fff"/>`, text(BOX_L + 16, top + 4, label, { face: 'bold', size: 11, fill: labelColor, spacing })];
      if (tagW) {
        // a small yellow "follow-on" pill after the label, like the sidebar's badge
        const tx = BOX_L + 16 + lw + 6;
        labelSvg.push(`<rect x="${r1(tx)}" y="${top - 7}" width="${r1(tagW)}" height="14" rx="7" fill="${C.foSubtle}" stroke="${C.foPillLine}"/>`, text(tx + tagW / 2, top + 3.5, FOLLOW_ON_TAG, { face: 'semibold', size: 10, fill: C.foFg, anchor: 'middle' }));
      }
      if (!s.follow_on) out.push(...labelSvg);

      let cy = top + 12 + rowH / 2;
      for (const p of s.prs) {
        const cur = isCurrent(m, repo.name, p.sha);
        // the highlighted PR at full strength, even in a faded follow-on stack (as the open PR in the sidebar)
        if (cur && s.follow_on) out.push('</g>');
        const hh = rowH - 3; // the highlight
        if (cur) {
          out.push(
            `<rect x="${BOX_L + 6}" y="${cy - hh / 2}" width="${BOX_R - BOX_L - 12}" height="${hh}" rx="6" fill="${C.plumTint}" stroke="${C.plumLine}"/>`,
            `<rect x="${BOX_L + 6}" y="${cy - hh / 2}" width="3.5" height="${hh}" rx="1.75" fill="${C.plum}"/>`,
          );
        }
        // the number's circle: plum for the highlighted PR, GitHub's merged purple for a landed one
        out.push(
          `<circle cx="${NUM_X}" cy="${cy}" r="10.5" fill="${cur ? C.plum : p.merged ? C.merged : C.track}"/>`,
          cur && p.merged ? `<circle cx="${NUM_X}" cy="${cy}" r="12" fill="none" stroke="${C.merged}" stroke-width="1.5"/>` : '',
          text(NUM_X, cy + 4, String(p.position), { face: 'semibold', size: p.position >= 100 ? 9 : 11, fill: cur || p.merged ? '#fff' : C.muted, anchor: 'middle' }),
        );
        const markerW = cur ? textWidth(MARKER, 'bold', 12) + 10 : 0;
        const face: Face = cur ? 'semibold' : 'regular';
        // two lines: the title can run up to the +/− numbers, since the sha column is gone
        const textR = twoLine ? DEL_R - addDelWidth(p.additions, p.deletions) - 16 : SHA_X - 14;
        const ty = twoLine ? cy - 3.5 : cy + 4.5;
        const title = truncate(p.title, face, 13, textR - TITLE_X - markerW);
        out.push(text(TITLE_X, ty, title, { face, size: 13 }));
        if (cur) out.push(text(TITLE_X + textWidth(title, face, 13) + 10, ty, MARKER, { face: 'bold', size: 12, fill: C.plum }));
        if (twoLine) {
          // "me/feature/02-flag-parser  #1234": the branch (or the short sha) in mono, then the PR number
          const sy = cy + 11;
          const prLabel = p.pr ? `#${p.pr}` : '';
          const prW = prLabel ? textWidth(prLabel, 'semibold', 10.5) + 8 : 0;
          const name = p.branch ? truncateMiddle(p.branch, 'mono', 10.5, textR - TITLE_X - prW) : p.short;
          out.push(
            `<text x="${TITLE_X}" y="${r1(sy)}" ${FACE_ATTRS.mono} font-size="10.5" fill="${p.branch && !p.branchMissing ? C.muted : C.faint}"${p.branchMissing ? ' text-decoration="line-through"' : ''}>${esc(name)}</text>`,
          );
          if (prLabel) out.push(text(TITLE_X + textWidth(name, 'mono', 10.5) + 8, sy, prLabel, { face: 'semibold', size: 10.5, fill: C.accent }));
        } else {
          out.push(text(SHA_X, cy + 4, p.short, { face: 'mono', size: 11.5, fill: C.muted }));
        }
        out.push(addDel(DEL_R, cy + 4.5, p.additions, p.deletions));
        out.push(bar(BAR_X, cy, BAR_W, 6, p.additions, p.deletions));
        if (cur && s.follow_on) out.push(`<g opacity="${FOLLOW_ON_OPACITY}">`);
        cy += rowH;
      }
      if (s.follow_on) out.push('</g>', ...labelSvg);
      y = bottom;
    }
  }

  // ---- footer: how to read the bars
  y += 30;
  const legend = `Bars: lines added and deleted, ${scale === 'sqrt' ? 'square-root scale' : 'linear scale'}, the same for every stack and PR`;
  out.push(
    `<rect x="${PAD}" y="${y - 7}" width="9" height="5" rx="1" fill="${C.addBar}"/><rect x="${PAD + 9}" y="${y - 7}" width="5" height="5" rx="1" fill="${C.delBar}"/>`,
    text(PAD + 20, y - 1, legend, { size: 10.5, fill: C.faint }),
    text(BOX_R, y - 1, 'LOCAL REVIEW', { face: 'bold', size: 9.5, fill: C.plum2, anchor: 'end', spacing: 1.6 }),
  );
  const height = Math.ceil(y + 16);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    ...out.filter(Boolean),
    `</svg>`,
  ].join('\n');
}

// ---------------------------------------------------------------- PNG
let fontPaths: string[] | null = null;
/** The SVG as a PNG at `zoom`x (2 = crisp on retina screens and when pasted into a PR). */
export function svgToPng(svg: string, zoom = 2): Buffer {
  fontPaths ??= Object.values(FONT_FILES).map((f) => path.join(FONT_DIR, f));
  const r = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: zoom },
    background: '#ffffff',
    // only the bundled fonts: the same output on every machine and no slow system font scan. (Allowing system
    // fallback fonts for emoji / CJK made resvg mis-shape whole lines; such characters draw as boxes instead.)
    font: { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: 'Inter', sansSerifFamily: 'Inter', monospaceFamily: 'JetBrains Mono' },
  });
  return r.render().asPng();
}
