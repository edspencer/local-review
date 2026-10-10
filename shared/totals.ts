// Aggregate diff stats over PR stacks, shared by the stack picture (server/stackviz.ts) and the UI (sidebar, project
// homepage, project menu), so they always agree. No imports: it's bundled by Vite and run by tsx.
//
// Follow-on stacks (project.yaml `follow_on: true`, parked work) never count toward an aggregate: the stack, PR and
// +/− totals are of the regular stacks only, and the follow-on ones are mentioned beside them ("+1 follow-on stack
// (2 PRs)"). A follow-on stack's own header and its PRs still show their real numbers.

export interface StackStat {
  follow_on?: boolean;
  prs: number;
  additions: number;
  deletions: number;
}

export interface Aggregate {
  stacks: number; // regular stacks (Unstacked included), with at least one PR
  prs: number;
  additions: number;
  deletions: number;
  followOn: { stacks: number; prs: number; additions: number; deletions: number };
}

/** Totals over `stacks`, with follow-on stacks left out of the main numbers and counted on the side. Empty stacks are skipped. */
export function aggregate(stacks: StackStat[]): Aggregate {
  const a: Aggregate = { stacks: 0, prs: 0, additions: 0, deletions: 0, followOn: { stacks: 0, prs: 0, additions: 0, deletions: 0 } };
  for (const s of stacks) {
    if (!s.prs) continue;
    const t = s.follow_on ? a.followOn : a;
    t.stacks++;
    t.prs += s.prs;
    t.additions += s.additions;
    t.deletions += s.deletions;
  }
  return a;
}

/** Several aggregates as one (a project's, from its repos'). */
export function mergeAggregates(as: Aggregate[]): Aggregate {
  const sum = <T extends { stacks: number; prs: number; additions: number; deletions: number }>(x: T, y: T) => ({ stacks: x.stacks + y.stacks, prs: x.prs + y.prs, additions: x.additions + y.additions, deletions: x.deletions + y.deletions });
  return as.reduce((a, b) => ({ ...sum(a, b), followOn: sum(a.followOn, b.followOn) }), aggregate([]));
}

export const num = (n: number) => n.toLocaleString('en-US');
export const plural = (n: number, w: string) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;

/** "+1 follow-on stack (2 PRs)", or null when there are none. */
export function followOnNote(a: Aggregate): string | null {
  const f = a.followOn;
  return f.stacks ? `+${plural(f.stacks, 'follow-on stack')} (${plural(f.prs, 'PR')})` : null;
}

export interface Summary {
  counts: string; // "2 repos · 4 stacks · 12 PRs" (project) or "12 PRs" (repo)
  additions: number;
  deletions: number;
  note: string | null; // "+1 follow-on stack (2 PRs)"
}

/**
 * The text of an aggregate header: the project's ("2 repos · 4 stacks · 12 PRs", pass `repos`) or a repo's ("12 PRs").
 * When there is nothing but follow-on work (e.g. a picture of just a follow-on stack), its own numbers are shown
 * instead, labelled as such ("1 follow-on stack · 2 PRs"), rather than a row of zeros.
 */
export function summary(a: Aggregate, repos?: number): Summary {
  const only = !a.prs && a.followOn.prs > 0;
  const t = only ? a.followOn : a;
  const parts = [
    repos !== undefined && plural(repos, 'repo'),
    repos !== undefined && plural(t.stacks, only ? 'follow-on stack' : 'stack'),
    `${plural(t.prs, only && repos === undefined ? 'follow-on PR' : 'PR')}`,
  ].filter((x): x is string => !!x);
  return { counts: parts.join(' · '), additions: t.additions, deletions: t.deletions, note: only ? null : followOnNote(a) };
}
