import { Fragment } from 'react';
import { stackColor, type ProjectData, type RepoData, type StackGroup } from './api';
import { FOLLOW_ON_TIP, FollowOnBadge, ReadinessBadge } from './Readiness';
import { IntroText, StackNoteText, StackWeight, TotalsLine, canHaveNote, repoAggregate } from './ProjectText';
import { repoLabel } from '../shared/repoLabel';
import { mergeAggregates, summary } from '../shared/totals';
import { ImageActions, useCopyImage } from './StackTab';
import { navigate, routeUrl } from './util';

// as in the sidebar (App's stackLabel; not imported from App, which imports this file)
const stackLabel = (g: StackGroup) => (g.number !== null && !g.implicit ? `Stack ${g.number} · ${g.title}` : g.title);

/** `/<project>`: the stack picture of the whole project (nothing highlighted) and links to every PR. */
export function ProjectHome({ project, version }: { project: ProjectData; version: string }) {
  const base = `/api/projects/${encodeURIComponent(project.slug)}/stack`;
  const { copy, copyError, copyImage } = useCopyImage(`${base}.png`);
  const go = (repo: string, short: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(routeUrl(project.slug, repo, short));
    window.scrollTo(0, 0);
  };
  // totals leave follow-on stacks out (shared/totals.ts, the same numbers as the picture)
  const aggs = new Map(project.repos.map((r) => [r.name, repoAggregate(r)]));
  return (
    <div className="page project-home">
      <div className="pr-header">
        <h1 className="pr-title">{project.title}</h1>
        <IntroText
          slug={project.slug}
          text={project.description}
          file={project.file}
          className="project-home-intro"
          label={<>Project intro <span className="muted ptext-sub">· starts every full PR body</span></>}
        />
      </div>
      <div className="project-home-body">
        <section>
          <div className="stack-tab-toolbar">
            <h2 className="project-home-h2">PR stacks</h2>
            <span className="spacer" />
            <ImageActions base={base} q="" copy={copy} onCopy={copyImage} />
          </div>
          {copy === 'error' && <div className="flash flash-error" role="alert">Couldn't copy the image: {copyError}. Use Download PNG instead.</div>}
          <div className="stack-tab-canvas">
            <img src={`${base}.png?v=${encodeURIComponent(version)}`} width={680} alt={`PR stacks of ${project.title}`} />
          </div>
        </section>
        <section className="project-home-list">
          <h2 className="project-home-h2">Repos</h2>
          <TotalsLine s={summary(mergeAggregates([...aggs.values()]), project.repos.length)} className="project-home-totals" />
          {project.repos.map((r) => (
            <div key={r.name} className="project-home-repo">
              <h3>
                {r.name} <RepoLabel r={r} />
                {r.commits.length > 0 && <TotalsLine s={summary(aggs.get(r.name)!)} />}
              </h3>
              {r.error && <div className="flash flash-error">{r.error}</div>}
              {r.stacks.filter((g) => g.shas.length).map((g, i, shown) => (
                <Fragment key={g.index}>
                  {g.follow_on && !shown[i - 1]?.follow_on && (
                    <div className="follow-on-divider" role="separator" title={FOLLOW_ON_TIP}>Follow-on · held back</div>
                  )}
                  <div className={`project-home-stack ${g.follow_on ? 'follow-on' : ''}`} style={{ ['--stack' as string]: stackColor(g.color) }}>
                    <div className="project-home-stack-head">
                      <span className="project-home-stack-title">{stackLabel(g)}</span>
                      {g.follow_on && <FollowOnBadge />}
                      {g.weight && <StackWeight w={g.weight} />}
                    </div>
                    {canHaveNote(g) && <StackNoteText slug={project.slug} repo={r.name} group={g} file={project.file} className="project-home-note" />}
                    <ol>
                      {g.shas.map((s) => r.commits.find((c) => c.sha === s)).filter((c) => !!c).map((c) => (
                        <li key={c.sha}>
                          <a href={routeUrl(project.slug, r.name, c.short)} onClick={go(r.name, c.short)}>
                            <span className="commit-num">{c.position}</span> {c.title} <ReadinessBadge status={c.status} progress={c.progress} github={c.github} size={14} />
                          </a>
                        </li>
                      ))}
                    </ol>
                  </div>
                </Fragment>
              ))}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/** The branch beside a repo's name, or `merged` when nothing's live and its PRs have landed (as in the sidebar). */
export function RepoLabel({ r, end }: { r: RepoData; end?: boolean }) {
  const label = repoLabel(end ? { end: r.end } : r, r.commits.filter((c) => c.landed).length);
  if (!label) return null;
  return label.merged ? <span className="branch-name is-merged" title={MERGED_TIP}>merged</span> : <span className="branch-name">{label.text}</span>;
}
const MERGED_TIP = 'No live range: every PR here has landed';
