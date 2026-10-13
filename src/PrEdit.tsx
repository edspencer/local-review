// In-place editing and copying of a commit's PR title and description (GitHub-style). Edits are saved as
// overrides in projects/<p>/prs/<repo>/<sha>.yaml via PUT …/pr; the reviewed repo's commit message is never touched.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PrInfo } from './api';
import { MarkdownEditor, Octicon } from './Comments';
import { ChangedElsewhere, DraftNotice, useReconcile, type TextDraft } from './DraftNotices';
import { useDraftHold, type DraftStatus } from './useDrafts';
import { normBody, normTitle, titleAndBody } from './prText';
import { useTilde } from './util';

/** An edit in progress: `base` is the value the editor started from (or last reconciled with), `text` the draft. */
export type PrDraft = TextDraft;

export type PrChange = { title?: string | null; body?: string | null; status?: 'draft' | 'ready' | null };

const ICON = {
  copy: [
    'M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z',
    'M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z',
  ],
  check: 'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
  pencil: 'M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z',
  chevron: 'M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z',
  kebab: 'M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
};

async function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

/** copy(text) puts text on the clipboard; `state` is 'copied' / 'failed' for ~2 s afterwards (for the tooltip). */
export function useCopy() {
  const [state, setState] = useState<null | 'copied' | 'failed'>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    writeClipboard(text).then(() => setState('copied'), () => setState('failed'));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 2000);
  };
  return { state, copy };
}

function CopiedTip({ state }: { state: null | 'copied' | 'failed' }) {
  return (
    <span className={`copy-tip ${state ? 'show' : ''}`} role="status" aria-live="polite">
      {state === 'copied' ? 'Copied!' : state === 'failed' ? 'Copy failed' : ''}
    </span>
  );
}

export const FULL_BODY_TIP = 'Copy full PR body: the project intro, the stack note, ---, then this description';

/** GitHub clipboard-copy: a copy icon that turns into a green check with a "Copied!" tooltip. */
export function CopyButton({ text, label, className = 'btn btn-sm btn-icon', caption }: { text: string; label: string; className?: string; caption?: string }) {
  const { state, copy } = useCopy();
  return (
    <span className="copy-wrap">
      <button type="button" className={`${className} ${caption ? 'has-caption' : ''} ${state === 'copied' ? 'is-copied' : ''}`} title={label} aria-label={label} onClick={() => copy(text)}>
        <Octicon d={state === 'copied' ? ICON.check : ICON.copy} />
        {caption && <span className="copy-caption">{caption}</span>}
      </button>
      <CopiedTip state={state} />
    </span>
  );
}

/** A small dropdown that closes on outside click and Esc. */
function Dropdown({ button, children, align = 'right', className }: { button: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  return (
    <span className={`dropdown ${className ?? ''}`} ref={ref}>
      {button(open, () => setOpen((o) => !o))}
      {open && <div className={`dropdown-menu align-${align}`} role="menu">{children(() => setOpen(false))}</div>}
    </span>
  );
}

const EDITED_TIP = 'Edited locally; the commit message is unchanged';

/** GitHub's "edited ▾" marker for a field that is an override, with "Revert to commit message". */
export function EditedMarker({ what, original, onRevert, align = 'left' }: { what: 'title' | 'description'; original: string; onRevert: () => Promise<unknown>; align?: 'left' | 'right' }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dropdown
      className="edited-marker"
      align={align}
      button={(open, toggle) => (
        <button type="button" className="edited-btn" title={EDITED_TIP} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          edited<Octicon d={ICON.chevron} size={10} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="dropdown-header">{EDITED_TIP}.</div>
          <div className="dropdown-original">
            <span className="muted">Commit message {what === 'title' ? 'subject' : 'body'}:</span>
            <div className={`original-text ${what === 'title' ? '' : 'is-body'}`}>{original.trim() || <em className="muted">(empty)</em>}</div>
          </div>
          {err && <div className="flash flash-error small">{err}</div>}
          <button
            type="button"
            role="menuitem"
            className="dropdown-item danger"
            onClick={async () => {
              if (!confirm(`Revert the ${what} to the commit message? The edited ${what} is discarded.`)) return;
              try { await onRevert(); close(); } catch (e) { setErr((e as Error).message); }
            }}
          >
            Revert to commit message
          </button>
        </>
      )}
    </Dropdown>
  );
}

/** What every draft editor takes besides its text: how its draft stands (DraftNotice), and its key (to hold it while typing). */
export interface DraftProps {
  status?: DraftStatus;
  draftKey?: string | null;
}

