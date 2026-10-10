// Aggregate diff stats over PR stacks, shared by the stack picture (server/stackviz.ts) and the UI (sidebar, project
// homepage, project menu), so they always agree. No imports: it's bundled by Vite and run by tsx.
//
// Follow-on stacks (project.yaml `follow_on: true`, parked work) never count toward an aggregate: the stack, PR and
// +/− totals are of the regular stacks only, and the follow-on ones are mentioned beside them ("+1 follow-on stack
// (2 PRs)"). A follow-on stack's own header and its PRs still show their real numbers.
//
// Merged PRs (landed on GitHub: prs/ `landed:`) are counted on the side too ("+9 merged"), whichever stack they're in.
// A stack whose PRs have all merged isn't counted among the stacks; when there's nothing but merged work (an archived
// project), its own numbers are shown, labelled ("1 stack · 9 merged PRs").

export interface Tally {
  prs: number;
  additions: number;
  deletions: number;
}

export interface StackStat extends Tally {
  follow_on?: boolean;
  merged?: Tally; // the part of prs / additions / deletions that has merged
}

export interface Aggregate extends Tally {
  stacks: number; // regular stacks (Unstacked included), with at least one unmerged PR
  followOn: Tally & { stacks: number };
  merged: Tally & { stacks: number }; // stacks: those whose PRs have all merged
}

const zero = () => ({ stacks: 0, prs: 0, additions: 0, deletions: 0 });

/**
 * Totals over `stacks`: merged PRs, and then follow-on stacks, are left out of the main numbers and counted on the
 * side. Empty stacks are skipped.
 */
export function aggregate(stacks: StackStat[]): Aggregate {
  const a: Aggregate = { ...zero(), followOn: zero(), merged: zero() };
  for (const s of stacks) {
    if (!s.prs) continue;
    const m = s.merged ?? { prs: 0, additions: 0, deletions: 0 };
    a.merged.prs += m.prs;
    a.merged.additions += m.additions;
    a.merged.deletions += m.deletions;
    const prs = s.prs - m.prs;
    if (prs <= 0) {
      a.merged.stacks++;
      continue;
    }
    const t = s.follow_on ? a.followOn : a;
    t.stacks++;
    t.prs += prs;
    t.additions += s.additions - m.additions;
    t.deletions += s.deletions - m.deletions;
  }
  return a;
}

/** Several aggregates as one (a project's, from its repos'). */
export function mergeAggregates(as: Aggregate[]): Aggregate {
  const sum = <T extends { stacks: number; prs: number; additions: number; deletions: number }>(x: T, y: T) => ({ stacks: x.stacks + y.stacks, prs: x.prs + y.prs, additions: x.additions + y.additions, deletions: x.deletions + y.deletions });
  return as.reduce((a, b) => ({ ...sum(a, b), followOn: sum(a.followOn, b.followOn), merged: sum(a.merged, b.merged) }), aggregate([]));
}

export const num = (n: number) => n.toLocaleString('en-US');
export const plural = (n: number, w: string) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;

/** "+1 follow-on stack (2 PRs)", or null when there are none. */
export function followOnNote(a: Aggregate): string | null {
  const f = a.followOn;
  return f.stacks ? `+${plural(f.stacks, 'follow-on stack')} (${plural(f.prs, 'PR')})` : null;
}

/** "+9 merged", or null when there are none. */
export function mergedNote(a: Aggregate): string | null {
  return a.merged.prs ? `+${num(a.merged.prs)} merged` : null;
}

export interface Summary {
  counts: string; // "2 repos · 4 stacks · 12 PRs" (project) or "12 PRs" (repo)
  additions: number;
  deletions: number;
  note: string | null; // "+1 follow-on stack (2 PRs)"
  merged: string | null; // "+9 merged"
}

/**
 * The text of an aggregate header: the project's ("2 repos · 4 stacks · 12 PRs", pass `repos`) or a repo's ("12 PRs").
 * When there is nothing but follow-on work (e.g. a picture of just a follow-on stack), its own numbers are shown
 * instead, labelled as such ("1 follow-on stack · 2 PRs"), rather than a row of zeros; likewise when there's nothing
 * but merged work ("1 stack · 9 merged PRs").
 */
export function summary(a: Aggregate, repos?: number): Summary {
  const onlyMerged = !a.prs && !a.followOn.prs && a.merged.prs > 0;
  if (onlyMerged) {
    const m = a.merged;
    const parts = [repos !== undefined && plural(repos, 'repo'), repos !== undefined && plural(m.stacks, 'stack'), plural(m.prs, 'merged PR')].filter((x): x is string => !!x);
    return { counts: parts.join(' · '), additions: m.additions, deletions: m.deletions, note: null, merged: null };
  }
  const only = !a.prs && a.followOn.prs > 0;
  const t = only ? a.followOn : a;
  const parts = [
    repos !== undefined && plural(repos, 'repo'),
    repos !== undefined && plural(t.stacks, only ? 'follow-on stack' : 'stack'),
    `${plural(t.prs, only && repos === undefined ? 'follow-on PR' : 'PR')}`,
  ].filter((x): x is string => !!x);
  return { counts: parts.join(' · '), additions: t.additions, deletions: t.deletions, note: only ? null : followOnNote(a), merged: mergedNote(a) };
}
