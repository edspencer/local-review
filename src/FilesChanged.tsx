import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FileDiff, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs/react';
import { DiffHunksRenderer, parseDiffFromFile, type FileDiffMetadata, type SelectedLineRange } from '@pierre/diffs';
import type { FileData, Review, Thread } from './api';
import { CommentForm, ThreadView, type ThreadActions } from './Comments';
import { NO_FOLDS, isFolded, reconcileFolds, setFolded, type FoldState } from './threadFold';
import { isTyping, useLocalStorage } from './util';

export const LARGE_DIFF_LINES = 800;

// GitHub's unified view has two line-number columns (old, new). @pierre/diffs renders one, but every
// unified gutter cell goes through DiffHunksRenderer#getUnifiedLineDecoration, whose `gutterProperties`
// become attributes on the cell. We tag each cell with both line numbers and draw them with CSS
// (see PIERRE_CSS). Our diffs are always parsed from full file contents, so lineIndex + 1 is the line number.
//
// getUnifiedLineDecoration is PRIVATE API. package.json pins @pierre/diffs to an exact version for that
// reason; check this still works when bumping it. The patch is defensive: if the method is missing, or our
// wrapper sees anything unexpected or throws, it returns the stock decoration (a single line-number column,
// since the CSS only applies to cells tagged data-lr-dual) and warns once in the console. A diff never
// breaks because of it.
type UnifiedDecoration = { gutterLineType: string; gutterProperties?: Record<string, unknown>; contentProperties?: Record<string, unknown> };
type DecorationProps = { additionLineIndex?: number; deletionLineIndex?: number };
const rendererProto = (DiffHunksRenderer as unknown as { prototype?: Record<string, unknown> } | undefined)?.prototype as
  | { getUnifiedLineDecoration?: (p: DecorationProps) => UnifiedDecoration; __lrDualGutter?: boolean }
  | undefined;
let dualGutterWarned = false;
function warnDualGutter(why: string, err?: unknown) {
  if (dualGutterWarned) return;
  dualGutterWarned = true;
  console.warn(`[local-review] unified view: two line-number columns disabled (${why}); using @pierre/diffs' stock gutter.`, err ?? '');
}
if (rendererProto && !rendererProto.__lrDualGutter) {
  const orig = rendererProto.getUnifiedLineDecoration;
  if (typeof orig !== 'function') {
    warnDualGutter('DiffHunksRenderer#getUnifiedLineDecoration not found in this @pierre/diffs version');
  } else {
    rendererProto.__lrDualGutter = true;
    rendererProto.getUnifiedLineDecoration = function (this: unknown, props: DecorationProps) {
      const d = orig.call(this, props);
      try {
        if (!d || typeof d !== 'object' || !props || typeof props !== 'object') {
          warnDualGutter('unexpected decoration shape');
          return d;
        }
        return {
          ...d,
          gutterProperties: {
            ...d.gutterProperties,
            'data-lr-dual': '',
            'data-lr-old': props.deletionLineIndex != null ? props.deletionLineIndex + 1 : undefined,
            'data-lr-new': props.additionLineIndex != null ? props.additionLineIndex + 1 : undefined,
          },
        };
      } catch (e) {
        warnDualGutter('patch threw', e);
        return d;
      }
    };
  }
} else if (!rendererProto) {
  warnDualGutter('DiffHunksRenderer not exported');
}

export interface Draft {
  path: string;
  side: 'left' | 'right';
  line: number;
  start_line?: number;
  /** side of start_line when the range spans old and new lines (unified view); omitted otherwise */
  start_side?: 'left' | 'right';
}

type Side = 'left' | 'right';
const isMixed = (t: { side?: Side; start_line?: number; start_side?: Side }) => !!t.start_line && !!t.start_side && t.start_side !== (t.side ?? 'right');

interface AnnMeta {
  key: string;
  threads: Thread[];
  draft: Draft | null;
}

export interface FilesChangedProps {
  files: FileData[];
  review: Review;
  actions: ThreadActions;
  newThread: (d: Draft, body: string) => Promise<unknown>;
  setViewed: (path: string, viewed: boolean) => Promise<unknown>;
  focusFile: string | null;
  /** ?thread=… with ?file=…: open that thread and scroll to it rather than to the top of its file */
  focusThread?: string | null;
  onFocusFile: (path: string | null) => void;
}

