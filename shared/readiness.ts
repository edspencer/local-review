// A PR's readiness, shared by the UI (badges, toggle, tooltips) and the server (API, `plan`), so both say the same
// thing. No imports: it's bundled by Vite and run by tsx.
//
// Draft → Ready is the reviewer's call, stored as `status:` in prs/<repo>/<sha>.yaml (absent: draft). Published is derived:
// a PR is published once a `github:` record exists, whatever its status says. Merged is derived too, from a `landed:`
// record (written by the agent after the PR merged on GitHub), and wins over everything else.

export type PrStatus = 'draft' | 'ready' | 'published' | 'merged';

/** The stored `status:` field, tolerantly: "ready" / "Ready" / " READY " etc. Anything else (or nothing): none. */
export function storedStatus(v: unknown): 'draft' | 'ready' | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : undefined;
  return s === 'ready' || s === 'draft' ? s : undefined;
}

export function prStatus(o: { status?: 'draft' | 'ready'; github?: unknown; landed?: unknown } | undefined): PrStatus {
  if (o?.landed) return 'merged';
  if (o?.github) return 'published';
  return o?.status === 'ready' ? 'ready' : 'draft';
}

/**
 * Review progress: conversations (threads with at least one comment, outdated ones too, but not those meant for the
 * GitHub PR, which aren't conversations here) and changed files.
 */
export interface Progress {
  threads: number;
  resolved: number;
  files: number;
  viewed: number; // changed files marked Viewed
}

export function progressOf(threads: { resolved?: boolean; publish?: boolean; comments: unknown[] }[], files: string[], viewed: string[]): Progress {
  const real = threads.filter((t) => t.comments.length > 0 && !t.publish);
  const seen = new Set(viewed);
  return { threads: real.length, resolved: real.filter((t) => t.resolved).length, files: files.length, viewed: files.filter((f) => seen.has(f)).length };
}

export const progressDone = (p: Progress) => p.resolved + p.viewed;
export const progressTotal = (p: Progress) => p.threads + p.files;
/** 0..1; a PR with nothing to review (no files, no threads) counts as done. */
export const progressFraction = (p: Progress) => (progressTotal(p) ? progressDone(p) / progressTotal(p) : 1);

/** "6 of 15 done: 6/6 conversations resolved, 0/9 files viewed" */
export function progressText(p: Progress): string {
  return `${progressDone(p)} of ${progressTotal(p)} done: ${p.resolved}/${p.threads} conversation${p.threads === 1 ? '' : 's'} resolved, ${p.viewed}/${p.files} file${p.files === 1 ? '' : 's'} viewed`;
}

export const STATUS_LABEL: Record<PrStatus, string> = { draft: 'Draft', ready: 'Ready', published: 'Published', merged: 'Merged' };

/** The badge's tooltip: "Draft · 6 of 15 done: …", "Ready · …", "Published as #123 · …", "Merged as #123 · …". */
export function statusTooltip(status: PrStatus, p: Progress | null, github?: { number: number } | null): string {
  const head = (status === 'published' || status === 'merged') && github ? `${STATUS_LABEL[status]} as #${github.number}` : STATUS_LABEL[status];
  return p ? `${head} · ${progressText(p)}` : head;
}
