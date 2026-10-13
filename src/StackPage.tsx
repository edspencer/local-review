// `/<project>/<repo>/stacks/<ref>`: one PR stack, laid out like a PR page. Conversation has the project context and
// the stack's note (editable, with images); Comments every thread on the stack's PRs; Stack the picture of just this
// stack. Its PRs aren't listed here:
// the sidebar already shows them, under this stack's title.
import { useEffect, useMemo } from 'react';
import { stackColor, type CommitSummary, type ProjectData, type RepoData, type StackGroup } from './api';
import { Octicon } from './Comments';
import { CommentsTab, openThreads } from './CommentsTab';
import { ContextBoxes, StackNoteText, canHaveNote } from './ProjectText';
import { FollowOnBadge, ReadinessBadge } from './Readiness';
import { Crumbs, stackLabel, stackTally } from './Stacks';
import { StackPicture } from './StackTab';
import { resolveStackRef, stackRef } from '../shared/stackRef';
import { hoverPrefetch, prefetch } from './commitCache';
import { linkTo, navigate, projectUrl, routeUrl, stackUrl, useTilde, type Route } from './util';

// octicon stack-16
export const STACK_ICON = 'M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.251 1.251 0 0 1 0-2.162ZM8.125 1.69a.25.25 0 0 0-.25 0l-4.63 2.685 4.63 2.685a.25.25 0 0 0 .25 0l4.63-2.685ZM1.601 7.789a.75.75 0 0 1 1.025-.273l5.249 3.044a.25.25 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0L1.874 8.814A.75.75 0 0 1 1.6 7.789Zm0 3.5a.75.75 0 0 1 1.025-.273l5.249 3.044a.25.25 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0l-5.248-3.044a.75.75 0 0 1-.273-1.025Z';