export function FilesChanged({ files: gitOrder, review, actions, newThread, setViewed, focusFile, focusThread, onFocusFile }: FilesChangedProps) {
  // show the cards in the same order as the tree (directories first), like GitHub, so n / p follow it
  const files = useMemo(() => treeOrder(buildTree(gitOrder)), [gitOrder]);
  const [diffStyle, setDiffStyle] = useLocalStorage<'split' | 'unified'>('lr.diffStyle', 'unified');
  const [treeOpen, setTreeOpen] = useLocalStorage('lr.treeOpen', true);
  const viewed = useMemo(() => new Set(review.viewed), [review.viewed]);
  // explicit open/closed state per path; otherwise viewed files start collapsed (huge ones show "Load diff")
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  // which threads are folded to one row: for this page only (threadFold.ts). Caught up with the threads during
  // render, so a thread that's just been resolved is never drawn open for a frame first.
  const [folds, setFolds] = useState<FoldState>(NO_FOLDS);
  const caughtUp = reconcileFolds(folds, review.threads);
  if (caughtUp !== folds) setFolds(caughtUp);
  const foldCtx = useMemo(() => ({ state: caughtUp, set: (id: string, f: boolean) => setFolds((s) => setFolded(s, id, f)) }), [caughtUp]);

  const isLarge = (f: FileData) => f.additions + f.deletions > LARGE_DIFF_LINES;
  const isOpen = (f: FileData) => openState[f.path] ?? !viewed.has(f.path);

  const totals = useMemo(() => files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 }), [files]);
  const threadsByPath = useMemo(() => {
    const m = new Map<string, Thread[]>();
    for (const t of review.threads) if (t.path) m.set(t.path, [...(m.get(t.path) ?? []), t]);
    return m;
  }, [review.threads]);

  const scrollTo = useCallback((path: string, thread?: string) => {
    setOpenState((s) => (s[path] === false ? { ...s, [path]: true } : s));
    // Cards above may still be lazy placeholders that grow once they render near the viewport, so keep
    // the target pinned under the toolbar for a moment while layout settles (stop if the user scrolls).
    let frames = 0;
    let stable = 0;
    let userScrolled = false;
    const stop = () => { userScrolled = true; };
    window.addEventListener('wheel', stop, { once: true, passive: true });
    window.addEventListener('keydown', stop, { once: true });
    const pin = () => {
      // a thread: once its card has rendered it (until then, its file's header)
      const at = thread ? document.getElementById(`thread-${thread}`) : null;
      const el = at ?? document.getElementById(fileAnchor(path));
      if (!el || userScrolled) return;
      const off = el.getBoundingClientRect().top - (at ? Math.max(STICKY_TOP + 8, (window.innerHeight - el.offsetHeight) / 2) : STICKY_TOP + 8);
      if (Math.abs(off) > 1) { if (at) window.scrollBy(0, off); else el.scrollIntoView({ block: 'start' }); stable = 0; } else stable++;
      if (++frames < 90 && stable < 12) requestAnimationFrame(pin);
      else { window.removeEventListener('wheel', stop); window.removeEventListener('keydown', stop); }
    };
    requestAnimationFrame(pin);
  }, []);

  // ?file=… deep link
  const didFocus = useRef<string | null>(null);
  useEffect(() => {
    const key = `${focusFile}#${focusThread ?? ''}`;
    if (focusFile && didFocus.current !== key && files.some((f) => f.path === focusFile)) {
      didFocus.current = key;
      const thread = focusThread && review.threads.some((t) => t.id === focusThread) ? focusThread : undefined;
      if (thread) setFolds((s) => setFolded(s, thread, false));
      setTimeout(() => scrollTo(focusFile, thread), 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFile, focusThread, files, scrollTo]);

  const setAll = (open: boolean) => setOpenState(Object.fromEntries(files.map((f) => [f.path, open])));

  // scroll-spy: the file whose card is under the sticky toolbar is "current" (tree highlight, n / p)
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      let cur: string | null = null;
      for (const el of document.querySelectorAll<HTMLElement>('.file-card[data-path]')) {
        if (el.getBoundingClientRect().top <= STICKY_TOP + 12) cur = el.dataset.path!;
        else break;
      }
      setCurrent(cur ?? files[0]?.path ?? null);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(raf); };
  }, [files]);

  // n / p: next / previous file
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'n' && e.key !== 'p')) return;
      const i = files.findIndex((f) => f.path === currentRef.current);
      // "current" is the card under the toolbar; if we're scrolled into its middle, p goes back to its top
      const curTop = i >= 0 ? document.getElementById(fileAnchor(files[i].path))?.getBoundingClientRect().top ?? 0 : 0;
      const j = e.key === 'n' ? i + 1 : curTop < STICKY_TOP - 4 ? i : i - 1;
      if (j < 0 || j >= files.length) return;
      e.preventDefault();
      scrollTo(files[j].path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [files, scrollTo]);

  const viewedCount = files.filter((f) => viewed.has(f.path)).length;

  return (
    <FoldContext.Provider value={foldCtx}>
    <div className="files-changed">
      <div className="files-toolbar">
        <button className="btn btn-sm btn-octicon-only" title={treeOpen ? 'Hide file tree' : 'Show file tree'} onClick={() => setTreeOpen(!treeOpen)}>
          {treeOpen ? '⇤' : '⇥'}
        </button>
        <span className="toolbar-summary">
          <strong>{files.length}</strong> {files.length === 1 ? 'file' : 'files'} changed{' '}
          <span className="color-add">+{totals.add}</span> <span className="color-del">−{totals.del}</span>
        </span>
        <span className="spacer" />
        <span className="viewed-progress" title="Mark files as viewed to track your progress">
          <span className="progress-bar"><span style={{ width: `${files.length ? (100 * viewedCount) / files.length : 0}%` }} /></span>
          <strong>{viewedCount}</strong> / {files.length} files viewed
        </span>
        <button className="btn btn-sm" onClick={() => setAll(true)}>Expand all</button>
        <button className="btn btn-sm" onClick={() => setAll(false)}>Collapse all</button>
        <div className="BtnGroup">
          <button className={`btn btn-sm ${diffStyle === 'split' ? 'selected' : ''}`} onClick={() => setDiffStyle('split')}>Split</button>
          <button className={`btn btn-sm ${diffStyle === 'unified' ? 'selected' : ''}`} onClick={() => setDiffStyle('unified')}>Unified</button>
        </div>
      </div>
      <div className="files-layout">
        {treeOpen && (
          <nav className="file-tree-wrap">
            <FileTree files={files} threadsByPath={threadsByPath} viewed={viewed} active={current ?? focusFile} onPick={(p) => { onFocusFile(p); scrollTo(p); }} />
          </nav>
        )}
        <div className="file-cards">
          {files.map((f) => (
            <FileCard
              key={f.path}
              file={f}
              open={isOpen(f)}
              large={isLarge(f)}
              setOpen={(o) => setOpenState((s) => ({ ...s, [f.path]: o }))}
              viewed={viewed.has(f.path)}
              setViewed={(v) => {
                // optimistic: collapse / expand now; CommitPage reverts the checkbox if the save fails
                setOpenState((s) => ({ ...s, [f.path]: !v }));
                return setViewed(f.path, v).catch(() => setOpenState((s) => ({ ...s, [f.path]: v })));
              }}
              threads={threadsByPath.get(f.path) ?? []}
              diffStyle={diffStyle}
              draft={draft?.path === f.path ? draft : null}
              setDraft={setDraft}
              actions={actions}
              newThread={newThread}
            />
          ))}
          {files.length === 0 && <div className="blankslate">This commit changes no files.</div>}
        </div>
      </div>
    </div>
    </FoldContext.Provider>
  );
}

