// Line anchors: how an inline thread follows its code across amends and rebases.
//
// When a thread is created the server stores an `anchor`: the commit it was made on, its location there, the
// exact text of the commented line(s) and up to CONTEXT_LINES lines of context on each side. To place the
// thread on another commit (or after its code changed) we look for that text on the same side of the same
// file (following renames), score each match by how much surrounding context still fits, and break ties by
// distance from the last known line. No match => the thread is "outdated". Pure functions, no I/O.
// The rules are documented in README.md ("Line anchoring").

export const CONTEXT_LINES = 3;

export type Side = 'left' | 'right';

export interface Anchor {
  commit: string; // sha the thread was made on (or first anchored on)
  path: string;
  old_path?: string; // the file's pre-rename path in that commit, if it was renamed there
  side: Side;
  line: number;
  start_line?: number;
  /** Only for a range whose first line is on the other side (unified view: "-12 to +15"). */
  start_side?: Side;
  /** For such a mixed-side range: the text of start_line on start_side (`text` is then just `line`). */
  start_text?: string;
  text: string; // lines start_line..line, joined with \n (just `line` for a mixed-side range)
  before?: string; // up to CONTEXT_LINES lines before, joined with \n (absent = none, e.g. at line 1)
  after?: string; // up to CONTEXT_LINES lines after
}

/** The bits of a changed file we need: same shape as stacks.ts FileWithContents. */
export interface DiffFile {
  path: string;
  oldPath: string | null;
  oldContent: string | null;
  newContent: string | null;
}

export interface Location {
  path: string;
  side: Side;
  line: number;
  start_line?: number;
  /** Side of start_line when it differs from `side` (a range spanning old and new lines). */
  start_side?: Side;
}

/** True for a range whose start is on the other side from its end (start_side set and != side). */
export const isMixed = (l: { side?: Side; start_line?: number; start_side?: Side }) =>
  !!l.start_line && !!l.start_side && l.start_side !== (l.side ?? 'right');

export interface Placement extends Partial<Location> {
  outdated: boolean;
}

/** Split file content into lines (1-based line n = result[n-1]); CRs and the final newline are dropped. */
export function splitLines(content: string): string[] {
  const ls = content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (ls.length && ls[ls.length - 1] === '') ls.pop();
  return ls;
}

const toLines = (s: string | undefined) => (s === undefined ? [] : s.split('\n'));
const loose = (s: string) => s.replace(/\s+/g, ' ').trim();

export function sideContent(f: DiffFile, side: Side) {
  return side === 'left' ? f.oldContent : f.newContent;
}

/** Find the file for `path` in a commit's diff: by new path, then by pre-rename path (it was renamed here). */
export function findFile(files: DiffFile[], ...paths: (string | undefined)[]): DiffFile | undefined {
  for (const p of paths) {
    if (!p) continue;
    const f = files.find((x) => x.path === p) ?? files.find((x) => x.oldPath === p);
    if (f) return f;
  }
  return undefined;
}

export function makeAnchor(files: DiffFile[], commit: string, loc: Location): Anchor | null {
  const f = findFile(files, loc.path);
  if (!f) return null;
  const content = sideContent(f, loc.side);
  if (content == null) return null;
  const lines = splitLines(content);
  if (isMixed(loc)) {
    // anchor the end line as a single line, and remember the start line's text on its own side
    const sc = sideContent(f, loc.start_side!);
    const sl = sc == null ? [] : splitLines(sc);
    if (loc.line < 1 || loc.line > lines.length || loc.start_line! < 1 || loc.start_line! > sl.length) return null;
    const a = makeAnchor(files, commit, { path: loc.path, side: loc.side, line: loc.line });
    if (!a) return null;
    return { ...a, start_side: loc.start_side, start_line: loc.start_line, start_text: sl[loc.start_line! - 1] };
  }
  const start = loc.start_line ?? loc.line;
  if (start < 1 || loc.line > lines.length || start > loc.line) return null;
  const a: Anchor = { commit, path: f.path, side: loc.side, line: loc.line, text: lines.slice(start - 1, loc.line).join('\n') };
  if (f.oldPath && f.oldPath !== f.path) a.old_path = f.oldPath;
  if (loc.start_line) a.start_line = loc.start_line;
  const before = lines.slice(Math.max(0, start - 1 - CONTEXT_LINES), start - 1);
  const after = lines.slice(loc.line, loc.line + CONTEXT_LINES);
  if (before.length) a.before = before.join('\n');
  if (after.length) a.after = after.join('\n');
  return a;
}

/**
 * Find where `anchor`'s text is in `lines`. Exact matches are preferred; if there are none, matches that
 * differ only in whitespace are used. Among matches: most context lines that still fit, then nearest to
 * `hint` (1-based start line), then earliest. Returns the 1-based start line, or null.
 */
export function findAnchorText(lines: string[], anchor: Pick<Anchor, 'text' | 'before' | 'after'>, hint: number): number | null {
  return searchAnchor(lines, anchor, hint)?.line ?? null;
}

interface Hit {
  line: number; // 1-based start line
  score: number; // context lines that still fit
  exact: boolean;
}

