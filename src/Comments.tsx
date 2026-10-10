import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, type Anchor, type Comment, type Reviewer, type Thread } from './api';
import { relativeTime } from './util';
import { applyFormat, type Format } from './prText';

marked.setOptions({ gfm: true, breaks: false });

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? '', { async: false }) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
  }, [text]);
  if (!text?.trim()) return <div className={`markdown-body muted ${className ?? ''}`}><em>No description provided.</em></div>;
  return <div className={`markdown-body ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The reviewer (server/reviewer.ts), loaded once at startup by main.tsx; until then nobody's comments are editable. */
export let reviewer: Reviewer = { id: '', name: '' };
export async function loadReviewer() {
  try {
    reviewer = await api.me();
  } catch {
    /* the UI still renders; comments just aren't editable */
  }
}
export const isReviewer = (author: string) => !!reviewer.id && author === reviewer.id;

export function displayName(author: string) {
  if (author === 'claude') return 'Claude';
  if (isReviewer(author)) return reviewer.name;
  return author;
}

export function Avatar({ author, size = 32 }: { author: string; size?: number }) {
  const a = (author || '?').toLowerCase();
  const cls = a === 'claude' ? 'avatar avatar-claude' : isReviewer(a) ? 'avatar avatar-reviewer' : 'avatar';
  const letter = a === 'claude' ? '✳' : ((isReviewer(a) ? reviewer.name : author)[0] ?? '?').toUpperCase();
  return (
    <span className={cls} style={{ width: size, height: size, fontSize: Math.round(size * (a === 'claude' ? 0.55 : 0.45)) }} title={displayName(author)}>
      {letter}
    </span>
  );
}

export function AuthorLabel({ author }: { author: string }) {
  return (
    <>
      <strong className="author">{displayName(author)}</strong>
      {author === 'claude' && <span className="Label Label--agent">agent</span>}
    </>
  );
}

export function CommentForm({
  placeholder = 'Leave a comment',
  submitLabel = 'Comment',
  onSubmit,
  onCancel,
  autoFocus,
  initial = '',
  compact,
}: {
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
  autoFocus?: boolean;
  initial?: string;
  compact?: boolean;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(text);
      setText('');
      setResetKey((k) => k + 1); // back to the Write tab
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <MarkdownEditor
      key={resetKey}
      value={text}
      onChange={setText}
      onSubmit={submit}
      onCancel={onCancel}
      placeholder={placeholder}
      submitLabel={submitLabel}
      autoFocus={autoFocus}
      compact={compact}
      busy={busy}
      error={err}
      canSubmit={!!text.trim()}
    />
  );
}

const ICONS = {
  code: 'm11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z',
  link: 'm7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z',
  list: 'M5.75 2.5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5ZM2 14a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm1-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM2 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  quote: 'M1.75 2.5h10.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Zm4 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5ZM2.5 7.75v6a.75.75 0 0 1-1.5 0v-6a.75.75 0 0 1 1.5 0Z',
};

export function Octicon({ d, size = 16, className }: { d: string | string[]; size?: number; className?: string }) {
  return (
    <svg className={`octicon ${className ?? ''}`} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="currentColor">
      {(Array.isArray(d) ? d : [d]).map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

/**
 * Write / Preview markdown editor (controlled), used by comment forms and the PR description editor.
 * ⌘/Ctrl+Enter submits, Esc cancels; with `toolbar`, a small formatting toolbar and ⌘B / ⌘I / ⌘K.
 */
export function MarkdownEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  submitLabel = 'Comment',
  autoFocus,
  compact,
  busy,
  error,
  canSubmit = true,
  toolbar,
  notice,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  compact?: boolean;
  busy?: boolean;
  error?: string | null;
  canSubmit?: boolean;
  toolbar?: boolean;
  notice?: ReactNode;
  className?: string;
}) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const ref = useRef<HTMLTextAreaElement>(null);
  const format = (f: Format) => {
    const ta = ref.current;
    if (!ta) return;
    const r = applyFormat(value, ta.selectionStart, ta.selectionEnd, f);
    pendingSel.current = [r.start, r.end];
    onChange(r.text);
  };
  // restore the selection as soon as the new value is in the DOM (before any further keystroke lands)
  const pendingSel = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const sel = pendingSel.current;
    if (!sel || !ref.current) return;
    pendingSel.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(sel[0], sel[1]);
  });
  const tools: [Format, string, ReactNode][] = [
    ['bold', 'Bold (⌘B)', <b>B</b>],
    ['italic', 'Italic (⌘I)', <i style={{ fontFamily: 'Georgia, serif' }}>I</i>],
    ['code', 'Code', <Octicon d={ICONS.code} />],
    ['link', 'Link (⌘K)', <Octicon d={ICONS.link} />],
    ['list', 'Bulleted list', <Octicon d={ICONS.list} />],
    ['quote', 'Quote', <Octicon d={ICONS.quote} />],
  ];
  return (
    <div className={`comment-form ${compact ? 'compact' : ''} ${className ?? ''}`}>
      <div className="comment-form-tabs">
        <button type="button" className={tab === 'write' ? 'selected' : ''} onClick={() => setTab('write')}>Write</button>
        <button type="button" className={tab === 'preview' ? 'selected' : ''} onClick={() => setTab('preview')}>Preview</button>
        {toolbar && tab === 'write' && (
          <span className="md-toolbar" role="toolbar" aria-label="Formatting">
            {tools.map(([f, label, icon]) => (
              <button key={f} type="button" className="md-tool" title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={() => format(f)}>{icon}</button>
            ))}
          </span>
        )}
      </div>
      <div className="comment-form-body">
        {notice}
        {tab === 'write' ? (
          <textarea
            ref={ref}
            autoFocus={autoFocus}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              const mod = e.metaKey || e.ctrlKey;
              if (e.key === 'Enter' && mod) {
                e.preventDefault();
                if (canSubmit && !busy) onSubmit();
              } else if (e.key === 'Escape' && onCancel) {
                e.preventDefault();
                onCancel();
              } else if (toolbar && mod && !e.shiftKey && !e.altKey && ['b', 'i', 'k'].includes(e.key.toLowerCase())) {
                e.preventDefault();
                format(({ b: 'bold', i: 'italic', k: 'link' } as const)[e.key.toLowerCase() as 'b' | 'i' | 'k']);
              }
            }}
          />
        ) : (
          <div className="comment-preview"><Markdown text={value || 'Nothing to preview'} /></div>
        )}
        {error && <div className="flash flash-error">{error}</div>}
        <div className="comment-form-actions">
          <span className="hint">Markdown supported · ⌘↵ to {submitLabel === 'Comment' || submitLabel === 'Reply' ? 'submit' : 'save'}</span>
          {onCancel && <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>}
          <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={busy || !canSubmit}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function CommentView({ c, onEdit, onDelete, variant = 'inline' }: { c: Comment; onEdit?: (body: string) => Promise<unknown>; onDelete?: () => Promise<unknown>; variant?: 'inline' | 'timeline' }) {
  const [editing, setEditing] = useState(false);
  const header = (
    <div className="comment-header">
      {variant === 'inline' && <Avatar author={c.author} size={20} />}
      <AuthorLabel author={c.author} />
      <span className="muted" title={c.created ?? ''}>{c.created ? relativeTime(c.created) : ''}</span>
      {c.edited && <span className="muted" title={`edited ${c.edited}`}>· edited</span>}
      <span className="spacer" />
      {isReviewer(c.author) && onEdit && !editing && <button className="btn-octicon" title="Edit" onClick={() => setEditing(true)}>Edit</button>}
      {isReviewer(c.author) && onDelete && !editing && (
        <button className="btn-octicon" title="Delete" onClick={() => { if (confirm('Delete this comment?')) onDelete(); }}>Delete</button>
      )}
    </div>
  );
  const body = editing && onEdit ? (
    <CommentForm initial={c.body} submitLabel="Update comment" autoFocus compact onCancel={() => setEditing(false)} onSubmit={async (b) => { await onEdit(b); setEditing(false); }} />
  ) : (
    <Markdown text={c.body} className="comment-body" />
  );
  if (variant === 'timeline') {
    return (
      <div className={`timeline-comment ${c.author === 'claude' ? 'is-claude' : ''}`}>
        {header}
        <div className="timeline-comment-body">{body}</div>
      </div>
    );
  }
  return (
    <div className={`review-comment ${c.author === 'claude' ? 'is-claude' : ''}`}>
      {header}
      <div className="review-comment-body">{body}</div>
    </div>
  );
}

export interface ThreadActions {
  reply: (tid: string, body: string) => Promise<unknown>;
  resolve: (tid: string, resolved: boolean) => Promise<unknown>;
  edit: (tid: string, cid: string, body: string) => Promise<unknown>;
  remove: (tid: string, cid: string) => Promise<unknown>;
}

export function ThreadView({ thread, actions, context }: { thread: Thread; actions: ThreadActions; context?: ReactNode }) {
  const [replying, setReplying] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const collapsed = thread.resolved && !showResolved;
  return (
    <div className={`thread ${thread.resolved ? 'resolved' : ''} ${thread.outdated ? 'outdated' : ''}`} id={`thread-${thread.id}`}>
      {context}
      {thread.outdated && <OutdatedContext thread={thread} />}
      {thread.resolved && (
        <div className="thread-resolved-bar">
          <span>✓ This conversation was marked as resolved</span>
          <button className="btn btn-sm" onClick={() => setShowResolved((v) => !v)}>{showResolved ? 'Hide resolved' : 'Show resolved'}</button>
        </div>
      )}
      {!collapsed && (
        <>
          <div className="thread-comments">
            {thread.comments.map((c) => (
              <CommentView key={c.id} c={c} onEdit={(b) => actions.edit(thread.id, c.id, b)} onDelete={() => actions.remove(thread.id, c.id)} />
            ))}
          </div>
          <div className="thread-footer">
            {replying ? (
              <CommentForm placeholder="Reply…" submitLabel="Reply" autoFocus compact onCancel={() => setReplying(false)} onSubmit={async (b) => { await actions.reply(thread.id, b); setReplying(false); }} />
            ) : (
              <div className="thread-footer-row">
                <Avatar author={reviewer.id} size={24} />
                <button className="reply-placeholder" onClick={() => setReplying(true)}>Reply…</button>
              </div>
            )}
            <div className="thread-footer-actions">
              <button className="btn btn-sm" onClick={() => actions.resolve(thread.id, !thread.resolved)}>{thread.resolved ? 'Unresolve conversation' : 'Resolve conversation'}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** GitHub-style "Outdated" header plus the code the thread was originally made on (from its stored anchor). */
export function OutdatedContext({ thread }: { thread: Thread }) {
  const a = thread.anchor;
  const mixed = !!a?.start_line && !!a.start_side && a.start_side !== a.side;
  const where = a ? `${a.path}:${mixed ? `${a.start_side === 'left' ? '-' : '+'}${a.start_line} to ${a.side === 'left' ? '-' : '+'}` : a.start_line ? `${a.start_line}-` : ''}${a.line}` : thread.path;
  return (
    <>
      <div className="thread-location" title="The commented code is not in this commit's diff any more">
        <span className="Label Label--attention Label--outdated">Outdated</span>
        {a ? <>originally on <code>{where}</code> ({mixed ? 'old and new' : a.side === 'left' ? 'old' : 'new'} file) in <code>{a.commit.slice(0, 8)}</code></> : <>on <code>{where}</code></>}
      </div>
      {a && <AnchorSnippet anchor={a} />}
    </>
  );
}

export function AnchorSnippet({ anchor: a }: { anchor: Anchor }) {
  const split = (s?: string) => (s === undefined ? [] : s.split('\n'));
  const before = split(a.before);
  const text = split(a.text);
  const after = split(a.after);
  // for a range spanning old and new lines, `text` is just the end line (on a.side)
  const mixed = !!a.start_side && a.start_side !== a.side;
  const first = (mixed ? a.line : a.start_line ?? a.line) - before.length;
  const rows = [...before.map((l) => [l, false] as const), ...text.map((l) => [l, true] as const), ...after.map((l) => [l, false] as const)];
  return (
    <div className="snippet">
      <table>
        <tbody>
          {rows.map(([l, hl], i) => (
            <tr key={i} className={hl ? `hl ${a.side === 'left' ? 'hl-del' : 'hl-add'}` : ''}>
              <td className="ln">{first + i}</td>
              <td className="code">{l || ' '}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
