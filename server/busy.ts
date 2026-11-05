// What `/api/busy` answers (cli-contract SPEC §4): the writes under way, which a restart would cut short. Counts only,
// read from memory, so the answer is cheap and needs nothing from the disk.
//
// - `save`: a request that changes something (any POST, PUT, PATCH or DELETE under /api/ but the GitHub refresh):
//   a comment, a reply, a Viewed mark, a PR's title or description, an image, the example projects;
// - `snapshot`: an automatic backup of the projects directory (backups.ts);
// - `sync`: a GitHub fetch writing its cache (github.ts's refresh, from the button, a page coming back or the poll).
//
// Open pages aren't busy: their drafts live in the browser, and they reconnect after a restart. The writes themselves
// are synchronous (safefs.ts), so what can be seen in flight is the request or fetch around them.

export type BusyKind = 'save' | 'snapshot' | 'sync';

const counts: Record<BusyKind, number> = { save: 0, snapshot: 0, sync: 0 };

/** Count `fn` as `kind` of work while it runs (to the end of its promise, if it returns one). */
export function trackBusy<T>(kind: BusyKind, fn: () => T): T {
  counts[kind]++;
  let result: T;
  try {
    result = fn();
  } catch (e) {
    counts[kind]--;
    throw e;
  }
  if (result instanceof Promise) return result.finally(() => counts[kind]--) as T;
  counts[kind]--;
  return result;
}

export function busyCounts(): Record<BusyKind, number> {
  return { ...counts };
}

export function isBusy(): boolean {
  return Object.values(counts).some((n) => n > 0);
}

/** Resolves once nothing is under way, or after `ms` (true if it went quiet). For a clean SIGTERM. */
export async function whenIdle(ms: number, pollMs = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (isBusy()) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}

/** The CLI's words for each kind (busy-client's `Nouns`): `Local Review is busy: 1 save and 1 GitHub sync are running.` */
export const BUSY_NOUNS: Record<BusyKind, [string, string]> = {
  save: ['save', 'saves'],
  snapshot: ['backup snapshot', 'backup snapshots'],
  sync: ['GitHub sync', 'GitHub syncs'],
};
