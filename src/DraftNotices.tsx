// What an editor says about its draft: restored from an earlier visit (with Discard), not kept in this browser, or
// changed elsewhere meanwhile (Load it / Keep mine). Used by the PR title and description editors, the intro and
// stack note editors (PrEdit.tsx) and the comment forms (Comments.tsx).
import { useEffect, useRef } from 'react';
import type { DraftStatus } from './useDrafts';

/** "10:42" today, "Oct 3, 10:42" another day. */
export function draftTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** The notices about a draft, above its text: none for a draft started in this page and kept. */
export function DraftNotice({ status, onDiscard }: { status?: DraftStatus; onDiscard: () => void }) {
  if (!status) return null;
  return (
    <>
      {status.restored && (
        <div className="draft-notice" role="status">
          <span className="draft-notice-dot" aria-hidden="true" />
          <span>
            Restored an unsaved draft from <time dateTime={new Date(status.restored.at).toISOString()}>{draftTime(status.restored.at)}</time>
            {status.restored.from && <span className="muted"> (written on <code>{status.restored.from.slice(0, 8)}</code>, before a rebase)</span>}
          </span>
          <button type="button" className="btn-link draft-discard" onClick={onDiscard}>Discard</button>
        </div>
      )}
      {status.unkept && (
        <div className="flash flash-warn draft-unkept" role="alert">
          This browser can't keep a copy of this draft (its storage is full or turned off). Save it before you leave the page.
        </div>
      )}
    </>
  );
}

/** Notice inside an editor when the saved value changed under an unsaved draft (e.g. an agent edited the file). */
export function ChangedElsewhere({ what, onLoad, onKeep }: { what: string; onLoad: () => void; onKeep: () => void }) {
  return (
    <div className="flash flash-warn changed-elsewhere" role="status">
      This {what} was changed elsewhere. <button type="button" className="btn-link" onClick={onLoad}>Load it</button> (discards your draft) ·{' '}
      <button type="button" className="btn-link" onClick={onKeep}>Keep mine</button>
    </div>
  );
}

/** An edit in progress: `base` is the saved value the editor started from (or last reconciled with), `text` the draft. */
export interface TextDraft {
  base: string;
  text: string;
}

/**
 * Keeps a draft in step with the saved value: an untouched draft follows it; one with changes shows a notice (a
 * conflict) unless the saved value now says the same as the draft, which then has nothing left to keep. A restored
 * draft that says what's saved already (it was saved in another tab, say) closes: there's nothing to restore.
 */
export function useReconcile(draft: TextDraft, current: string, setDraft: (d: TextDraft) => void, norm: (s: string) => string, restoredClose?: () => void) {
  const dirty = norm(draft.text) !== norm(draft.base);
  const changed = norm(current) !== norm(draft.base);
  const same = norm(current) === norm(draft.text);
  const first = useRef(true);
  useEffect(() => {
    const wasFirst = first.current;
    first.current = false;
    if (wasFirst && restoredClose && same) return restoredClose();
    if (changed && (!dirty || same)) setDraft({ base: current, text: dirty ? draft.text : current });
  });
  const conflict = changed && dirty && !same;
  return {
    conflict,
    load: () => setDraft({ base: current, text: current }),
    keep: () => setDraft({ ...draft, base: current }),
  };
}

/** A small dot where there's an unsaved draft (kept in this browser): on a tab, a sidebar row, a stack. */
export function DraftDot({ title = 'Unsaved draft (kept in this browser)' }: { title?: string }) {
  return <span className="draft-dot" title={title} aria-label={title} role="img" />;
}