const FoldContext = createContext<{ state: FoldState; set: (id: string, folded: boolean) => void }>({ state: NO_FOLDS, set: () => {} });

/** A thread in Files changed: folds to one row (resolved and outdated ones start folded). */
function FoldableThread({ thread, actions, context }: { thread: Thread; actions: ThreadActions; context?: ReactNode }) {
  const { state, set } = useContext(FoldContext);
  const folded = isFolded(state, thread);
  return <ThreadView thread={thread} actions={actions} context={context} fold={{ folded, setFolded: (f) => set(thread.id, f) }} />;
}

export const fileAnchor = (path: string) => `file-${path.replace(/[^A-Za-z0-9]/g, '-')}`;

/** Height of the sticky files toolbar: file headers stick just below it. Keep in sync with styles.css. */
const STICKY_TOP = 49;

// ---------------- file tree ----------------
interface TreeNode {
  name: string;
  path: string;
  dirs: Map<string, TreeNode>;
  files: FileData[];
}

function buildTree(files: FileData[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(f);
  }
  // compress chains of single-child directories: a/b/c
  const compress = (n: TreeNode): TreeNode => {
    for (const [k, d] of n.dirs) {
      let c = d;
      while (c.files.length === 0 && c.dirs.size === 1) {
        const only = [...c.dirs.values()][0];
        c = { ...only, name: `${c.name}/${only.name}` };
      }
      n.dirs.set(k, compress(c));
    }
    return n;
  };
  return compress(root);
}

const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name);
const byPath = (a: FileData, b: FileData) => a.path.localeCompare(b.path);

function treeOrder(n: TreeNode): FileData[] {
  return [...[...n.dirs.values()].sort(byName).flatMap(treeOrder), ...[...n.files].sort(byPath)];
}

export function StatusIcon({ status }: { status: FileData['status'] }) {
  const map: Record<string, [string, string]> = {
    added: ['+', 'added'],
    deleted: ['−', 'deleted'],
    renamed: ['→', 'renamed'],
    copied: ['⧉', 'renamed'],
    modified: ['•', 'modified'],
    'type-changed': ['•', 'modified'],
  };
  const [ch, cls] = map[status] ?? map.modified;
  return <span className={`status-icon status-${cls}`} title={status}>{ch}</span>;
}