/** The PR title in edit mode: an input with Save / Cancel (Enter saves, Esc cancels, asking first if changed). */
export function TitleEditor({ pr, draft, setDraft, onSave, onCancel, status, draftKey = null }: { pr: PrInfo; draft: PrDraft; setDraft: (d: PrDraft) => void; onSave: (title: string) => Promise<unknown>; onCancel: () => void } & DraftProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { conflict, load, keep } = useReconcile(draft, pr.title, setDraft, normTitle, status?.restored && onCancel);
  const hold = useDraftHold(draftKey);
  const ref = useRef<HTMLInputElement>(null);
  const tilde = useTilde();
  // a draft restored on load doesn't take the focus (there may be several on the page)
  useEffect(() => { if (!status?.restored) { ref.current?.focus(); ref.current?.select(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = () => {
    if (normTitle(draft.text) !== normTitle(draft.base) && !confirm('Discard your changes to the title?')) return;
    onCancel();
  };
  const save = async () => {
    if (busy || !normTitle(draft.text)) return;
    setBusy(true);
    setErr(null);
    try { await onSave(draft.text); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="pr-title-edit" {...hold}>
      <form className="pr-title-edit-row" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <input
          ref={ref}
          className="form-control pr-title-input"
          aria-label="Title"
          value={draft.text}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
        />
        <button type="submit" className="btn btn-sm" disabled={busy || !normTitle(draft.text)}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn-link" onClick={cancel} disabled={busy}>Cancel</button>
      </form>
      <DraftNotice status={status} onDiscard={onCancel} />
      {conflict && <ChangedElsewhere what="title" onLoad={load} onKeep={keep} />}
      {err && <div className="flash flash-error">{err}</div>}
      <div className="pr-title-edit-hint muted">
        Saved locally in <code>{tilde(pr.target_file)}</code>; the commit message is unchanged. Enter saves, Esc cancels.
      </div>
    </div>
  );
}

/**
 * A markdown field in edit mode (the PR description, the project intro, a stack note): Write / Preview with a
 * small toolbar, Save / Cancel, ⌘↵ saves, Esc cancels (asking first if changed). `current` is the saved value,
 * so a change on disk while editing shows the "changed elsewhere" notice.
 */
export function MarkdownFieldEditor({ current, what, placeholder, draft, setDraft, onSave, onCancel, className = 'pr-body-editor', status, draftKey = null }: { current: string; what: string; placeholder: string; draft: PrDraft; setDraft: (d: PrDraft) => void; onSave: (text: string) => Promise<unknown>; onCancel: () => void; className?: string } & DraftProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { conflict, load, keep } = useReconcile(draft, current, setDraft, normBody, status?.restored && onCancel);
  const cancel = () => {
    if (normBody(draft.text) !== normBody(draft.base) && !confirm(`Discard your changes to the ${what}?`)) return;
    onCancel();
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try { await onSave(draft.text); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <MarkdownEditor
      className={className}
      value={draft.text}
      onChange={(text) => setDraft({ ...draft, text })}
      onSubmit={save}
      onCancel={cancel}
      placeholder={placeholder}
      submitLabel="Save"
      autoFocus={!status?.restored}
      compact
      toolbar
      images
      busy={busy}
      error={err}
      holdKey={draftKey}
      notice={
        <>
          <DraftNotice status={status} onDiscard={onCancel} />
          {conflict && <ChangedElsewhere what={what} onLoad={load} onKeep={keep} />}
        </>
      }
    />
  );
}

/** The PR description in edit mode. */
export function BodyEditor({ pr, draft, setDraft, onSave, onCancel, status, draftKey }: { pr: PrInfo; draft: PrDraft; setDraft: (d: PrDraft) => void; onSave: (body: string) => Promise<unknown>; onCancel: () => void } & DraftProps) {
  return <MarkdownFieldEditor current={pr.body} what="description" placeholder="Add a description" draft={draft} setDraft={setDraft} onSave={onSave} onCancel={onCancel} status={status} draftKey={draftKey} />;
}

/** The "…" menu in the description's header. */
export function DescriptionMenu({ pr, onEdit, onRevert, fullBody }: { pr: PrInfo; onEdit: () => void; onRevert: () => Promise<unknown>; fullBody?: string }) {
  const { state, copy } = useCopy();
  return (
    <span className="copy-wrap">
      <Dropdown
        align="right"
        button={(open, toggle) => (
          <button type="button" className={`btn-octicon kebab ${state === 'copied' ? 'is-copied' : ''}`} title="Description actions" aria-label="Description actions" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
            <Octicon d={state === 'copied' ? ICON.check : ICON.kebab} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button type="button" role="menuitem" className="dropdown-item" onClick={() => { close(); onEdit(); }}>Edit</button>
            <div className="dropdown-divider" />
            <button type="button" role="menuitem" className="dropdown-item" onClick={() => { close(); copy(pr.body); }}>Copy Markdown</button>
            <button type="button" role="menuitem" className="dropdown-item" onClick={() => { close(); copy(titleAndBody(pr)); }}>Copy title + description</button>
            {fullBody !== undefined && (
              <button type="button" role="menuitem" className="dropdown-item" title={FULL_BODY_TIP} onClick={() => { close(); copy(fullBody); }}>Copy full PR body</button>
            )}
            {pr.body_source === 'override' && (
              <>
                <div className="dropdown-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="dropdown-item danger"
                  onClick={async () => {
                    close();
                    if (confirm('Revert the description to the commit message? The edited description is discarded.')) await onRevert().catch((e) => alert((e as Error).message));
                  }}
                >
                  Revert to commit message
                </button>
              </>
            )}
          </>
        )}
      </Dropdown>
      <CopiedTip state={state} />
    </span>
  );
}

export function EditIconButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="btn-octicon" title={label} aria-label={label} onClick={onClick}>
      <Octicon d={ICON.pencil} />
    </button>
  );
}
