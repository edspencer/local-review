// Linked projects (project.yaml `after: <slug>`): the projects grouped into chains, each in order, the predecessor
// before its successors. Shared by the root page and the project switcher (and tested on its own). No imports: it's
// bundled by Vite and run by tsx.

export interface Linkable {
  slug: string;
  after: string | null; // the predecessor's slug, when the link is valid
}

/**
 * Every project in exactly one group: an unlinked project alone, linked ones together, in chain order (a project
 * whose predecessor isn't in `ps` starts a group). Several successors of one project follow it in the order of `ps`.
 * Groups come in the order of their first member in `ps`.
 */
export function chainGroups<T extends Linkable>(ps: T[]): T[][] {
  const bySlug = new Map(ps.map((p) => [p.slug, p]));
  const next = new Map<string, T[]>();
  for (const p of ps) if (p.after && bySlug.has(p.after) && p.after !== p.slug) next.set(p.after, [...(next.get(p.after) ?? []), p]);
  // the root of each project's group: follow `after` while it's in the list (a cycle can't reach here: the server
  // refuses those links, but stop anyway)
  const rootOf = (p: T) => {
    const seen = new Set<string>();
    let r = p;
    while (r.after && bySlug.has(r.after) && !seen.has(r.slug)) {
      seen.add(r.slug);
      r = bySlug.get(r.after)!;
    }
    return r;
  };
  const groups: T[][] = [];
  const placed = new Set<string>();
  for (const p of ps) {
    const root = rootOf(p);
    if (placed.has(root.slug)) continue;
    const g: T[] = [];
    const walk = (q: T) => {
      if (placed.has(q.slug)) return;
      placed.add(q.slug);
      g.push(q);
      for (const s of next.get(q.slug) ?? []) walk(s);
    };
    walk(root);
    groups.push(g);
  }
  return groups;
}

/**
 * The projects to show (project.yaml `hidden: true` ones left out, but `keep`, the open one, always shown), each
 * with `after` pointing at its nearest shown predecessor, so a chain closes over a hidden project in its middle (a →
 * b, hidden → c: c builds on a) and one whose predecessors are all hidden starts its chain. The links themselves are
 * unchanged on the server: this is only what the lists show. Order is kept.
 */
export function visibleProjects<T extends Linkable & { hidden?: boolean }>(ps: T[], keep?: string | null): T[] {
  const bySlug = new Map(ps.map((p) => [p.slug, p]));
  const shown = (p: T) => !p.hidden || p.slug === keep;
  return ps.filter(shown).map((p) => {
    const seen = new Set<string>([p.slug]);
    let a = p.after ? bySlug.get(p.after) : undefined;
    while (a && !shown(a) && !seen.has(a.slug)) {
      seen.add(a.slug);
      a = a.after ? bySlug.get(a.after) : undefined;
    }
    const after = a && shown(a) && a.slug !== p.slug ? a.slug : null;
    return after === p.after ? p : { ...p, after };
  });
}
