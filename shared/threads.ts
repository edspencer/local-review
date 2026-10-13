// The Comments tab (stack and project pages): every thread across many PRs, in one order. Pure, so the server
// (server/threads.ts) and the UI (src/CommentsTab.tsx) agree, and test/threads.test.ts can check it.

/** What ordering needs of a thread: an api.ts / reviews.ts Thread fits. */
export interface OrderThread {
  id: string;
  resolved: boolean;
  comments: readonly { created?: string | null; edited?: string | null }[];
}

/** One thread and the PR it's on, as the tab lists it. */
export interface ThreadEntryLike<T extends OrderThread = OrderThread> {
  repo: string;
  sha: string;
  thread: T;
}

/** A thread's key across PRs: thread ids are only unique in their own file (`t-auto0` is in many). */
export const entryKey = (e: ThreadEntryLike) => `${e.repo}/${e.sha}/${e.thread.id}`;

/** Where a thread sorts: open or not, and its last update. */
export interface SortKey {
  open: boolean;
  at: number;
}

/**
 * When a thread last changed, in ms: its newest comment or reply, written or edited. 0 when none of them says
 * (comments written by hand without `created:`). Compared as times, so any offset an agent writes works.
 */
export function lastUpdate(t: OrderThread): number {
  let max = 0;
  for (const c of t.comments) for (const at of [c.created, c.edited]) if (typeof at === 'string') max = Math.max(max, Date.parse(at) || 0);
  return max;
}

/** An open thread: unresolved, with something in it (as unresolvedCount counts them, and the tab's counter). */
export const isOpen = (t: OrderThread) => !t.resolved && t.comments.length > 0;

export const sortKey = (t: OrderThread): SortKey => ({ open: isOpen(t), at: lastUpdate(t) });

/**
 * The tab's order: open threads first, then by last update, newest first. Ties (no times, or the same second) keep
 * the order they came in, which is sidebar order (repo, then PR, then thread in its file). `held`: threads (by
 * entryKey) to sort by an earlier key instead of their own, so one you've just resolved or replied to from the tab
 * folds or grows where it is rather than jumping away from under your cursor.
 */
export function orderThreads<E extends ThreadEntryLike>(entries: readonly E[], held?: ReadonlyMap<string, SortKey>): E[] {
  return entries
    .map((e, i) => ({ e, i, k: held?.get(entryKey(e)) ?? sortKey(e.thread) }))
    .sort((a, b) => Number(b.k.open) - Number(a.k.open) || b.k.at - a.k.at || a.i - b.i)
    .map((x) => x.e);
}

/** How many threads are open, for the tab's counter. */
export const openCount = (entries: readonly { thread: OrderThread }[]) => entries.filter((e) => isOpen(e.thread)).length;
