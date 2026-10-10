// The full PR body composition, shared by the UI ("Full body" / Copy full PR body) and the server (the `plan`
// command), so both produce exactly the same text. No imports: it's bundled by Vite and run by tsx.

/**
 * What goes between the project context (intro + stack note) and the PR's own description in the full PR body.
 * Change it here; it's the only place.
 */
export const CONTEXT_SEPARATOR = '\n\n---\n\n';

/** A PR title as it's stored: whitespace runs collapsed, trimmed. */
export const normTitle = (s: string) => s.replace(/\s+/g, ' ').trim();
/** A PR body as it's stored: LF line endings, no trailing whitespace. */
export const normBody = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();

const block = (s: string | null | undefined) => (s ?? '').replace(/\r\n/g, '\n').replace(/^\s*\n/, '').trimEnd();

/**
 * The full PR body: the project intro, a blank line and the stack note (if any), then CONTEXT_SEPARATOR, then
 * the PR body. Missing parts are left out (no context: just the body; no body: just the context). Composes
 * what's there and nothing else.
 */
export function fullPrBody(p: { intro?: string | null; stackNote?: string | null; body: string }): string {
  const context = [block(p.intro), block(p.stackNote)].filter(Boolean).join('\n\n');
  const body = block(p.body);
  return context && body ? context + CONTEXT_SEPARATOR + body : context || body;
}
