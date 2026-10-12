// What `local-review` (serve) prints once it's listening: the LOCAL REVIEW banner, the "Local Review on …" line, and
// how to point a coding agent at /llms.txt. Hand-rolled, no dependency (like herdctl's banner): a 12-pixel-high font
// drawn with half blocks (▀ ▄ █), so it's 6 rows and fits an 80-column terminal, coloured in a plum-to-amber gradient
// (the UI header's colours, lightened so they read on dark and light terminals alike).
//
// The banner is only for a person at a terminal: none when stdout isn't a TTY (piped, a log file, CI) unless
// FORCE_COLOR is set, none with --quiet, a one-line title when the terminal is too narrow. Colour follows Node's own
// rules (tty.WriteStream#getColorDepth: NO_COLOR, FORCE_COLOR, TERM=dumb, COLORTERM, Windows 10+), so truecolor where
// the terminal has it, else the nearest of 256 or 16 colours, else none. The "Local Review on" line is always printed:
// scripts (scripts/smoke-pack.mjs) wait for it.
import tty from 'node:tty';

// Each glyph: 12 pixel rows, `#` set. Rows pair up into one text row each.
const FONT: Record<string, string[]> = {
  L: ['##....', '##....', '##....', '##....', '##....', '##....', '##....', '##....', '##....', '##....', '######', '######'],
  O: ['.####.', '######', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '######', '.####.'],
  C: ['.#####', '######', '##....', '##....', '##....', '##....', '##....', '##....', '##....', '##....', '######', '.#####'],
  A: ['.####.', '######', '##..##', '##..##', '##..##', '##..##', '######', '######', '##..##', '##..##', '##..##', '##..##'],
  R: ['#####.', '######', '##..##', '##..##', '##..##', '######', '#####.', '##.##.', '##..##', '##..##', '##..##', '##..##'],
  E: ['######', '######', '##....', '##....', '##....', '#####.', '#####.', '##....', '##....', '##....', '######', '######'],
  V: ['##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '.####.', '.####.', '..##..', '..##..'],
  I: ['##', '##', '##', '##', '##', '##', '##', '##', '##', '##', '##', '##'],
  W: ['##....##', '##....##', '##....##', '##....##', '##....##', '##....##', '##.##.##', '##.##.##', '##.##.##', '##.##.##', '########', '.##..##.'],
  ' ': Array(12).fill('...'),
};

/** The banner's lines, uncoloured: `text` drawn in FONT, one column between letters. */
export function bannerLines(text = 'LOCAL REVIEW'): string[] {
  const glyphs = [...text].map((ch) => FONT[ch]);
  const px = Array.from({ length: 12 }, (_, y) => glyphs.map((g) => g[y]).join('.'));
  const out: string[] = [];
  for (let y = 0; y < 12; y += 2) {
    let line = '';
    for (let x = 0; x < px[y].length; x++) {
      const top = px[y][x] === '#';
      const bottom = px[y + 1][x] === '#';
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    out.push(line.trimEnd());
  }
  return out;
}

type Rgb = [number, number, number];
// left to right: a light plum (the header's #4a1942, lifted to read on black), a rose, the header's amber #e8a33d
const STOPS: Rgb[] = [
  [176, 72, 156],
  [214, 96, 120],
  [232, 163, 61],
];
function gradient(t: number): Rgb {
  const s = Math.min(STOPS.length - 2, Math.floor(t * (STOPS.length - 1)));
  const f = t * (STOPS.length - 1) - s;
  return STOPS[s].map((v, i) => Math.round(v + (STOPS[s + 1][i] - v) * f)) as Rgb;
}

/** An SGR foreground colour for `rgb` at a colour depth (24, 8 or 4 bits; 1: none). */
function fg([r, g, b]: Rgb, depth: number): string {
  if (depth >= 24) return `\x1b[38;2;${r};${g};${b}m`;
  if (depth >= 8) {
    const c = (v: number) => Math.round((v / 255) * 5);
    return `\x1b[38;5;${16 + 36 * c(r) + 6 * c(g) + c(b)}m`;
  }
  return b > 90 ? '\x1b[35m' : '\x1b[33m'; // 16 colours: magenta into yellow
}
const RESET = '\x1b[0m';

export interface Terminal {
  isTTY?: boolean;
  columns?: number;
  env: NodeJS.ProcessEnv;
  /** Colour depth (bits); default: Node's own detection for this env. */
  depth?: number;
}

/** Node's colour detection, for a TTY or not: FORCE_COLOR wins over NO_COLOR, as in Node and force-color.org. */
export function colorDepth(t: Terminal): number {
  if (t.depth !== undefined) return t.depth;
  const forced = t.env.FORCE_COLOR !== undefined;
  if (!t.isTTY && !forced) return 1;
  return tty.WriteStream.prototype.getColorDepth.call(null, t.env);
}

function paint(line: string, width: number, depth: number): string {
  if (depth < 4) return line;
  let out = '';
  let last = '';
  for (let x = 0; x < line.length; x++) {
    const ch = line[x];
    if (ch === ' ') {
      out += ch;
      continue;
    }
    const code = fg(gradient(width > 1 ? x / (width - 1) : 0), depth);
    if (code !== last) out += code;
    last = code;
    out += ch;
  }
  return out + RESET;
}

const bold = (s: string, depth: number) => (depth >= 4 ? `\x1b[1m${s}\x1b[22m` : s);

/**
 * The startup text, for a terminal. `quiet` (--quiet): just the "Local Review on" line, as when stdout isn't a
 * terminal. `dev` (npm run dev's API): just that line too, since the URL to give an agent is Vite's, not this one.
 */
export function startupMessage(o: { url: string; projectsDir: string; quiet?: boolean; dev?: boolean }, t: Terminal): string {
  const depth = colorDepth(t);
  const line = `Local Review on ${o.url}  (projects: ${o.projectsDir})`;
  if (o.dev) return line + '\n';
  const out: string[] = [];
  const showBanner = !o.quiet && (t.isTTY || (t.env.FORCE_COLOR !== undefined && depth > 1));
  if (showBanner) {
    const lines = bannerLines();
    const width = Math.max(...lines.map((l) => l.length));
    // 2 columns of margin; narrower than that, a one-line title rather than a wrapped banner
    if ((t.columns ?? 80) >= width + 2) out.push('', ...lines.map((l) => ' ' + paint(l, width, depth)), '');
    else out.push('', ' ' + bold(paint('▌ LOCAL REVIEW', 14, depth), depth), '');
  }
  out.push(line);
  if (!o.quiet) {
    const llms = bold(`${o.url}/llms.txt`, depth);
    out.push(
      '',
      '',
      `Point Claude Code/Codex/pi/whatever at ${llms} then ask it to generate a project definition for you. Example:`,
      '',
      `  Read ${llms} and create a local-review project for my feature-xyz branch on ~/code/my-git-project`,
      '',
    );
  }
  return out.join('\n') + '\n';
}
