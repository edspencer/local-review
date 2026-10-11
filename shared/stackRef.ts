// How a stack is named in a URL (the stack page, `/<project>/<repo>/stacks/<ref>`, and its picture route): the
// stack's 1-based number in project.yaml `stacks:` and a slug of its title, `2-groundwork`, like the stack-note PUT
// takes a number and the title it expects. The number finds it; the slug notices a reordered or renamed list. The
// two implicit groups, which have no number, are `unstacked` and `branch`. No imports: bundled by Vite, run by tsx.

/** The part of a stack identity a ref is made from (a StackGroup, client or server). */
export interface StackIdentity {
  number: number | null;
  title: string;
  implicit?: 'unstacked' | 'branch';
}

/** A title as it appears in a ref: lower case, ASCII letters and digits, dashes between words. */
export function titleSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/** The ref of a stack: `2-groundwork` (just `2` if the title has no letters or digits), `unstacked` or `branch`. */
export function stackRef(g: StackIdentity): string {
  if (g.implicit || g.number === null) return g.implicit ?? 'unstacked';
  const s = titleSlug(g.title);
  return s ? `${g.number}-${s}` : String(g.number);
}

/** A ref taken apart: a number and maybe a slug, or an implicit group's name. null: not a ref at all. */
export function parseStackRef(ref: string): { number: number; slug: string | null } | { implicit: 'unstacked' | 'branch' } | null {
  if (ref === 'unstacked' || ref === 'branch') return { implicit: ref };
  const m = /^([1-9][0-9]{0,3})(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/.exec(ref);
  return m ? { number: Number(m[1]), slug: m[2] ?? null } : null;
}

/**
 * The stack a ref names, among a repo's stacks, and its ref now. `exact`: the number and the slug both match (or the
 * ref had no slug); `moved`: the list was reordered, so another number has that title now; `renamed`: nothing has
 * that title any more, so it's the stack at that number. null: no such stack.
 */
export function resolveStackRef<G extends StackIdentity>(stacks: G[], ref: string): { group: G; ref: string; how: 'exact' | 'moved' | 'renamed' } | null {
  const p = parseStackRef(ref);
  if (!p) return null;
  const found = (group: G, how: 'exact' | 'moved' | 'renamed') => ({ group, ref: stackRef(group), how });
  if ('implicit' in p) {
    const g = stacks.find((x) => x.implicit === p.implicit);
    return g ? found(g, 'exact') : null;
  }
  const declared = stacks.filter((x) => x.number !== null && !x.implicit);
  const at = declared.find((x) => x.number === p.number);
  if (p.slug === null || (at && titleSlug(at.title) === p.slug)) return at ? found(at, 'exact') : null;
  const moved = declared.find((x) => titleSlug(x.title) === p.slug);
  if (moved) return found(moved, 'moved');
  return at ? found(at, 'renamed') : null;
}
