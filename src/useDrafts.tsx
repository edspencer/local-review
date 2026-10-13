// The app's draft store (drafts.ts) on the page: localStorage, the `storage` event from other tabs, writing before
// the page goes away, the beforeunload warning, and the hooks the editors use.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { DraftStore, draftKey, hasChanges, type DraftFacts, type DraftId, type DraftRecord, type StorageLike } from './drafts';

/** localStorage, if this browser lets the page use it (it can be off, or throw on any access). */
function openStorage(): StorageLike | null {
  try {
    const s = window.localStorage;
    const probe = 'lr.draft-probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export const draftStore = new DraftStore(openStorage());
draftStore.load();

window.addEventListener('storage', (e) => {
  if (e.storageArea === null || e.storageArea === window.localStorage) draftStore.external(e.key, e.newValue);
});
// write what's pending while the page can still do it
window.addEventListener('pagehide', () => draftStore.flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') draftStore.flush();
});
// Drafts kept in localStorage come back on the next visit, so leaving is safe, and like GitHub we don't ask. Only a
// draft that couldn't be kept (storage full or off) would be lost: then the browser asks first.
window.addEventListener('beforeunload', (e) => {
  draftStore.flush();
  if (draftStore.unsaved()) e.preventDefault();
});

const subscribe = (fn: () => void) => draftStore.subscribe(fn);

/** The draft for this key (undefined: none, so the editor is closed). Re-renders only when this draft changes. */
export function useDraft(key: string | null): DraftRecord | undefined {
  return useSyncExternalStore(subscribe, () => (key ? draftStore.get(key) : undefined));
}

/** Re-render when this draft becomes (un)kept or (un)restored, too. */
export function useDraftStatus(key: string | null): { restored: boolean; unkept: boolean } {
  const restored = useSyncExternalStore(subscribe, () => !!key && draftStore.isRestored(key));
  const unkept = useSyncExternalStore(subscribe, () => !!key && draftStore.isUnkept(key));
  return { restored, unkept };
}

/** Focus inside an editor holds its draft against other tabs' changes until focus leaves (drafts.ts hold()). */
export function useDraftHold(key: string | null) {
  const held = useRef<string | null>(null);
  const letGo = () => {
    if (held.current) draftStore.release(held.current);
    held.current = null;
  };
  useEffect(() => letGo, [key]); // unmounted, or another draft
  return {
    onFocus: () => {
      if (!key || held.current === key) return;
      letGo();
      held.current = key;
      draftStore.hold(key);
    },
    onBlur: (e: React.FocusEvent) => {
      // focus moving within the editor (the textarea to a toolbar button) isn't leaving it
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) letGo();
    },
  };
}

/**
 * Where drafts with changes are, as a set of ids for the markers: `pr:<project>/<repo>/<sha>` (any box of that PR),
 * `conv:` / `files:` (its Conversation / Files changed tab), `thread:<pr>/<thread id>` (a reply or an edit in it),
 * `intro:<project>`, `stack:<project>/<repo>/<number>`.
 * Re-renders only when that set changes, not on every keystroke.
 */
export function useDraftMarkers(): ReadonlySet<string> {
  const sig = useSyncExternalStore(subscribe, markerSignature);
  return useMemo(() => new Set(sig ? sig.split('\n') : []), [sig]);
}
let markerCache = { version: -1, sig: '' };
function markerSignature(): string {
  if (markerCache.version === draftStore.version) return markerCache.sig;
  const ids = new Set<string>();
  for (const r of draftStore.all()) {
    if (!hasChanges(r)) continue;
    if (r.kind === 'intro') ids.add(`intro:${r.project}`);
    else if (r.kind === 'stack') ids.add(`stack:${r.project}/${r.repo}/${r.stack?.number}`);
    else {
      const pr = `${r.project}/${r.repo}/${r.sha}`;
      ids.add(`pr:${pr}`);
      if (r.kind === 'inline') ids.add(`files:${pr}`);
      else if (r.kind !== 'title') ids.add(`conv:${pr}`);
      if ((r.kind === 'reply' || r.kind === 'edit') && r.thread) ids.add(`thread:${pr}/${r.thread}`);
    }
  }
  markerCache = { version: draftStore.version, sig: [...ids].sort().join('\n') };
  return markerCache.sig;
}

/**
 * The open inline comment forms of a PR, oldest first: their keys and places (not their text, so the diff doesn't
 * re-render on every keystroke; each form reads its own text).
 */
export function useInlineDrafts(project: string, repo: string, sha: string | undefined): { key: string; at: NonNullable<DraftRecord['at']> }[] {
  const sig = useSyncExternalStore(subscribe, () =>
    JSON.stringify(
      draftStore
        .all()
        .filter((r) => r.kind === 'inline' && r.project === project && r.repo === repo && r.sha === sha && r.at)
        .sort((a, b) => a.created - b.created)
        .map((r) => [draftKey(r), r.at]),
    ),
  );
  return useMemo(() => (JSON.parse(sig) as [string, NonNullable<DraftRecord['at']>][]).map(([key, at]) => ({ key, at })), [sig]);
}

/** The PR page a draft belongs to: what comment, reply and inline drafts are keyed by, and what follows a rebase. */
export interface DraftScope {
  project: string;
  repo: string;
  sha: string;
  patchId: string | null;
  subject: string;
}
export const DraftScopeContext = createContext<DraftScope | null>(null);

/** A comment-kind draft id in the PR page's scope, with its rebase facts. */
export function useScopedId(kind: 'comment' | 'reply' | 'edit' | 'inline', extra: Partial<DraftId> & DraftFacts = {}): (DraftId & DraftFacts) | null {
  const s = useContext(DraftScopeContext);
  const sig = JSON.stringify(extra);
  return useMemo(
    () => (s ? { kind, project: s.project, repo: s.repo, sha: s.sha, patchId: s.patchId, subject: s.subject, ...extra } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s?.project, s?.repo, s?.sha, s?.patchId, s?.subject, kind, sig],
  );
}

/**
 * A draft of a text that's saved somewhere (a PR title or description, the intro, a stack note, an edited comment):
 * the editor is open while there is one. `draft` is what the editors take ({ base, text }); `setDraft(null)` closes it.
 */
export function useTextDraft(id: (DraftId & DraftFacts) | null) {
  const key = id ? draftKey(id) : null;
  const rec = useDraft(key);
  const { restored, unkept } = useDraftStatus(key);
  const draft = useMemo(() => (rec ? { base: rec.base, text: rec.text } : undefined), [rec]);
  const setDraft = useCallback(
    (d: { base: string; text: string } | null) => {
      if (!id || !key) return;
      if (d) draftStore.put(id, { text: d.text, base: d.base });
      else draftStore.remove(key);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, id?.patchId, id?.subject],
  );
  return { key, draft, setDraft, status: rec ? { restored: restored ? { at: rec.saved, from: rec.movedFrom } : undefined, unkept } : undefined };
}

/** What an editor shows about its draft: restored from earlier (with Discard), or not kept in this browser. */
export interface DraftStatus {
  restored?: { at: number; from?: string };
  unkept: boolean;
}
