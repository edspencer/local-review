// Pure text helpers for the PR title / description editors (no DOM, so they're unit-tested under node).

import { normBody } from '../shared/prText.js';

/** Normalised like the server does, so "unchanged" compares what would actually be stored. */
export { normBody, normTitle } from '../shared/prText.js';

/** Clipboard text for "Copy title + description". */
export const titleAndBody = (pr: { title: string; body: string }) => (pr.body.trim() ? `${pr.title}\n\n${normBody(pr.body)}` : pr.title);

// "Copy full PR body" (fullPrBody, CONTEXT_SEPARATOR) lives in shared/prText.ts: the server's `plan` command
// composes the exact same text.
export { CONTEXT_SEPARATOR, fullPrBody } from '../shared/prText.js';

export type Format = 'bold' | 'italic' | 'code' | 'link' | 'list' | 'quote';

/** Apply a markdown format to the selection of `text` (GitHub-toolbar style). Returns the new text and selection. */
export function applyFormat(text: string, start: number, end: number, f: Format): { text: string; start: number; end: number } {
  const sel = text.slice(start, end);
  const wrap = (pre: string, post: string, placeholder: string) => {
    const inner = sel || placeholder;
    return { text: text.slice(0, start) + pre + inner + post + text.slice(end), start: start + pre.length, end: start + pre.length + inner.length };
  };
  if (f === 'bold') return wrap('**', '**', 'bold text');
  if (f === 'italic') return wrap('_', '_', 'italic text');
  if (f === 'code') return sel.includes('\n') ? wrap('```\n', '\n```', '') : wrap('`', '`', 'code');
  if (f === 'link') {
    const r = wrap('[', '](url)', 'text');
    return sel ? { ...r, start: r.end + 2, end: r.end + 5 } : r; // with a selection, select "url" next
  }
  // line prefixes: whole lines touched by the selection
  const prefix = f === 'list' ? '- ' : '> ';
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end; // a selection ending at a line break stops before the next line
  const nl = text.indexOf('\n', last);
  const le = nl < 0 ? text.length : nl;
  const lines = text.slice(ls, le).split('\n');
  const all = lines.every((l) => l.startsWith(prefix));
  const out = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l)).join('\n');
  const result = text.slice(0, ls) + out + text.slice(le);
  if (start === end) {
    // just a caret: keep it where it was in the line's text (GitHub does the same)
    const caret = Math.max(ls, start + (all ? -prefix.length : prefix.length));
    return { text: result, start: caret, end: caret };
  }
  return { text: result, start: ls, end: ls + out.length };
}
