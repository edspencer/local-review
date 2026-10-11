// What the sidebar, the stack page and the PR page share about a stack: its label, its readiness tally and the
// link to its page. Here, not in App.tsx, so the pages can import it without importing App.
import { stackColor, type CommitSummary, type StackGroup } from './api';
import { stackRef } from '../shared/stackRef';
import { linkTo, projectUrl, stackUrl, type Route } from './util';

/** "Stack 2 · Groundwork", or the implicit group's own title ("Unstacked", the branch). */
export const stackLabel = (g: StackGroup) => (g.number !== null && !g.implicit ? `Stack ${g.number} · ${g.title}` : g.title);

/** How many of a stack's PRs are at each readiness status, and the line the sidebar and the stack header show. */
export function stackTally(commits: CommitSummary[]) {
  const n = (s: CommitSummary['status']) => commits.filter((c) => c.status === s).length;
  const ready = n('ready') + n('published') + n('merged');
  const tip = [`${n('ready')} ready`, n('published') && `${n('published')} published`, n('merged') && `${n('merged')} merged`, `${n('draft')} draft`].filter(Boolean).join(', ');
  const allMerged = commits.length > 0 && n('merged') === commits.length;
  return { ready, merged: n('merged'), total: commits.length, allMerged, tip, text: allMerged ? `${commits.length}/${commits.length} merged` : `${ready}/${commits.length} ready` };
}

/** A link to a stack's page (keeping the Stack tab if that's where you are). */
export function StackLink({ project, repo, group, tab = 'conversation', className, title, style, children }: { project: string; repo: string; group: StackGroup; tab?: Route['tab']; className?: string; title?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  const url = stackUrl(project, repo, stackRef(group), tab === 'stack' ? 'stack' : 'conversation');
  return (
    <a href={url} className={className} title={title} style={style} onClick={linkTo(url)}>
      {children}
    </a>
  );
}

/**
 * Where a page sits: Project › repo · Stack 2 · Groundwork › PR #3. Each level up is a link; the last one is the page
 * itself. Compact, above the page header (the sidebar shows the same levels, top to bottom).
 */
export function Crumbs({ project, title, repo, group, pr }: { project: string; title: string; repo?: string; group?: StackGroup | null; pr?: number }) {
  const sep = <span className="crumbs-sep" aria-hidden="true">›</span>;
  return (
    <nav className="crumbs" aria-label="Breadcrumbs">
      <a href={projectUrl(project)} onClick={linkTo(projectUrl(project))} title="The project page: its intro and the picture of all its stacks">{title}</a>
      {repo && (
        <>
          {sep}
          <span className="crumbs-repo">{repo}</span>
          {group && (
            <>
              <span className="crumbs-dot" aria-hidden="true">·</span>
              {pr !== undefined ? (
                <StackLink project={project} repo={repo} group={group} className="crumbs-stack" style={{ ['--stack' as string]: stackColor(group.color) }} title="The stack page: its note and its picture">{stackLabel(group)}</StackLink>
              ) : (
                <span className="crumbs-stack" style={{ ['--stack' as string]: stackColor(group.color) }} aria-current="page">{stackLabel(group)}</span>
              )}
            </>
          )}
        </>
      )}
      {pr !== undefined && (
        <>
          {sep}
          <span aria-current="page">PR #{pr}</span>
        </>
      )}
    </nav>
  );
}
