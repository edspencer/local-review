// The label beside a repo's name (sidebar, project homepage, stack picture), shared so they all say the same thing.
// No imports: it's bundled by Vite and run by tsx.

/**
 * The branch being reviewed (or the range's end). A repo with nothing live whose PRs have landed is labelled
 * `merged` (in GitHub's merged purple), not with its base: the base isn't what's under review, and "merged" is what
 * its PRs are (README "Landed PRs"). Null when there's nothing to say.
 */
export function repoLabel(r: { branch?: string | null; end?: string | null }, landed: number): { text: string; merged: boolean } | null {
  const ref = r.branch || r.end;
  if (ref) return { text: ref, merged: false };
  return landed > 0 ? { text: 'merged', merged: true } : null;
}
