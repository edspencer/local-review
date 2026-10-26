// `pr_model: follow-ups` (project.yaml, per repo): commits added on top of a published PR's branch, to address review
// feedback without rewriting it, belong to that PR instead of being PRs of their own. Read-only and keyed on
// branches: a live PR whose recorded branch has moved to a later commit of the range, one that descends from it,
// takes in the commits between (`members`), and its diff runs from its root's parent to the branch head (`tip`), as a
// landed PR's does. Its prs and review files stay keyed by the root commit's sha.
import { changedFiles, isAncestor, revList, type CommitSummary } from './commits.js';
import { lookupBranch, type RefIndex } from './branches.js';
import type { LoadedPr } from './prs.js';

/**
 * The range's commits with each PR's follow-ups folded into it. Nothing is folded across a commit that is a PR of its
 * own (one with a recorded branch or a GitHub PR), or when the branch head doesn't descend from the PR's commit: those
 * branches show as `moved`, as without `pr_model`.
 */
export async function foldFollowUps(repo: string, commits: CommitSummary[], prs: Map<string, LoadedPr>, refs: RefIndex): Promise<CommitSummary[]> {
  const at = new Map(commits.map((c, i) => [c.sha, i]));
  const ownPr = (sha: string) => {
    const o = prs.get(sha)?.override;
    return !!(o?.branch || o?.github);
  };
  const taken = new Set<string>();
  const out: CommitSummary[] = [];
  for (const [i, c] of commits.entries()) {
    if (taken.has(c.sha)) continue;
    const o = prs.get(c.sha)?.override;
    const name = o?.github?.branch ?? o?.branch;
    const head = !c.landed && name ? lookupBranch(refs, name)?.sha : undefined;
    if (!head || !((at.get(head) ?? -1) > i) || !(await isAncestor(repo, c.sha, head))) {
      out.push(c);
      continue;
    }
    // c..head, oldest first: in a linear range, the commits between this one and the branch head
    const follow = (await revList(repo, c.sha, head)).map((s) => commits[at.get(s) ?? -1]);
    if (follow.some((f) => !f || f.landed || taken.has(f.sha) || ownPr(f.sha))) {
      out.push(c);
      continue;
    }
    for (const f of follow) taken.add(f.sha);
    const files = await changedFiles(repo, head, c.parent);
    out.push({
      ...c,
      tip: head,
      additions: files.reduce((a, f) => a + f.additions, 0),
      deletions: files.reduce((a, f) => a + f.deletions, 0),
      filesChanged: files.length,
      members: [c, ...follow].map((m) => ({ sha: m.sha, short: m.short, subject: m.subject, author: m.author, date: m.date, additions: m.additions, deletions: m.deletions })),
    });
  }
  return out;
}