function searchAnchor(lines: string[], anchor: Pick<Anchor, 'text' | 'before' | 'after'>, hint: number): Hit | null {
  const text = toLines(anchor.text);
  const before = toLines(anchor.before);
  const after = toLines(anchor.after);
  const k = text.length;
  const matchesAt = (i: number, eq: (a: string, b: string) => boolean) => {
    for (let j = 0; j < k; j++) if (!eq(lines[i + j], text[j])) return false;
    return true;
  };
  const collect = (eq: (a: string, b: string) => boolean) => {
    const out: number[] = [];
    for (let i = 0; i + k <= lines.length; i++) if (matchesAt(i, eq)) out.push(i);
    return out;
  };
  let cands = collect((a, b) => a === b);
  const exact = cands.length > 0;
  if (!exact) cands = collect((a, b) => loose(a) === loose(b));
  if (!cands.length) return null;
  const score = (i: number) => {
    let s = 0;
    for (let j = 0; j < before.length; j++) {
      const l = lines[i - before.length + j];
      if (l !== undefined && loose(l) === loose(before[j])) s++;
    }
    for (let j = 0; j < after.length; j++) {
      const l = lines[i + k + j];
      if (l !== undefined && loose(l) === loose(after[j])) s++;
    }
    return s;
  };
  const blank = text.every((t) => !t.trim());
  let best: { i: number; s: number; d: number } | null = null;
  for (const i of cands) {
    const s = score(i);
    if (blank && s === 0) continue; // a blank line matches everywhere; demand some context
    const d = Math.abs(i + 1 - hint);
    if (!best || s > best.s || (s === best.s && d < best.d)) best = { i, s, d };
  }
  return best ? { line: best.i + 1, score: best.s, exact } : null;
}

export interface ThreadLike {
  path?: string;
  side?: Side;
  line?: number;
  start_line?: number;
  start_side?: Side;
  anchor?: Anchor;
}

/**
 * Where a thread goes on commit `sha` whose diff is `files`.
 *  - Anchored on `sha` itself, or not anchored at all: its stored path/side/line, as is.
 *  - Anchored on another commit: relocated by its anchor text (following renames).
 *  - Outdated when its file isn't in the diff, the side has no content, or the text can't be found.
 */
export function placeThread(t: ThreadLike, files: DiffFile[], sha: string): Placement {
  if (!t.path || !t.line) return { outdated: false };
  const a = t.anchor;
  const side: Side = t.side ?? a?.side ?? 'right';
  if (!a || a.commit === sha) {
    const f = findFile(files, t.path);
    const content = f && sideContent(f, side);
    if (content == null || t.line > splitLines(content).length) return { outdated: true };
    const loc: Placement = { outdated: false, path: f!.path, side, line: t.line };
    if (t.start_line) loc.start_line = t.start_line;
    if (isMixed({ side, start_line: t.start_line, start_side: t.start_side })) {
      const sc = sideContent(f!, t.start_side!);
      // the start line must exist on its side; if not, keep the end line only
      if (sc != null && t.start_line! <= splitLines(sc).length) loc.start_side = t.start_side;
      else delete loc.start_line;
    }
    return loc;
  }
  // hint = expected first line of anchor.text (just the end line for a mixed-side range)
  const hint = isMixed(a) ? t.line : (t.start_line ?? t.line ?? a.start_line ?? a.line);
  let f = findFile(files, t.path, a.path, a.old_path);
  let hit: Hit | null = null;
  if (f) {
    const content = sideContent(f, a.side);
    if (content != null) hit = searchAnchor(splitLines(content), a, hint);
  } else {
    // The file isn't in this diff under any known name. If it was added by this commit and then renamed by
    // a fixup, git sees a plain add under the new name, so look in the other files, but only accept an
    // exact match whose context mostly fits (strong evidence it's the same code).
    const ctxLines = toLines(a.before).length + toLines(a.after).length;
    const need = Math.min(ctxLines, 3);
    if (a.text.trim() && need > 0) {
      for (const g of files) {
        const content = sideContent(g, a.side);
        if (content == null) continue;
        const h = searchAnchor(splitLines(content), a, hint);
        if (h && h.exact && h.score >= need && (!hit || h.score > hit.score)) {
          hit = h;
          f = g;
        }
      }
    }
  }
  if (!f || !hit) return { outdated: true };
  if (isMixed(a)) {
    // end line found; look for the start line's text on its own side, near where the shift puts it
    const loc: Placement = { outdated: false, path: f.path, side: a.side, line: hit.line };
    const sc = sideContent(f, a.start_side!);
    if (sc != null && a.start_text !== undefined) {
      const startHint = a.start_line! + (hit.line - a.line);
      const s = searchAnchor(splitLines(sc), { text: a.start_text }, startHint);
      if (s && s.exact) {
        loc.start_line = s.line;
        loc.start_side = a.start_side;
      }
    }
    return loc; // start not found: degrade to a single-line thread on the end line
  }
  const start = hit.line;
  const span = a.start_line ? a.line - a.start_line : 0;
  const loc: Placement = { outdated: false, path: f.path, side: a.side, line: start + span };
  if (span > 0) loc.start_line = start;
  return loc;
}
