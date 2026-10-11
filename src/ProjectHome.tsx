import { useContext, useEffect } from 'react';
import { hoverPrefetch, prefetch } from './commitCache';
import type { ProjectData, ProjectSummary, RepoData } from './api';
import { ReadinessBadge } from './Readiness';
import type { PrStatus } from '../shared/readiness';
import { IntroText, TotalsLine, repoAggregate } from './ProjectText';
import { repoLabel } from '../shared/repoLabel';
import { mergeAggregates, summary } from '../shared/totals';
import { StackPicture } from './StackTab';
import { LinksContext, linkTo, navigate, projectUrl, routeUrl, useTilde, type Route } from './util';

/**
 * `/<project>`: the project page, laid out like a PR page. Conversation has the project intro (editable, with
 * images); Stack has the picture of every repo and stack (nothing highlighted). Its repos, stacks and PRs aren't
 * listed here: the sidebar already shows them, and each stack's title there opens its page.
 */
export function ProjectHome({ project, route, version, summaries }: { project: ProjectData; route: Route; version: string; summaries?: ProjectSummary[] }) {
  const tab = route.tab === 'stack' ? 'stack' : 'conversation';
  const go = (t: 'conversation' | 'stack') => navigate(projectUrl(project.slug, t));
  // totals leave follow-on stacks out (shared/totals.ts, the same numbers as the picture)
  const total = summary(mergeAggregates(project.repos.map(repoAggregate)), project.repos.length);
  const first = project.repos.flatMap((r) => r.commits.filter((c) => !c.landed).map((c) => ({ repo: r.name, c })))[0];
  const tilde = useTilde();
  // warm up the first PR, where "Start with" goes
  useEffect(() => {
    if (!first) return;
    const t = setTimeout(() => prefetch({ project: project.slug, repo: first.repo }, first.c.short), 120);
    return () => clearTimeout(t);
  }, [project.slug, first?.repo, first?.c.short]);
  useEffect(() => {
    document.title = `${project.title} · Local Review`;
    return () => { document.title = 'Local Review'; };
  }, [project.title]);
  return (
    <div className="page project-home">
      <LinkedBar summaries={summaries} />
      {project.warnings.length > 0 && (
        <div className="flash flash-warn" role="status">{project.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
      )}
      <div className="pr-header">
        <div className="pr-title-row">
          <h1 className="pr-title">
            <span className="project-kicker">Project</span>
            {project.title}
          </h1>
        </div>
        <div className="pr-meta">
          <TotalsLine s={total} />
          <span>· <code className="project-home-file" title={project.file}>{tilde(project.file)}</code></span>
        </div>
      </div>

      <div className="tabnav">
        <button className={`tabnav-tab ${tab === 'conversation' ? 'selected' : ''}`} onClick={() => go('conversation')} title="The project intro: it starts every full PR body">
          💬 Conversation
        </button>
        <button className={`tabnav-tab ${tab === 'stack' ? 'selected' : ''}`} onClick={() => go('stack')} title="A picture of every repo and stack in the project, to copy or download">
          ▤ Stack
        </button>
        <span className="spacer" />
        <span className="tabnav-extra">
          <span className="color-add">+{total.additions.toLocaleString('en-US')}</span> <span className="color-del">−{total.deletions.toLocaleString('en-US')}</span>
        </span>
      </div>

      {tab === 'stack' ? (
        <StackPicture
          base={`/api/projects/${encodeURIComponent(project.slug)}/stack`}
          version={version}
          alt={`PR stacks of ${project.title}`}
          hint={<code>/api/projects/{project.slug}/stack.png</code>}
          allowContext
        />
      ) : (
        <div className="conversation">
          <div className="timeline">
            <div className="timeline-item">
              <span className="stack-avatar is-project" aria-hidden="true">{[...project.title.trim()][0]?.toUpperCase() ?? 'P'}</span>
              <IntroText
                slug={project.slug}
                text={project.description}
                file={project.file}
                frame="comment"
                label={<><strong>Project intro</strong> <span className="muted">· starts every full PR body, before the stack note</span></>}
              />
            </div>
            {first && (
              <div className="timeline-event">
                <span className="timeline-badge">⎇</span>
                <span>
                  {total.counts} ·{' '}
                  <a href={routeUrl(project.slug, first.repo, first.c.short)} onClick={linkTo(routeUrl(project.slug, first.repo, first.c.short), { scroll: false })} {...hoverPrefetch({ project: project.slug, repo: first.repo }, first.c.short)}>
                    Start with #{first.c.position} {first.c.title}
                  </a>
                  {project.repos.length > 1 && <span className="muted"> ({first.repo})</span>}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const TALLY: PrStatus[] = ['draft', 'ready', 'published', 'merged'];

/**
 * Linked projects: "← Builds on <predecessor> (its readiness)" and "<successor> →" above the project page, so you can
 * walk the chain and see whether what this one builds on is ready to go up.
 */
export function LinkedBar({ summaries }: { summaries?: ProjectSummary[] }) {
  const { after, next } = useContext(LinksContext);
  if (!after && !next.length) return null;
  const tally = (slug: string) => {
    const s = summaries?.find((p) => p.slug === slug);
    if (!s) return null;
    return (
      <span className="linked-bar-tally">
        {TALLY.filter((k) => s.readiness[k]).map((k) => (
          <span key={k} title={`${s.readiness[k]} ${k}`}>
            <ReadinessBadge status={k} size={12} title="" />
            {s.readiness[k]}
          </span>
        ))}
      </span>
    );
  };
  return (
    <nav className="linked-bar" aria-label="Linked projects">
      {after ? (
        <a className="linked-bar-prev" href={projectUrl(after.slug)} onClick={linkTo(projectUrl(after.slug))} title="The project this one builds on (project.yaml after:)">
          ← <span className="muted">Builds on</span> <strong>{after.title}</strong> {tally(after.slug)}
        </a>
      ) : (
        <span className="muted">The first of its linked projects</span>
      )}
      <span className="spacer" />
      {next.length ? (
        next.map((n) => (
          <a key={n.slug} className="linked-bar-next" href={projectUrl(n.slug)} onClick={linkTo(projectUrl(n.slug))} title="A project that builds on this one">
            <span className="muted">Next:</span> <strong>{n.title}</strong> {tally(n.slug)} →
          </a>
        ))
      ) : (
        <span className="muted">The last of its linked projects</span>
      )}
    </nav>
  );
}

/** The branch beside a repo's name, or `merged` when nothing's live and its PRs have landed (as in the sidebar). */
export function RepoLabel({ r, end }: { r: RepoData; end?: boolean }) {
  const label = repoLabel(end ? { end: r.end } : r, r.commits.filter((c) => c.landed).length);
  if (!label) return null;
  return label.merged ? <span className="branch-name is-merged" title={MERGED_TIP}>merged</span> : <span className="branch-name">{label.text}</span>;
}
const MERGED_TIP = 'No live range: every PR here has landed';
