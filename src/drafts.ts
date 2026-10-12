// Unsaved drafts of every text box, kept like GitHub does: as you type, in this browser's localStorage, until you save
// or discard them (docs: using/editing-pr-text.md#drafts). Never sent anywhere. Pure: no DOM and no React, so
// test/drafts.test.ts runs it under node; the app's one store, its browser wiring and the hooks are in useDrafts.tsx.
//
// Every draft lives in memory first (an open editor is a draft, even an untouched one), and is written to storage
// a moment after the last keystroke, but only while it differs from what it started from: an untouched editor, or an
// empty comment box, leaves nothing behind.
import { normBody, normTitle } from '../shared/prText.js';

/** What a draft is of: a PR's title or description, the project intro, a stack note, or a comment of some kind. */
export type DraftKind = 'title' | 'body' | 'intro' | 'stack' | 'comment' | 'reply' | 'inline' | 'edit';

export type Side = 'left' | 'right';

/** Where an inline comment goes: the same fields as a thread's location (FilesChanged's Draft). */
export interface InlineAt {
  path: string;
  side: Side;
  line: number;
  start_line?: number;
  start_side?: Side;
}

/** Which text box a draft belongs to. These fields, and only these, make its key (draftKey). */
export interface DraftId {
  kind: DraftKind;
  project: string;
  repo?: string;
  /** the commit's full sha: every kind but intro and stack */
  sha?: string;
  stack?: { number: number; title: string };
  /** reply, edit: the thread; edit: the comment */
  thread?: string;
  comment?: string;
  at?: InlineAt;
}

/** Facts kept with a draft that aren't part of its key: what lets it follow its commit through a rebase. */
export interface DraftFacts {
  patchId?: string | null;
  subject?: string;
  /** inline: the text of the commented line (on `at.side`), to find the line again after a rebase */
  lineText?: string;
}

export interface DraftRecord extends DraftId, DraftFacts {
  v: 1;
  text: string;
  /** the saved text the draft was started from (or last reconciled with); '' for a new comment or reply */
  base: string;
  /** when it was started, and last changed (ms since the epoch) */
  created: number;
  saved: number;
  /** the sha it was written on, when it came over from there after a rebase */
  movedFrom?: string;
}