function FileTree({ files, threadsByPath, viewed, active, onPick }: { files: FileData[]; threadsByPath: Map<string, Thread[]>; viewed: Set<string>; active: string | null; onPick: (p: string) => void }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const toggle = (p: string) => setClosed((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  // keep the current file visible in the (separately scrolling) tree
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = ref.current?.querySelector<HTMLElement>('.tree-file.active');
    const box = ref.current?.closest<HTMLElement>('.file-tree-wrap');
    if (!row || !box) return;
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top + 40) box.scrollTop -= b.top + 40 - r.top;
    else if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - b.bottom + 8;
  }, [active]);

  if (filter.trim()) {
    const q = filter.toLowerCase();
    const hits = files.filter((f) => f.path.toLowerCase().includes(q));
    return (
      <div className="file-tree" ref={ref}>
        <input className="form-control tree-filter" placeholder="Filter changed files" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {hits.length === 0 && <div className="tree-empty muted">No files match.</div>}
        {hits.map((f) => <TreeFile key={f.path} f={f} depth={0} label={f.path} threads={threadsByPath.get(f.path)} viewed={viewed.has(f.path)} active={active === f.path} onPick={onPick} />)}
      </div>
    );
  }

  const render = (n: TreeNode, depth: number): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const d of [...n.dirs.values()].sort(byName)) {
      const isClosed = closed.has(d.path);
      out.push(
        <button key={`d:${d.path}`} className="tree-row tree-dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(d.path)} title={d.path} aria-expanded={!isClosed}>
          <Octicon name={isClosed ? 'chevron-right' : 'chevron-down'} className="chev" />
          <Octicon name={isClosed ? 'folder' : 'folder-open'} className="folder-icon" />
          <span className="tree-name">{d.name}</span>
        </button>,
      );
      if (!isClosed) out.push(...render(d, depth + 1));
    }
    for (const f of [...n.files].sort(byPath)) {
      out.push(<TreeFile key={f.path} f={f} depth={depth} label={f.path.split('/').pop()!} threads={threadsByPath.get(f.path)} viewed={viewed.has(f.path)} active={active === f.path} onPick={onPick} />);
    }
    return out;
  };
  return (
    <div className="file-tree" ref={ref}>
      <input className="form-control tree-filter" placeholder="Filter changed files" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {render(tree, 0)}
    </div>
  );
}

function TreeFile({ f, depth, label, threads, viewed, active, onPick }: { f: FileData; depth: number; label: string; threads?: Thread[]; viewed: boolean; active: boolean; onPick: (p: string) => void }) {
  const open = threads?.filter((t) => !t.resolved).length ?? 0;
  return (
    <button className={`tree-row tree-file ${active ? 'active' : ''} ${viewed ? 'is-viewed' : ''}`} style={{ paddingLeft: 8 + depth * 14 + 16 }} onClick={() => onPick(f.path)} title={`${f.path}${viewed ? ' (viewed)' : ''}`}>
      <Octicon name="file" className="file-icon" />
      <span className="tree-name">{label}</span>
      {threads && threads.length > 0 && <span className={`tree-comments ${open ? '' : 'all-resolved'}`} title={`${threads.length} thread(s), ${open} unresolved`}>💬 {threads.length}</span>}
      {viewed ? <Octicon name="check" className="tree-viewed" /> : <StatusIcon status={f.status} />}
    </button>
  );
}

// a few 16px Octicons (MIT, github.com/primer/octicons)
const OCTICONS = {
  'chevron-down': 'M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z',
  'chevron-right': 'M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z',
  folder: 'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z',
  'folder-open': 'M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z',
  file: 'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z',
  check: 'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
} as const;

