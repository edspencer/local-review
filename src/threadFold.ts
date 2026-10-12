// Which inline threads in Files changed are folded to one row. Pure, for test/threadfold.test.ts; the rows are
// ThreadView's `fold` (Comments.tsx), the state lives in FilesChanged.

/** What folding needs of a thread: a Thread (api.ts) fits. No import, so the server's tsconfig can check the tests. */
export interface FoldThread {
  id: string;
  resolved: boolean;
  outdated?: boolean;
  path?: string;
  line?: number;
  start_line?: number;
  anchor?: { path: string; line: number; start_line?: number };
}

/** Resolved and outdated threads start folded; open ones start expanded. */
export function foldsByDefault(t: { resolved: boolean; outdated?: boolean }): boolean {
  return t.resolved || !!t.outdated;
}

/**
 * The page's fold state: `collapsed` holds the threads someone folded or unfolded (the rest follow
 * foldsByDefault), `resolved` what each thread's resolved flag was last time, to notice it changing.
 */
export interface FoldState {
  collapsed: Readonly<Record<string, boolean>>;
  resolved: Readonly<Record<string, boolean>>;
}
export const NO_FOLDS: FoldState = { collapsed: {}, resolved: {} };

export function isFolded(s: FoldState, t: FoldThread): boolean {
  return s.collapsed[t.id] ?? foldsByDefault(t);
}

export function setFolded(s: FoldState, id: string, folded: boolean): FoldState {
  return s.collapsed[id] === folded ? s : { ...s, collapsed: { ...s.collapsed, [id]: folded } };
}

/**
 * Catch up with the threads as they are now: a thread that was resolved since last time folds, one that was
 * unresolved unfolds (in the UI or by an agent writing the file, alike). The same object back if nothing changed,
 * so it can run on every render.
 */
export function reconcileFolds(s: FoldState, threads: readonly FoldThread[]): FoldState {
  let collapsed: Record<string, boolean> | null = null;
  let resolved: Record<string, boolean> | null = null;
  for (const t of threads) {
    const was = s.resolved[t.id];
    if (was === t.resolved) continue;
    resolved ??= { ...s.resolved };
    resolved[t.id] = t.resolved;
    if (was === undefined) continue; // first sight: the default applies
    collapsed ??= { ...s.collapsed };
    collapsed[t.id] = t.resolved;
  }
  return resolved ? { collapsed: collapsed ?? s.collapsed, resolved } : s;
}

/** The first comment as one plain line, for the folded row: markdown markup and line breaks dropped. */
export function snippet(body: string, max = 140): string {
  const text = body
    .replace(/```[^\n]*\n[\s\S]*?(```|$)/g, ' ') // fenced code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images: their alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links: their text
    .replace(/<[^>]+>/g, '') // HTML tags
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '') // headings, quotes, list markers
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** `file:line` for the folded row (the file's base name; the line or range it was made on, if any). */
export function foldLocation(t: FoldThread): string {
  const a = t.outdated ? t.anchor : undefined;
  const path = a?.path ?? t.path ?? '';
  const name = path.slice(path.lastIndexOf('/') + 1);
  const line = a ? a.line : t.line;
  const start = a ? a.start_line : t.start_line;
  if (!line) return name;
  return `${name}:${start && start !== line ? `${start}-${line}` : line}`;
}
