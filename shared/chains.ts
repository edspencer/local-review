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