export function Octicon({ name, className }: { name: keyof typeof OCTICONS; className?: string }) {
  return (
    <svg className={`octicon ${className ?? ''}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d={OCTICONS[name]} />
    </svg>
  );
}

// ---------------- file card ----------------
function DiffStat({ add, del }: { add: number; del: number }) {
  const total = add + del;
  const blocks = 5;
  const g = total === 0 ? 0 : Math.round((add / total) * blocks);
  const r = total === 0 ? 0 : Math.min(blocks - g, Math.round((del / total) * blocks));
  return (
    <span className="diffstat">
      <span className="color-add">+{add}</span> <span className="color-del">−{del}</span>
      <span className="diffstat-blocks">
        {Array.from({ length: blocks }, (_, i) => <span key={i} className={i < g ? 'b-add' : i < g + r ? 'b-del' : 'b-neutral'} />)}
      </span>
    </span>
  );
}

function threadVisible(fd: FileDiffMetadata, t: Thread) {
  if (!t.line || t.outdated) return false; // outdated threads go above the diff
  return fd.hunks.some((h) =>
    t.side === 'left'
      ? t.line! >= h.deletionStart && t.line! < h.deletionStart + h.deletionCount
      : t.line! >= h.additionStart && t.line! < h.additionStart + h.additionCount,
  );
}

/** One row of the unified view, top to bottom, over the whole file (expanded or not): old and/or new line. */
interface Row {
  old?: number;
  new?: number;
}

/** Every row of the file in unified order: context rows have both numbers; in a change, deletions come first. */
function displayRows(fd: FileDiffMetadata): { rows: Row[]; byOld: Map<number, number>; byNew: Map<number, number> } {
  const rows: Row[] = [];
  let o = 1;
  let n = 1;
  const context = (toOld: number, toNew: number) => {
    while (o < toOld && n < toNew) rows.push({ old: o++, new: n++ });
  };
  for (const h of fd.hunks) {
    for (const c of h.hunkContent) {
      context(c.deletionLineIndex + 1, c.additionLineIndex + 1); // collapsed (or expanded) lines before this block
      o = Math.max(o, c.deletionLineIndex + 1);
      n = Math.max(n, c.additionLineIndex + 1);
      if (c.type === 'context') {
        for (let k = 0; k < c.lines; k++) rows.push({ old: o++, new: n++ });
      } else {
        for (let k = 0; k < c.deletions; k++) rows.push({ old: o++ });
        for (let k = 0; k < c.additions; k++) rows.push({ new: n++ });
      }
    }
  }
  context(fd.deletionLines.length + 1, fd.additionLines.length + 1);
  const byOld = new Map<number, number>();
  const byNew = new Map<number, number>();
  rows.forEach((r, i) => {
    if (r.old != null) byOld.set(r.old, i);
    if (r.new != null) byNew.set(r.new, i);
  });
  return { rows, byOld, byNew };
}

const rowsCache = new WeakMap<FileDiffMetadata, ReturnType<typeof displayRows>>();
function rowsOf(fd: FileDiffMetadata) {
  let r = rowsCache.get(fd);
  if (!r) rowsCache.set(fd, (r = displayRows(fd)));
  return r;
}
const rowIndex = (fd: FileDiffMetadata, side: Side, line: number) => (side === 'left' ? rowsOf(fd).byOld : rowsOf(fd).byNew).get(line) ?? -1;

/**
 * Turn a selection into a thread location. A selection on one side is a plain range on that side. One that
 * spans deleted and added lines (unified view) keeps both ends exactly: `start_side`/`start_line` for the
 * first row, `side`/`line` for the last. If either end is a context line it has a number on both sides, so
 * the range is expressed on one side instead.
 */
function draftFromRange(fd: FileDiffMetadata, range: SelectedLineRange): Omit<Draft, 'path'> | null {
  const sideOf = (s: string | undefined): Side => (s === 'deletions' ? 'left' : 'right');
  let a = { side: sideOf(range.side), line: range.start };
  let b = { side: sideOf(range.endSide ?? range.side), line: range.end };
  if (a.side === b.side) {
    const [lo, hi] = a.line <= b.line ? [a.line, b.line] : [b.line, a.line]; // dragged upwards
    return { side: a.side, line: hi, start_line: lo !== hi ? lo : undefined };
  }
  const ia = rowIndex(fd, a.side, a.line);
  const ib = rowIndex(fd, b.side, b.line);
  if (ia > ib) [a, b] = [b, a];
  const { rows } = rowsOf(fd);
  const key = (s: Side): 'old' | 'new' => (s === 'left' ? 'old' : 'new');
  const bOnA = rows[Math.max(ia, ib)]?.[key(a.side)];
  const aOnB = rows[Math.min(ia, ib)]?.[key(b.side)];
  if (ia >= 0 && ib >= 0 && bOnA != null) return { side: a.side, line: bOnA, start_line: a.line !== bOnA ? a.line : undefined };
  if (ia >= 0 && ib >= 0 && aOnB != null) return { side: b.side, line: b.line, start_line: aOnB !== b.line ? aOnB : undefined };
  return { side: b.side, line: b.line, start_line: a.line, start_side: a.side };
}

/** GitHub's wording: "+40 to +42" (new file), "-12" (old file), "-12 to +15" (spanning both). */
export function rangeText(side: Side | undefined, line: number, start?: number, startSide?: Side) {
  const sym = (x: Side | undefined) => (x === 'left' ? '-' : '+');
  if (start && startSide && startSide !== (side ?? 'right')) return `lines ${sym(startSide)}${start} to ${sym(side)}${line}`;
  return start && start !== line ? `lines ${sym(side)}${start} to ${sym(side)}${line}` : `line ${sym(side)}${line}`;
}

/** Selectors for the cells of one line (number and code), in unified and split view. */
function lineSelectors(side: Side, n: number): string[] {
  return side === 'left'
    ? [`[data-unified] [data-lr-old="${n}"]`, `[data-unified] [data-line-type="change-deletion"][data-line="${n}"]`, `[data-unified] [data-line-type^="context"][data-alt-line="${n}"]`, `[data-deletions] [data-column-number="${n}"]`, `[data-deletions] [data-line="${n}"]`]
    : [`[data-unified] [data-lr-new="${n}"]`, `[data-unified] [data-line-type="change-addition"][data-line="${n}"]`, `[data-unified] [data-line-type^="context"][data-line="${n}"]`, `[data-additions] [data-column-number="${n}"]`, `[data-additions] [data-line="${n}"]`];
}

/** CSS (for the diff's shadow root) that tints the lines of commented ranges, more strongly for the hovered thread. */
function rangeHighlightCSS(threads: Thread[], hovered: string | null, fd: FileDiffMetadata): string {
  const rules: string[] = [];
  for (const t of threads) {
    if (!t.line || t.outdated) continue;
    const isHover = t.id === hovered;
    if (!t.start_line && !isHover) continue; // single-line comments already show their thread right there
    const sel: string[] = [];
    if (isMixed(t)) {
      // every unified row from the start (one side) to the end (other side), in display order
      const i0 = rowIndex(fd, t.start_side!, t.start_line!);
      const i1 = rowIndex(fd, t.side ?? 'right', t.line);
      const { rows } = rowsOf(fd);
      for (let i = Math.max(0, Math.min(i0, i1)); i >= 0 && i <= Math.max(i0, i1) && sel.length < 5000; i++) {
        if (rows[i].old != null) sel.push(...lineSelectors('left', rows[i].old!));
        if (rows[i].new != null) sel.push(...lineSelectors('right', rows[i].new!));
      }
    } else {
      const from = t.start_line ?? t.line;
      for (let n = from; n <= t.line && n - from < 500; n++) sel.push(...lineSelectors(t.side === 'left' ? 'left' : 'right', n));
    }
    if (!sel.length) continue;
    rules.push(
      `:is(${sel.join(',')}) { background-image: linear-gradient(${isHover ? 'rgba(212,167,44,.28), rgba(212,167,44,.28)' : 'rgba(212,167,44,.10), rgba(212,167,44,.10)'}); }`,
      `:is(${sel.filter((x) => x.includes('lr-') || x.includes('column-number')).join(',')}) { box-shadow: inset 3px 0 0 ${isHover ? '#bf8700' : 'rgba(212,167,44,.65)'}; }`,
    );
  }
  return rules.join('\n');
}

interface FileCardProps {
  file: FileData;
  open: boolean;
  large: boolean;
  setOpen: (o: boolean) => void;
  viewed: boolean;
  setViewed: (v: boolean) => Promise<unknown>;
  threads: Thread[];
  diffStyle: 'split' | 'unified';
  draft: Draft | null;
  setDraft: (d: Draft | null) => void;
  actions: ThreadActions;
  newThread: (d: Draft, body: string) => Promise<unknown>;
}

const FileCard = memo(function FileCard(p: FileCardProps) {
  const { file: f, open, large } = p;
  const [forceLoad, setForceLoad] = useState(false);
  const isPureRename = (f.status === 'renamed' || f.status === 'copied') && f.additions === 0 && f.deletions === 0 && !f.binary;
  const renderable = !f.binary && !f.tooLarge && !isPureRename && (f.oldContent !== null || f.newContent !== null);
  const unresolved = p.threads.filter((t) => !t.resolved).length;

  let content: ReactNode;
  if (!open) content = null;
  else if (f.binary) content = <div className="diff-placeholder">Binary file not shown.</div>;
  else if (f.tooLarge) content = <div className="diff-placeholder">File too large to display.</div>;
  else if (isPureRename) content = <div className="diff-placeholder">File renamed without changes.</div>;
  else if (!renderable) content = <div className="diff-placeholder">No content to display.</div>;
  else if (f.additions + f.deletions === 0 && (f.oldContent ?? '') === (f.newContent ?? ''))
    content = (
      <div className="diff-placeholder">
        {f.status === 'added' ? 'Empty file added.' : f.status === 'deleted' ? 'Empty file deleted.' : 'No content changes (file mode or metadata only).'}
      </div>
    );
  else if (large && !forceLoad)
    content = (
      <div className="diff-placeholder load-diff">
        <button className="btn-link" onClick={() => setForceLoad(true)}>Load diff</button>
        <div className="muted">Large diffs are not rendered by default ({f.additions + f.deletions} lines changed).</div>
      </div>
    );
  else
    content = (
      <LazyMount estimate={estimateHeight(f)}>
        <DiffBody {...p} />
      </LazyMount>
    );

  // file-level threads and threads whose line is outside the shown hunks are listed above the diff
  return (
    <section className={`file-card ${open ? '' : 'collapsed'} ${p.viewed ? 'is-viewed' : ''}`} id={fileAnchor(f.path)} data-path={f.path}>
      <header className="file-header">
        <button className="btn-octicon chevron" onClick={() => p.setOpen(!open)} title={open ? 'Collapse file' : 'Expand file'}>{open ? '▾' : '▸'}</button>
        <StatusIcon status={f.status} />
        <span className="file-path">
          {f.oldPath && f.oldPath !== f.path ? (
            <>
              <span className="old-path">{f.oldPath}</span> <span className="muted">→</span> {f.path}
            </>
          ) : (
            f.path
          )}
        </span>
        <button className="btn-octicon copy" title="Copy path" onClick={() => navigator.clipboard?.writeText(f.path)}>⧉</button>
        {f.status === 'added' && <span className="Label Label--success">new</span>}
        {f.status === 'deleted' && <span className="Label Label--danger">deleted</span>}
        {f.binary && <span className="Label">binary</span>}
        <span className="spacer" />
        {p.threads.length > 0 && (
          <span className={`file-comment-count ${unresolved ? '' : 'all-resolved'}`} title={`${p.threads.length} thread(s), ${unresolved} unresolved`}>💬 {p.threads.length}</span>
        )}
        <DiffStat add={f.additions} del={f.deletions} />
        <label className={`viewed-toggle ${p.viewed ? 'checked' : ''}`}>
          <input type="checkbox" checked={p.viewed} onChange={(e) => p.setViewed(e.target.checked)} /> Viewed
        </label>
      </header>
      {open && <div className="file-body">{content}</div>}
      {open && !renderable && p.threads.length > 0 && (
        <div className="outside-threads">
          {p.threads.map((t) => <FoldableThread key={t.id} thread={t} actions={p.actions} context={<ThreadLocation t={t} />} />)}
        </div>
      )}
    </section>
  );
});

/** Rough rendered height of a diff (changed lines + context + separators), for the lazy placeholder. */
function estimateHeight(f: FileData) {
  const rows = f.status === 'added' || f.status === 'deleted' ? f.additions + f.deletions : f.additions + f.deletions + 8;
  return Math.min(rows, 3000) * 20 + 32;
}

/**
 * Render children only once they come near the viewport, so opening a 20+ file commit paints the
 * first files straight away and the rest (diffing + highlighting) as you scroll. Stays mounted after.
 */
function LazyMount({ estimate, children }: { estimate: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (show || !el) return;
    if (typeof IntersectionObserver === 'undefined') return setShow(true);
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setShow(true); }, { rootMargin: '1500px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [show]);
  if (show) return <>{children}</>;
  return <div ref={ref} className="diff-lazy" style={{ height: estimate }} aria-busy="true" />;
}

function ThreadLocation({ t }: { t: Thread }) {
  if (t.outdated) return null; // ThreadView renders the Outdated header itself
  if (!t.line) return <div className="thread-location">Comment on file</div>;
  return <div className="thread-location">Comment on {rangeText(t.side, t.line, t.start_line, t.start_side)} ({isMixed(t) ? 'old and new' : t.side === 'left' ? 'old' : 'new'} file), outside the visible diff</div>;
}

function DiffBody({ file: f, threads, diffStyle, draft, setDraft, actions, newThread }: FileCardProps) {
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        f.oldContent !== null ? { name: f.oldPath ?? f.path, contents: f.oldContent, cacheKey: `old:${f.oldPath}:${f.oldContent.length}` } : null,
        f.newContent !== null ? { name: f.path, contents: f.newContent, cacheKey: `new:${f.path}:${f.newContent.length}` } : null,
      ),
    [f],
  );

  // width of each line-number column: enough digits for the longer side
  const numWidth = useMemo(() => {
    const n = Math.max(fileDiff.additionLines.length, fileDiff.deletionLines.length, 1);
    return { '--lr-num-w': `${Math.max(String(n).length, 2)}ch` } as CSSProperties;
  }, [fileDiff]);

  const pathRef = useRef(f.path);
  pathRef.current = f.path;
  const setDraftRef = useRef(setDraft);
  setDraftRef.current = setDraft;
  const fileDiffRef = useRef(fileDiff);
  fileDiffRef.current = fileDiff;
  const applyRangeCSSRef = useRef<() => void>(() => {});
  const [sel, setSel] = useState<SelectedLineRange | null>(null);
  const setSelRef = useRef(setSel);

  const options = useMemo<FileDiffOptions<AnnMeta, undefined>>(
    () => ({
      theme: { light: 'github-light', dark: 'github-dark' },
      themeType: 'system',
      diffStyle,
      disableFileHeader: true,
      lineDiffType: 'word',
      hunkSeparators: 'line-info',
      // GitHub expands 20 lines per click; gaps larger than this get separate up / down / "Expand all" buttons
      expansionLineCount: 20,
      overflow: 'scroll',
      diffIndicators: 'classic',
      enableGutterUtility: true,
      // click / drag / shift-click line numbers to select lines (GitHub-style); the + then sits on the last one
      enableLineSelection: true,
      onGutterUtilityClick: (range: SelectedLineRange) => {
        const d = draftFromRange(fileDiffRef.current, range);
        if (d) setDraftRef.current({ path: pathRef.current, ...d });
      },
      // selection is controlled (selectedLines), so mirror it into state
      onLineSelected: (range: SelectedLineRange | null) => setSelRef.current(range),
      onLineSelectionEnd: (range: SelectedLineRange | null) => {
        setSelRef.current(range);
        // a multi-line selection opens the comment form straight away; a single line just shows the +
        if (!range || (range.start === range.end && (range.endSide ?? range.side) === range.side)) return;
        const d = draftFromRange(fileDiffRef.current, range);
        if (d) setDraftRef.current({ path: pathRef.current, ...d });
      },
      unsafeCSS: PIERRE_CSS,
      onPostRender: () => applyRangeCSSRef.current(),
    }),
    [diffStyle],
  );

  const { visible, outside } = useMemo(() => {
    const visible: Thread[] = [];
    const outside: Thread[] = [];
    for (const t of threads) (threadVisible(fileDiff, t) ? visible : outside).push(t);
    return { visible, outside };
  }, [threads, fileDiff]);

  const annotations = useMemo<DiffLineAnnotation<AnnMeta>[]>(() => {
    const m = new Map<string, AnnMeta & { side: 'additions' | 'deletions'; lineNumber: number }>();
    const get = (side: 'left' | 'right', line: number) => {
      const k = `${side}:${line}`;
      let a = m.get(k);
      if (!a) {
        a = { key: k, threads: [], draft: null, side: side === 'left' ? 'deletions' : 'additions', lineNumber: line };
        m.set(k, a);
      }
      return a;
    };
    for (const t of visible) get(t.side ?? 'right', t.line!).threads.push(t);
    if (draft) get(draft.side, draft.line).draft = draft;
    return [...m.values()].map((a) => ({ side: a.side, lineNumber: a.lineNumber, metadata: { key: a.key, threads: a.threads, draft: a.draft } }));
  }, [visible, draft]);

  // tint commented ranges (stronger while hovering their thread) via our own <style> in the diff's shadow root
  const [hovered, setHovered] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rangeCSS = useMemo(() => rangeHighlightCSS(visible, hovered, fileDiff), [visible, hovered, fileDiff]);
  const applyRangeCSS = useCallback(() => {
    const root = wrapRef.current?.querySelector('diffs-container')?.shadowRoot;
    if (!root) return;
    let el = root.querySelector<HTMLStyleElement>('style[data-lr-ranges]');
    if (!el) {
      el = document.createElement('style');
      el.setAttribute('data-lr-ranges', '');
      root.appendChild(el);
    }
    if (el.textContent !== rangeCSS) el.textContent = rangeCSS;
  }, [rangeCSS]);
  useEffect(applyRangeCSS);
  applyRangeCSSRef.current = applyRangeCSS;

  const selectedLines = useMemo(() => {
    if (!draft) return sel;
    const side = draft.side === 'left' ? 'deletions' : 'additions';
    const startSide = draft.start_side ? (draft.start_side === 'left' ? 'deletions' : 'additions') : side;
    return { start: draft.start_line ?? draft.line, end: draft.line, side: startSide, endSide: side } as SelectedLineRange;
  }, [draft, sel]);

  return (
    <div ref={wrapRef}>
      {outside.length > 0 && (
        <div className="outside-threads">
          {outside.map((t) => <FoldableThread key={t.id} thread={t} actions={actions} context={<ThreadLocation t={t} />} />)}
        </div>
      )}
      <FileDiff<AnnMeta, undefined>
        fileDiff={fileDiff}
        options={options}
        lineAnnotations={annotations}
        selectedLines={selectedLines}
        className="pierre-diff"
        style={numWidth}
        renderAnnotation={(a) => (
          <div className="inline-annotation">
            {a.metadata.threads.map((t) => (
              <div key={t.id} className="thread-hover-wrap" onMouseEnter={() => setHovered(t.id)} onMouseLeave={() => setHovered((h) => (h === t.id ? null : h))}>
                {/* the header says file:line; a range across old and new lines also says which side each end is on */}
                <FoldableThread thread={t} actions={actions} context={isMixed(t) ? <div className="thread-location">Comment on {rangeText(t.side, t.line!, t.start_line, t.start_side)}</div> : undefined} />
              </div>
            ))}
            {a.metadata.draft && (
              <div className="thread draft">
                <div className="draft-label">Commenting on {rangeText(a.metadata.draft.side, a.metadata.draft.line, a.metadata.draft.start_line, a.metadata.draft.start_side)}</div>
                <CommentForm
                  placeholder="Leave a comment"
                  submitLabel="Add comment"
                  autoFocus
                  compact
                  onCancel={() => { setDraft(null); setSel(null); }}
                  onSubmit={async (body) => {
                    await newThread(a.metadata.draft!, body);
                    setDraft(null);
                    setSel(null);
                  }}
                />
              </div>
            )}
          </div>
        )}
      />
    </div>
  );
}

// CSS injected into @pierre/diffs' shadow root: GitHub-ish blue "+" gutter button.
const PIERRE_CSS = `
[data-utility-button] {
  background: #0969da !important;
  color: #fff !important;
  border: none !important;
  border-radius: 6px !important;
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(31,35,40,.15);
  transition: transform .08s ease;
}
[data-utility-button]:hover { transform: scale(1.12); }
/* sit just right of the line numbers (over the +/- marker), like GitHub, not on top of the new-line number */
[data-gutter-utility-slot] [data-utility-button] { margin-right: calc(-1lh + 6px); }

/* hunk expanders: show the library's (hidden by default) "Expand all" next to the up / down arrows */
/* (unified only: in split the separator is split across two columns; clicking its text expands all) */
[data-unified] [data-separator-wrapper]:has([data-expand-all-button]) { grid-template-columns: 32px 1fr auto !important; }
[data-unified] [data-expand-button][data-expand-all-button] {
  display: flex !important;
  grid-area: 1 / 3 / -1;
  padding: 0 12px;
  border-right: 0;
  border-left: 2px solid var(--diffs-bg);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
  font-size: 12px;
}
[data-expand-button]:hover { color: #0969da !important; background-color: #ddf4ff; }
@media (prefers-color-scheme: dark) {
  [data-expand-button]:hover { color: #4493f8 !important; background-color: rgba(56,139,253,.15); }
  [data-utility-button] { background: #1f6feb !important; }
}
[data-separator-content] { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif; font-size: 12px; }

/* unified view: two line-number columns (old | new), drawn from data-lr-old / data-lr-new */
[data-column-number][data-lr-dual] { display: flex; justify-content: flex-end; padding-left: 1ch; }
[data-column-number][data-lr-dual] [data-line-number-content] { display: none; }
[data-column-number][data-lr-dual]::before,
[data-column-number][data-lr-dual]::after {
  display: inline-block;
  text-align: right;
  min-width: var(--lr-num-w, 3ch);
}
[data-column-number][data-lr-dual]::before { content: attr(data-lr-old); margin-right: 1.5ch; }
[data-column-number][data-lr-dual]::after { content: attr(data-lr-new); }
`;