export function StackPage({ project, repo, route, version }: { project: ProjectData; repo: RepoData; route: Route; version: string }) {
  const ref = route.stack ?? '';
  const found = resolveStackRef(repo.stacks, ref);
  const tab = route.tab === 'stack' || route.tab === 'comments' ? route.tab : 'conversation';
  // a renamed or reordered stack: follow it to its ref now (the number finds it, the title notices the move)
  useEffect(() => {
    if (found && found.ref !== ref) navigate(stackUrl(project.slug, repo.name, found.ref, tab), true);
  }, [found?.ref, ref, project.slug, repo.name, tab]);
  // every stack with PRs, in sidebar order, for ← / →
  const all = useMemo(() => project.repos.flatMap((r) => r.stacks.filter((g) => g.shas.length).map((g) => ({ repo: r.name, g }))), [project]);
  const title = found ? `${stackLabel(found.group)} · ${project.title}` : project.title;
  useEffect(() => {
    document.title = `${title} · Local Review`;
    return () => { document.title = 'Local Review'; };
  }, [title]);
  const tilde = useTilde();
  // warm up the stack's first PR, where "Start with" goes (as a PR page warms its neighbours)
  const firstPr = found?.group.shas[0] ? repo.commits.find((c) => c.sha === found.group.shas[0])?.short : undefined;
  useEffect(() => {
    if (!firstPr) return;
    const t = setTimeout(() => prefetch({ project: project.slug, repo: repo.name }, firstPr), 120);
    return () => clearTimeout(t);
  }, [project.slug, repo.name, firstPr]);

  if (!found)
    return (
      <div className="page">
        <Crumbs project={project.slug} title={project.title} repo={repo.name} />
        <div className="blankslate">
          <code>{repo.name}</code> has no stack <code>{ref || '(none given)'}</code>. Its stacks are listed in the sidebar; they come from <code>{tilde(project.file)}</code>.{' '}
          <a href={projectUrl(project.slug)} onClick={linkTo(projectUrl(project.slug))}>Open the project page</a>
        </div>
      </div>
    );

  const g = found.group;
  const bySha = new Map(repo.commits.map((c) => [c.sha, c]));
  const commits = g.shas.map((s) => bySha.get(s)).filter((c): c is CommitSummary => !!c);
  const at = all.findIndex((x) => x.repo === repo.name && x.g.index === g.index);
  const go = (t: 'conversation' | 'comments' | 'stack') => navigate(stackUrl(project.slug, repo.name, found.ref, t));
  const to = (x: { repo: string; g: StackGroup } | undefined) => x && navigate(stackUrl(project.slug, x.repo, stackRef(x.g), tab));
  const prev = all[at - 1];
  const next = all[at + 1];

  return (
    <div className="page stack-page" style={{ ['--stack' as string]: stackColor(g.color) }}>
      <Crumbs project={project.slug} title={project.title} repo={repo.name} group={g} />
      <div className="pr-header">
        <div className="pr-title-row">
          <h1 className={`pr-title stack-page-title ${g.implicit === 'unstacked' ? 'is-unstacked' : ''}`}>
            <span className="stack-page-kicker" title={g.implicit === 'unstacked' ? 'Commits before the first declared stack' : g.implicit ? "This repo declares no stacks: one stack, named after the branch" : undefined}>
              <Octicon d={STACK_ICON} size={14} />
              {g.number !== null && !g.implicit && `Stack ${g.number}`}
            </span>
            <span className="stack-page-name">{g.title}</span>
          </h1>
          <div className="pr-nav">
            <button className="btn btn-sm" disabled={!prev} onClick={() => to(prev)} title={prev ? `Previous stack: ${stackLabel(prev.g)}${prev.repo !== repo.name ? ` (${prev.repo})` : ''}` : 'First stack of the project'}>← Prev stack</button>
            <button className="btn btn-sm" disabled={!next} onClick={() => to(next)} title={next ? `Next stack: ${stackLabel(next.g)}${next.repo !== repo.name ? ` (${next.repo})` : ''}` : 'Last stack of the project'}>Next stack →</button>
          </div>
        </div>
        <StackMeta repo={repo} group={g} commits={commits} />
        {g.warning && <div className="flash flash-warn" role="status">⚠ {g.warning}</div>}
      </div>

      <div className="tabnav">
        <button className={`tabnav-tab ${tab === 'conversation' ? 'selected' : ''}`} onClick={() => go('conversation')} title="The stack's note, with the project context above it">
          💬 Conversation
        </button>
        <button className={`tabnav-tab ${tab === 'comments' ? 'selected' : ''}`} onClick={() => go('comments')} title="Every comment thread on this stack's PRs, open ones first">
          🗨 Comments <span className="Counter" title="Open threads">{openThreads(commits)}</span>
        </button>
        <button className={`tabnav-tab ${tab === 'stack' ? 'selected' : ''}`} onClick={() => go('stack')} title="A picture of this stack, to copy or download">
          ▤ Stack
        </button>
        <span className="spacer" />
        {g.weight && (
          <span className="tabnav-extra">
            <span className="color-add">+{g.weight.additions.toLocaleString('en-US')}</span> <span className="color-del">−{g.weight.deletions.toLocaleString('en-US')}</span>
          </span>
        )}
      </div>

      {tab === 'comments' ? (
        <CommentsTab project={project} scope={{ repo, group: g, ref: found.ref }} />
      ) : tab === 'stack' ? (
        commits.length ? (
          <StackPicture
            base={`/api/projects/${encodeURIComponent(project.slug)}/repos/${encodeURIComponent(repo.name)}/stacks/${encodeURIComponent(found.ref)}/stack`}
            version={version}
            alt={`${stackLabel(g)} of ${repo.name}`}
            hint={<code>…/stacks/{found.ref}/stack.png</code>}
          />
        ) : (
          <div className="blankslate">No PRs in this stack, so there's nothing to draw.</div>
        )
      ) : (
        <div className="conversation">
          <div className="timeline">
            <div className="timeline-item project-context-item">
              <span className="avatar-spacer" aria-hidden="true" />
              <ContextBoxes slug={project.slug} intro={project.description} file={project.file} />
            </div>
            <div className="timeline-item">
              <span className="stack-avatar" aria-hidden="true">{g.number !== null && !g.implicit ? g.number : <Octicon d={STACK_ICON} size={18} />}</span>
              {canHaveNote(g) ? (
                <StackNoteText
                  slug={project.slug}
                  repo={repo.name}
                  group={g}
                  file={project.file}
                  frame="comment"
                  label={<><strong>Stack note</strong> <span className="muted">· after the project intro in each of its full PR bodies</span></>}
                />
              ) : (
                <div className="timeline-comment">
                  <div className="comment-header"><strong>{g.title}</strong></div>
                  <div className="timeline-comment-body muted">
                    {g.implicit === 'unstacked'
                      ? <>These commits come before the first declared stack. Only stacks declared under <code>stacks:</code> in <code>{tilde(project.file)}</code> have a note.</>
                      : <>This repo declares no <code>stacks:</code>, so all its commits are one stack, named after the branch. Declare stacks in <code>{tilde(project.file)}</code> to give them notes.</>}
                  </div>
                </div>
              )}
            </div>
            {commits.length > 0 && (
              <div className="timeline-event">
                <span className="timeline-badge">⎇</span>
                <span>
                  {commits.length} PR{commits.length === 1 ? '' : 's'}, #{commits[0].position}
                  {commits.length > 1 && <>–#{commits[commits.length - 1].position}</>} in <strong>{repo.name}</strong> ·{' '}
                  <a href={routeUrl(project.slug, repo.name, commits[0].short)} onClick={linkTo(routeUrl(project.slug, repo.name, commits[0].short), { scroll: false })} {...hoverPrefetch({ project: project.slug, repo: repo.name }, commits[0].short)}>
                    Start with #{commits[0].position} {commits[0].title}
                  </a>
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Under the title: the readiness tally (or Merged), follow-on, the repo and the stack's branches, PRs, files and +/−. */
function StackMeta({ repo, group: g, commits }: { repo: RepoData; group: StackGroup; commits: CommitSummary[] }) {
  const t = stackTally(commits);
  // what the stack sits on: the branch of the commit before it (stacked), else the repo's base; and its top branch
  const first = commits.length ? repo.commits.findIndex((c) => c.sha === commits[0].sha) : -1;
  const below = first > 0 ? repo.commits[first - 1] : null;
  const base = below ? below.branch?.name ?? below.short : repo.startsAfter && repo.after ? repo.after : repo.base ?? repo.from;
  const top = commits[commits.length - 1];
  const head = top ? top.branch?.name ?? top.short : null;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return (
    <div className="pr-meta">
      {t.allMerged ? (
        <span className="State State--merged" title={t.tip}><ReadinessBadge status="merged" size={14} title="" /> Merged</span>
      ) : (
        <span className={`stack-tally-pill ${t.total && t.ready === t.total ? 'is-ready' : ''}`} title={t.tip}>
          <ReadinessBadge status={t.total && t.ready === t.total ? 'ready' : 'draft'} progress={{ resolved: t.ready, threads: t.total, viewed: 0, files: 0 }} size={14} title="" />
          {t.text}
        </span>
      )}
      {g.follow_on && <FollowOnBadge />}
      <span>
        in <strong>{repo.name}</strong>
        {head && (
          <>
            {' '}·{' '}
            <span className="pr-branch">
              {base && <><span className="branch-name is-base" title={below ? 'The branch of the PR below this stack' : "The repo's base in project.yaml"}>{base}</span><span className="pr-branch-arrow" aria-hidden="true">←</span></>}
              <span className="branch-name" title="The branch of the stack's top PR">{head}</span>
            </span>
          </>
        )}
        {' '}· {plural(commits.length, 'PR')}
        {g.weight && <> · {plural(g.weight.files, 'file')} · <span className="color-add">+{g.weight.additions.toLocaleString('en-US')}</span> <span className="color-del">−{g.weight.deletions.toLocaleString('en-US')}</span></>}
        {!t.allMerged && t.merged > 0 && <> · <span className="merged-note">{t.merged} merged</span></>}
      </span>
    </div>
  );
}