/** The subset of the Web Storage API the store uses (localStorage, or a fake in the tests). */
export interface StorageLike {
  readonly length: number;
  key(i: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DRAFT_PREFIX = 'lr.draft:';
/** written this long after the last change */
export const DRAFT_DELAY = 400;
/** a draft nobody touched for this long is dropped */
export const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
/** all drafts together (keys and JSON, in UTF-16 code units, which is what browsers count): oldest go first past it */
export const DRAFT_MAX_CHARS = 1_000_000;

/** The storage key of a draft: its kind and identity, each part URI-encoded. */
export function draftKey(id: DraftId): string {
  const parts: (string | number | undefined)[] = [id.kind, id.project];
  switch (id.kind) {
    case 'intro':
      break;
    case 'stack':
      parts.push(id.repo, id.stack?.number, id.stack?.title);
      break;
    case 'title':
    case 'body':
    case 'comment':
      parts.push(id.repo, id.sha);
      break;
    case 'reply':
      parts.push(id.repo, id.sha, id.thread);
      break;
    case 'edit':
      parts.push(id.repo, id.sha, id.thread, id.comment);
      break;
    case 'inline': {
      const a = id.at;
      parts.push(id.repo, id.sha, a?.path, a?.side, a?.line, a?.start_line, a?.start_side);
      break;
    }
  }
  return DRAFT_PREFIX + parts.map((p) => encodeURIComponent(p === undefined ? '' : String(p))).join('/');
}

/** Normalised as the server stores it, per kind, so "changed" means it would save something different. */
export function normDraft(kind: DraftKind, s: string): string {
  if (kind === 'title') return normTitle(s);
  if (kind === 'body' || kind === 'intro' || kind === 'stack') return normBody(s);
  return s.trim();
}

/** Whether a draft says anything its base doesn't: only those are written to storage. */
export function hasChanges(r: Pick<DraftRecord, 'kind' | 'text' | 'base'>): boolean {
  return normDraft(r.kind, r.text) !== normDraft(r.kind, r.base);
}

/** The draft's text is what's saved now: nothing left to keep. */
export function matchesSaved(r: Pick<DraftRecord, 'kind' | 'text'>, saved: string): boolean {
  return normDraft(r.kind, r.text) === normDraft(r.kind, saved);
}

/**
 * The saved text changed under a draft with changes of its own, to something else than the draft: neither may be
 * overwritten, so the editor asks (Load it / Keep mine).
 */
export function inConflict(r: Pick<DraftRecord, 'kind' | 'text' | 'base'>, saved: string): boolean {
  return hasChanges(r) && normDraft(r.kind, saved) !== normDraft(r.kind, r.base) && !matchesSaved(r, saved);
}

const KINDS = new Set<DraftKind>(['title', 'body', 'intro', 'stack', 'comment', 'reply', 'inline', 'edit']);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A stored draft, or null if it isn't one (garbage, or an older format). */
export function parseDraft(raw: string | null): DraftRecord | null {
  if (raw === null) return null;
  let r: Partial<DraftRecord>;
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object' || r.v !== 1 || !KINDS.has(r.kind!) || !isStr(r.project) || !isStr(r.text) || !isStr(r.base) || !isNum(r.created) || !isNum(r.saved)) return null;
  if (r.kind === 'inline' && !(r.at && isStr(r.at.path) && isNum(r.at.line) && (r.at.side === 'left' || r.at.side === 'right'))) return null;
  return r as DraftRecord;
}

/** Commit subject as rebase re-matching compares it: server/reviews.ts normalizeSubject, again. */
export function normalizeSubject(s: string | undefined | null): string {
  let v = (s ?? '').replace(/\s+/g, ' ').trim();
  for (;;) {
    const next = v.replace(/^(fixup|squash|amend)!\s*/i, '');
    if (next === v) return v;
    v = next;
  }
}

/** The commit a PR page shows, as rebase adoption needs it. */
export interface AdoptTarget {
  project: string;
  repo: string;
  sha: string;
  patchId?: string | null;
  subject?: string;
}

/**
 * Drafts written on commits that are gone (rebased away) that belong to `target` now, the way review files follow a
 * rebase (concepts/following-rebases.md): the same patch-id, else the same subject, if that subject is unique among the
 * repo's commits (`subjects`) and only one gone commit had it. `live` is every sha in the repo's range now: a draft on
 * a commit that's still there stays put.
 */
export function adoptable(records: Iterable<DraftRecord>, target: AdoptTarget, live: ReadonlySet<string>, subjects: readonly string[] = []): DraftRecord[] {
  const orphans = [...records].filter((r) => r.project === target.project && r.repo === target.repo && !!r.sha && r.sha !== target.sha && !live.has(r.sha));
  if (target.patchId) {
    const byPatch = orphans.filter((r) => r.patchId === target.patchId);
    if (byPatch.length) return byPatch;
  }
  const subject = normalizeSubject(target.subject);
  if (!subject || subjects.filter((s) => normalizeSubject(s) === subject).length > 1) return [];
  const bySubject = orphans.filter((r) => normalizeSubject(r.subject) === subject);
  return new Set(bySubject.map((r) => r.sha)).size === 1 ? bySubject : [];
}

/**
 * Where a line is after a rebase: still `line` if it has the same text, else the nearest line with that text, else
 * null. A line without remembered text stays where it was, if the file is still that long.
 */
export function relocateLine(lines: readonly string[], line: number, text: string | undefined): number | null {
  if (text === undefined) return line >= 1 && line <= lines.length ? line : null;
  if (lines[line - 1] === text) return line;
  for (let d = 1; d < lines.length; d++) {
    if (lines[line - 1 - d] === text) return line - d;
    if (lines[line - 1 + d] === text) return line + d;
  }
  return null;
}

/** An inline draft's place moved to follow its line (the whole range moves with its end); unchanged if not found. */
export function relocateAt(at: InlineAt, lineText: string | undefined, contentOf: (path: string, side: Side) => string | null | undefined): InlineAt {
  const content = contentOf(at.path, at.side);
  if (content == null) return at;
  const found = relocateLine(content.split('\n'), at.line, lineText);
  if (found === null || found === at.line) return at;
  const d = found - at.line;
  return { ...at, line: found, ...(at.start_line ? { start_line: Math.max(1, at.start_line + d) } : {}) };
}

export interface DraftStoreOptions {
  now?: () => number;
  delay?: number;
  maxAge?: number;
  maxChars?: number;
  /** setTimeout / clearTimeout (fakes in the tests) */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Every draft, in memory, mirrored to storage. `storage` null: there is none (disabled, or it throws), so drafts
 * last as long as the page and `unsaved()` says so. Changes are written `delay` ms after the last one, or on flush();
 * removals at once.
 */
export class DraftStore {
  private mem = new Map<string, DraftRecord>();
  /** changed in memory, not written yet */
  private pending = new Set<string>();
  /** couldn't be written (storage full, or none) */
  private failed = new Set<string>();
  /** came from storage when the page loaded (or from an earlier commit, after a rebase) */
  private restored = new Set<string>();
  /** editors being typed in: a change from another tab doesn't land on them */
  private held = new Map<string, number>();
  private listeners = new Set<() => void>();
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly delay: number;
  private readonly maxAge: number;
  private readonly maxChars: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  /** bumped on every change, for snapshots */
  version = 0;

  constructor(
    private readonly storage: StorageLike | null,
    opts: DraftStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.delay = opts.delay ?? DRAFT_DELAY;
    this.maxAge = opts.maxAge ?? DRAFT_MAX_AGE;
    this.maxChars = opts.maxChars ?? DRAFT_MAX_CHARS;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Take in what earlier visits left: expired, unreadable and misfiled drafts are removed from storage. */
  load(): void {
    for (const [k, raw] of this.stored()) {
      const r = parseDraft(raw);
      if (!r || draftKey(r) !== k || this.expired(r)) {
        this.unstore(k);
        continue;
      }
      this.mem.set(k, r);
      this.restored.add(k);
    }
    this.enforceCap(null);
    this.changed();
  }

  get(key: string): DraftRecord | undefined {
    return this.mem.get(key);
  }

  has(key: string): boolean {
    return this.mem.has(key);
  }

  all(): DraftRecord[] {
    return [...this.mem.values()];
  }

  /** Shown with a "Restored an unsaved draft" notice: it was there before this page loaded. */
  isRestored(key: string): boolean {
    return this.restored.has(key);
  }

  /**
   * Start or change a draft. `text` and `base` are required to start one; facts (patch-id, subject, line text) are
   * kept from before unless given.
   */
  put(id: DraftId & DraftFacts, change: { text: string; base?: string }): string {
    const key = draftKey(id);
    const prev = this.mem.get(key);
    const t = this.now();
    const rec: DraftRecord = { ...prev, ...stripUndefined(id), kind: id.kind, project: id.project, v: 1, text: change.text, base: change.base ?? prev?.base ?? '', created: prev?.created ?? t, saved: t };
    if (prev && prev.text === rec.text && prev.base === rec.base && sameFacts(prev, rec)) return key;
    this.mem.set(key, rec);
    if (hasChanges(rec)) {
      this.pending.add(key);
      this.arm();
    } else {
      // nothing to keep: an untouched editor or an empty box stays open, but leaves nothing in storage
      this.pending.delete(key);
      this.failed.delete(key);
      this.unstore(key);
    }
    this.changed();
    return key;
  }

  /** Saved, cancelled or discarded: gone from memory and storage. */
  remove(key: string): void {
    const had = this.mem.delete(key);
    this.pending.delete(key);
    this.failed.delete(key);
    this.restored.delete(key);
    this.unstore(key);
    if (had) this.changed();
  }

  /** Write every pending change now (and on the timer), and try again with the drafts that couldn't be written. */
  flush(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    if (!this.pending.size && !this.failed.size) return;
    // the ones that couldn't be written before are tried again: there may be room now
    const keys = [...new Set([...this.pending, ...this.failed])];
    this.pending.clear();
    for (const k of keys) {
      const r = this.mem.get(k);
      if (r) this.write(k, r);
    }
    this.enforceCap(new Set(keys));
    this.changed(); // a draft may have become (un)kept: its editor says so
  }

  /** Some draft with changes exists only in this page: closing it would lose that (the beforeunload warning). */
  unsaved(): boolean {
    if (this.failed.size) return true;
    if (this.storage) return false;
    return [...this.mem.values()].some(hasChanges);
  }

  /** This draft has changes that couldn't be written to storage (it's full, or there is none). */
  isUnkept(key: string): boolean {
    if (this.failed.has(key)) return true;
    const r = this.mem.get(key);
    return !this.storage && !!r && hasChanges(r);
  }

  /** Whether storage is there at all. */
  get persistent(): boolean {
    return this.storage !== null;
  }

  /** An editor took focus: changes from other tabs wait until it lets go. Pair with release(). */
  hold(key: string): void {
    this.held.set(key, (this.held.get(key) ?? 0) + 1);
  }

  /** The editor let go: if another tab wrote this draft meanwhile and this one has nothing of its own to write, take theirs. */
  release(key: string): void {
    const n = (this.held.get(key) ?? 0) - 1;
    if (n > 0) return void this.held.set(key, n);
    this.held.delete(key);
    if (!this.storage || this.pending.has(key)) return;
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(key);
    } catch {
      return;
    }
    this.external(key, raw);
  }

  /**
   * Another tab changed storage (the `storage` event). Last write wins: its draft replaces this tab's, unless this tab
   * is typing in that editor or has a change of its own still to write (which will then win).
   */
  external(key: string | null, raw: string | null): void {
    // (nor if this tab's draft couldn't be written: then it's the only copy, and nothing in storage may replace it)
    if (key === null || !key.startsWith(DRAFT_PREFIX) || this.held.has(key) || this.pending.has(key) || this.failed.has(key)) return;
    const mine = this.mem.get(key);
    if (raw === null) {
      // saved or discarded there. An untouched editor open here was never in storage: leave it open.
      if (!mine || !hasChanges(mine)) return;
      this.mem.delete(key);
      this.failed.delete(key);
      this.restored.delete(key);
      this.changed();
      return;
    }
    const r = parseDraft(raw);
    if (!r || draftKey(r) !== key || (mine && mine.text === r.text && mine.base === r.base)) return;
    this.mem.set(key, r);
    this.failed.delete(key);
    this.changed();
  }

  /**
   * After a rebase: move the drafts of the commit `target` replaced onto it (adoptable()), inline ones to where their
   * line is now. One that would land on a draft already there stays where it was (until it expires). Returns how many moved.
   */
  adopt(target: AdoptTarget, live: ReadonlySet<string>, subjects: readonly string[] = [], contentOf?: (path: string, side: Side) => string | null | undefined): number {
    let n = 0;
    for (const r of adoptable(this.mem.values(), target, live, subjects)) {
      const at = r.kind === 'inline' && r.at && contentOf ? relocateAt(r.at, r.lineText, contentOf) : r.at;
      const moved: DraftRecord = { ...r, sha: target.sha, at, patchId: target.patchId ?? r.patchId, subject: target.subject ?? r.subject, movedFrom: r.movedFrom ?? r.sha };
      const key = draftKey(moved);
      if (this.mem.has(key)) continue;
      const old = draftKey(r);
      this.mem.delete(old);
      this.pending.delete(old);
      this.failed.delete(old);
      this.restored.delete(old);
      this.mem.set(key, moved);
      this.restored.add(key);
      this.pending.add(key);
      // written now: the old copy is removed, and the new one mustn't wait for a timer the page may not live to see
      this.flushOne(key);
      this.unstore(old);
      n++;
    }
    if (n) this.changed();
    return n;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---- internals ----

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private arm() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => {
      this.timer = null;
      this.flush();
    }, this.delay);
  }

  private flushOne(key: string) {
    this.pending.delete(key);
    const r = this.mem.get(key);
    if (r) this.write(key, r);
    this.enforceCap(new Set([key]));
  }

  private expired(r: DraftRecord): boolean {
    return this.now() - r.saved > this.maxAge;
  }

  /** Write one draft; if storage is full, make room by dropping the oldest others, then try once more. */
  private write(key: string, r: DraftRecord): void {
    if (!this.storage) {
      this.failed.add(key);
      return;
    }
    const raw = JSON.stringify(r);
    if (key.length + raw.length > this.maxChars) {
      // too big to keep on its own: don't push everything else out for it
      this.failed.add(key);
      this.unstore(key);
      return;
    }
    try {
      this.storage.setItem(key, raw);
      this.failed.delete(key);
      return;
    } catch {
      /* full (QuotaExceededError), or storage refused */
    }
    this.dropOldest(new Set([key]), key.length + raw.length);
    try {
      this.storage.setItem(key, raw);
      this.failed.delete(key);
    } catch {
      this.failed.add(key);
    }
  }

  /** Expired drafts out, then the oldest ones until all of them fit in maxChars (`keep`: just written, stays). */
  private enforceCap(keep: Set<string> | null): void {
    if (!this.storage) return;
    for (const [k, raw] of this.stored()) {
      const r = parseDraft(raw);
      if (r && this.expired(r) && !keep?.has(k)) this.forget(k);
    }
    const total = this.stored().reduce((n, [k, raw]) => n + k.length + raw.length, 0);
    if (total > this.maxChars) this.dropOldest(keep ?? new Set(), total - this.maxChars, true);
  }

  /**
   * Drop the drafts that were changed longest ago, from storage and memory, until `need` chars are freed (`exact`:
   * counted; otherwise, for a full storage, until one more has gone than that would suggest, as quotas are rough).
   */
  private dropOldest(keep: Set<string>, need: number, exact = false): void {
    const entries = this.stored()
      .filter(([k]) => !keep.has(k))
      .map(([k, raw]) => ({ k, size: k.length + raw.length, saved: parseDraft(raw)?.saved ?? 0 }))
      .sort((a, b) => a.saved - b.saved);
    let freed = 0;
    for (const e of entries) {
      if (exact && freed >= need) break;
      this.forget(e.k);
      freed += e.size;
      if (!exact && freed >= need) break;
    }
  }

  /**
   * Gone for good (expired, or pushed out to make room). An editor being typed in keeps its text, but as not kept
   * (so leaving warns); any other is closed, rather than pretend it's kept.
   */
  private forget(key: string) {
    this.unstore(key);
    if (this.held.has(key) && this.mem.has(key)) return void this.failed.add(key);
    if (this.mem.delete(key)) {
      this.pending.delete(key);
      this.failed.delete(key);
      this.restored.delete(key);
    }
  }

  private stored(): [string, string][] {
    if (!this.storage) return [];
    const out: [string, string][] = [];
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (!k?.startsWith(DRAFT_PREFIX)) continue;
        const raw = this.storage.getItem(k);
        if (raw !== null) out.push([k, raw]);
      }
    } catch {
      /* storage went away: nothing to read */
    }
    return out;
  }

  private unstore(key: string) {
    try {
      this.storage?.removeItem(key);
    } catch {
      /* nothing to do */
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function sameFacts(a: DraftRecord, b: DraftRecord): boolean {
  return a.patchId === b.patchId && a.subject === b.subject && a.lineText === b.lineText;
}
