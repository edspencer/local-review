import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, stackColor, type CommitSummary, type ProjectData, type ProjectSummary, type ProjectsResponse, type RepoData, type ServerEvent, type StackGroup } from './api';
import { BranchStatusMarker, MiddleTruncate, PrBadge, branchNote } from './Branch';
import { CommitPage } from './CommitPage';
import { ProjectHome, RepoLabel } from './ProjectHome';
import { FOLLOW_ON_TIP, FollowOnBadge, ReadinessBadge } from './Readiness';
import { TextDraftsProvider, repoAggregate } from './ProjectText';
import { ExamplesMenuItem, ExamplesStrip, Welcome } from './Welcome';
import { tildify } from '../shared/paths';
import { HomeContext, ProjectContext, hashString, isTyping, navigate, relativeTime, routeUrl, useLocalStorage, useRoute, useTick, useTilde, type Route } from './util';

const mostRecent = (l: ProjectsResponse | null) => (l?.projects ?? []).slice().sort((a, b) => b.modified.localeCompare(a.modified))[0] ?? null;

export function App() {
  const route = useRoute();
  const [list, setList] = useState<ProjectsResponse | null>(null);
  const [project, setProject] = useState<ProjectData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useLocalStorage('lr.sidebarOpen', true);
  const [reviewBump, setReviewBump] = useState<Map<string, number>>(new Map());
  const [live, setLive] = useState(false);
  const [closedRepos, setClosedRepos] = useLocalStorage<string[]>('lr.closedRepos', []);
  const [notice, setNotice] = useState<string | null>(null);
  useTick();

  const isProject = (slug: string | null) => !!slug && !!list?.projects.some((p) => p.slug === slug);
  // the project on screen: the one in the URL, or (at `/`) the most recently modified one
  const activeSlug = list ? (isProject(route.project) ? route.project : route.parts.length === 0 ? mostRecent(list)?.slug ?? null : null) : null;

  const refreshList = useCallback(
    () => api.projects().then((l) => { setList(l); setLoadError(null); }).catch((e) => setLoadError((e as Error).message)),
    [],
  );
  useEffect(() => { refreshList(); }, [refreshList]);

  const slugRef = useRef(activeSlug);
  slugRef.current = activeSlug;
  const refreshProject = useCallback(() => {
    const slug = slugRef.current;
    if (!slug) return;
    api.project(slug).then((p) => { if (slugRef.current === p.slug) { setProject(p); setLoadError(null); } }).catch((e) => setLoadError((e as Error).message));
  }, []);
  useEffect(() => {
    if (project?.slug !== activeSlug) setProject(null);
    refreshProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlug, refreshProject]);
  const refreshAll = useCallback(() => { refreshList(); refreshProject(); }, [refreshList, refreshProject]);

  // Server-sent events: review / PR files changed on disk, branch heads moved, project.yaml edited.
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => { clearTimeout(timer); timer = setTimeout(refreshAll, 200); };
    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('hello', () => setLive(true));
      es.addEventListener('change', (m) => {
        const e = JSON.parse((m as MessageEvent).data) as ServerEvent;
        if (e.type === 'review' || e.type === 'pr') {
          const k = `${e.type}:${e.project}:${e.repo}:${e.sha}`;
          setReviewBump((b) => new Map(b).set(k, (b.get(k) ?? 0) + 1));
        }
        refreshSoon();
      });
      es.onerror = () => {
        setLive(false);
        es?.close();
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => { es?.close(); clearTimeout(retry); clearTimeout(timer); };
  }, [refreshAll]);

  // every commit of the project in sidebar order, for j/k, prev/next and redirects
  const flat = useMemo(() => (project?.repos ?? []).flatMap((r) => r.commits.map((c) => ({ repo: r.name, sha: c.sha }))), [project]);

  // redirects: `/` and `/<project>/<repo>` to a first commit; old `/<repo>/<sha>` URLs into their project
  useEffect(() => {
    if (!list) return;
    const parts = route.parts;
    if (parts.length && !isProject(parts[0])) {
      const owner = list.projects.slice().sort((a, b) => b.modified.localeCompare(a.modified)).find((p) => p.repos.includes(parts[0]));
      if (owner) navigate(`/${encodeURIComponent(owner.slug)}/${parts.map(encodeURIComponent).join('/')}${window.location.search}`, true);
      return;
    }
    // `/<project>` alone is the project's homepage
    if (route.sha || parts.length === 1 || !project || project.slug !== activeSlug) return;
    const first = route.repo ? flat.find((x) => x.repo === route.repo) : flat[0];
    if (first) navigate(routeUrl(project.slug, first.repo, first.sha.slice(0, 8), route.tab), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, project, route, flat, activeSlug]);

  const routeRef = useRef(route);
  routeRef.current = route;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const r = routeRef.current;
      if (!project) return;
      const i = flat.findIndex((x) => x.repo === r.repo && r.sha && x.sha.startsWith(r.sha.toLowerCase()));
      const j = e.key === 'j' ? i + 1 : i - 1;
      if (i >= 0 && j >= 0 && j < flat.length) {
        e.preventDefault();
        navigate(routeUrl(project.slug, flat[j].repo, flat[j].sha.slice(0, 8), r.tab));
        window.scrollTo(0, 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, project]);

  const unknownProject = list && route.parts.length > 0 && !isProject(route.parts[0]) && !list.projects.some((p) => p.repos.includes(route.parts[0]));
  const repoData = project?.repos.find((r) => r.name === route.repo);
  const onCommit = project && route.project === project.slug && route.repo && route.sha;
  // changes whenever anything the stack picture shows does (titles, stacks, commits), to refetch it
  const vizVersion = useMemo(
    () => (project ? hashString(JSON.stringify([project.title, project.repos.map((r) => [r.name, r.branch, r.error, r.stacks, r.commits.map((c) => [c.sha, c.title, c.branch?.name, c.branch?.status, c.github?.number, c.status])])])) : ''),
    [project],
  );

  const tilde = (s: string) => tildify(s, list?.home);
  const isExample = !!list?.projects.find((p) => p.slug === activeSlug)?.example;
  const exampleCount = list?.projects.filter((p) => p.example).length ?? 0;
  const examplesAdded = (slug: string) => {
    setNotice(null);
    refreshList().then(() => navigate(slug ? `/${encodeURIComponent(slug)}` : '/'));
  };
  // the list first, then `/`: with the old list, `/` would redirect straight back into a removed example
  const examplesRemoved = () => {
    // the notice is for the welcome page, where you land if the examples were all you had
    if (list?.projects.every((p) => p.example)) setNotice('The example projects are removed. Nothing was deleted: you can bring them back from here any time.');
    if (!isExample) return void refreshList(); // you're on a project of your own: stay there
    setProject(null);
    refreshList().then(() => navigate('/'));
  };

  return (
    <HomeContext.Provider value={list?.home ?? null}>
    <div className="app">
      <header className="app-header">
        <button className="header-btn" onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle sidebar">☰</button>
        <a className="wordmark" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
          LOCAL REVIEW
        </a>
        <span className="not-github-pill">not on GitHub</span>
        {list && (project || activeSlug) && <ProjectSwitcher list={list} current={project?.slug ?? activeSlug!} title={project?.title ?? list.projects.find((p) => p.slug === activeSlug)?.title ?? ''} onExamplesAdded={examplesAdded} onExamplesRemoved={examplesRemoved} />}
        <span className="header-crumbs">{route.repo && route.sha && <>{route.repo} / <code>{route.sha.slice(0, 8)}</code></>}</span>
        <span className="spacer" />
        <span className={`live-dot ${live ? 'on' : ''}`} title={live ? 'Live: watching project files and branches' : 'Disconnected, retrying…'}>{live ? '● live' : '○ offline'}</span>
        <span className="header-hint" title="Keyboard shortcuts">j / k: next / prev commit · n / p: next / prev file</span>
      </header>
      <div className="app-body">
        {sidebarOpen && (
          <aside className="sidebar">
            {isExample && <ExamplesStrip count={exampleCount} onRemoved={examplesRemoved} />}
            {loadError && <div className="flash flash-error">{tilde(loadError)}</div>}
            {project?.error && <div className="flash flash-error">{tilde(project.error)}</div>}
            {!project && !loadError && list && list.projects.length > 0 && <div className="loading">Loading project…</div>}
            {list && list.projects.length === 0 && (
              <div className="sidebar-empty">No projects yet.</div>
            )}
            {project && project.repos.length === 0 && !project.error && <div className="sidebar-empty">No repos in <code>{tilde(project.file)}</code>.</div>}
            {project?.repos.map((r) => (
              <RepoSection
                key={r.name}
                project={project}
                repo={r}
                route={route}
                closed={closedRepos.includes(`${project.slug}/${r.name}`) && route.repo !== r.name}
                toggle={() => {
                  const k = `${project.slug}/${r.name}`;
                  setClosedRepos(closedRepos.includes(k) ? closedRepos.filter((n) => n !== k) : [...closedRepos, k]);
                }}
              />
            ))}
          </aside>
        )}
        <main className="main">
          <ProjectContext.Provider value={project?.slug ?? null}>
          <TextDraftsProvider refresh={refreshAll}>
          {onCommit ? (
            <CommitPage
              key={`${project.slug}/${route.repo}`}
              route={route}
              loc={{ project: project.slug, repo: route.repo! }}
              projectTitle={project.title}
              projectIntro={project.description}
              projectFile={project.file}
              reviewBump={reviewBump}
              onChanged={refreshAll}
              repoData={repoData}
              vizVersion={vizVersion}
            />
          ) : project && route.project === project.slug && route.parts.length === 1 ? (
            <ProjectHome project={project} version={vizVersion} />
          ) : unknownProject ? (
            <div className="page blankslate">
              No project or repo named <code>{route.parts[0]}</code>.{' '}
              <button className="btn-link" onClick={() => navigate('/')}>Open the latest project</button>
            </div>
          ) : list && list.projects.length === 0 ? (
            <Welcome list={list} notice={notice} onChanged={() => { setNotice(null); return refreshList(); }} />
          ) : project && flat.length === 0 ? (
            <div className="page blankslate">No commits to review in <strong>{project.title}</strong>. Check <code>{tilde(project.file)}</code>.</div>
          ) : (
            <div className="page loading">Loading…</div>
          )}
          </TextDraftsProvider>
          </ProjectContext.Provider>
        </main>
      </div>
    </div>
    </HomeContext.Provider>
  );
}

function ProjectSwitcher({ list, current, title, onExamplesAdded, onExamplesRemoved }: { list: ProjectsResponse; current: string; title: string; onExamplesAdded: (slug: string) => void; onExamplesRemoved: () => void }) {
  const [open, setOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useLocalStorage('lr.archivedOpen', false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  // a plain link when there's nothing to switch to; but the menu also offers the example projects, so it's a menu
  // whenever they aren't there yet
  if (list.projects.length < 2 && list.examples === 'present')
    return (
      <a className="header-project" href={`/${encodeURIComponent(current)}`} title={`Project: ${current} (overview)`} onClick={(e) => { e.preventDefault(); navigate(`/${encodeURIComponent(current)}`); }}>
        {title}
      </a>
    );
  const sorted = list.projects.slice().sort((a, b) => b.modified.localeCompare(a.modified));
  // archived projects (everything landed) go in their own section, collapsed unless the open one is archived
  const active = sorted.filter((p) => !p.archived);
  const archived = sorted.filter((p) => p.archived);
  const showArchived = archivedOpen || archived.some((p) => p.slug === current);
  const item = (p: ProjectSummary) => (
    <li key={p.slug}>
      <a
        href={`/${encodeURIComponent(p.slug)}`}
        role="option"
        aria-selected={p.slug === current}
        className={`${p.slug === current ? 'current' : ''} ${p.archived ? 'is-archived' : ''}`}
        onClick={(e) => { e.preventDefault(); setOpen(false); navigate(`/${encodeURIComponent(p.slug)}`); }}
      >
        <span className="project-menu-title">{p.title}{p.example && <span className="example-tag">Example</span>}</span>
        <span className="project-menu-meta">
          {p.repoCount} repo{p.repoCount === 1 ? '' : 's'} · {p.archived ? <span className="merged-note">{p.mergedCount} merged</span> : <>{p.commitCount} commit{p.commitCount === 1 ? '' : 's'}</>}
          {p.followOnCount > 0 && <span className="follow-on-note"> +{p.followOnCount} follow-on</span>}
          {!p.archived && p.mergedCount > 0 && <span className="merged-note"> +{p.mergedCount} merged</span>}
          {p.unresolved > 0 && <> · <span className="attn">{p.unresolved} open</span></>} · {relativeTime(p.modified)}
        </span>
      </a>
    </li>
  );
  return (
    <div className="project-switcher" ref={ref}>
      <button className="header-project is-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} title="Switch project">
        {title} <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="project-menu" role="listbox">
          {active.map(item)}
          {archived.length > 0 && (
            <li className="project-menu-section" role="presentation">
              <button type="button" className="project-menu-section-toggle" aria-expanded={showArchived} onClick={() => setArchivedOpen(!archivedOpen)} title="Projects whose PRs have all merged (every repo has landed PRs and nothing live)">
                <svg className="octicon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d={showArchived ? CHEV_DOWN : CHEV_RIGHT} /></svg>
                Archived <span className="Counter">{archived.length}</span>
              </button>
            </li>
          )}
          {showArchived && archived.map(item)}
          <ExamplesMenuItem list={list} onAdded={(slug) => { setOpen(false); onExamplesAdded(slug); }} onRemoved={() => { setOpen(false); onExamplesRemoved(); }} />
        </ul>
      )}
    </div>
  );
}

const CHEV_RIGHT = 'M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z';
const CHEV_DOWN = 'M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z';

export const stackLabel = (g: StackGroup) => (g.number !== null && !g.implicit ? `Stack ${g.number} · ${g.title}` : g.title);

function RepoSection({ project, repo: r, route, closed, toggle }: { project: ProjectData; repo: RepoData; route: Route; closed: boolean; toggle: () => void }) {
  const open = r.commits.reduce((a, c) => a + c.unresolved, 0);
  // the viewed count leaves follow-on stacks out (like every aggregate, shared/totals.ts) and mentions them beside it;
  // merged PRs are history, so they're left out too (and the count is hidden when nothing else is left)
  const parked = new Set(r.stacks.filter((g) => g.follow_on).flatMap((g) => g.shas));
  const fullyViewed = (c: CommitSummary) => c.filesChanged > 0 && c.viewedCount >= c.filesChanged;
  const main = r.commits.filter((c) => !parked.has(c.sha) && !c.landed);
  const merged = r.commits.filter((c) => c.landed).length;
  const done = main.filter(fullyViewed).length;
  const fo = repoAggregate(r).followOn;
  const foDone = r.commits.filter((c) => parked.has(c.sha) && !c.landed && fullyViewed(c)).length;
  const bySha = new Map(r.commits.map((c) => [c.sha, c]));
  const tilde = useTilde();
  return (
    <section className={`repo ${closed ? 'closed' : ''} ${r.error ? 'has-error' : ''}`}>
      <button
        className="repo-heading"
        title={`${tilde(r.path)}\nrange end: ${r.end || '(none: all landed)'}\n${r.from ? `from: ${r.from}` : `base: ${r.base ?? '?'}`}${merged ? `\n${merged} landed (merged) PR${merged === 1 ? '' : 's'}` : ''}${closed ? '\n(click to expand)' : ''}`}
        aria-expanded={!closed}
        onClick={toggle}
      >
        <svg className="octicon repo-chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d={closed ? CHEV_RIGHT : CHEV_DOWN} />
        </svg>
        <span className="repo-title">
          <span className="repo-name">{r.name}</span> <RepoLabel r={r} end />
        </span>
        {closed && r.warnings.length > 0 && (
          <span className="repo-warn-flag" title={tilde(r.warnings.join('\n'))} role="status">
            ⚠ {r.warnings.length}
          </span>
        )}
        {!r.error && main.length + fo.prs > 0 && (
          <span
            className="repo-progress"
            title={`${done} of ${main.length} commits fully viewed${fo.prs ? `, not counting ${fo.prs} follow-on PR${fo.prs === 1 ? '' : 's'} (${foDone} viewed)` : ''}${open ? `\n${open} open thread(s)` : ''}`}
          >
            {done}/{main.length}
            {fo.prs > 0 && <span className="repo-progress-follow-on">+{fo.prs}</span>}
            {open > 0 && <span className="Counter Counter--attn">{open}</span>}
          </span>
        )}
      </button>
      {r.error && (
        <div className="repo-error" role="alert">
          <strong>Can't read this repo</strong>
          <span>{tilde(r.error)}</span>
          {!r.error.includes(r.path) && <code title={r.path}>{tilde(r.path)}</code>}
          <span className="muted">Fix it in <code>{tilde(project.file)}</code>; it reloads by itself.</span>
        </div>
      )}
      {!closed && r.warnings.length > 0 && (
        <div className="repo-warning" role="status">
          {r.warnings.map((w, i) => <span key={i}>⚠ {tilde(w)}</span>)}
          <span className="muted">Edit <code>{tilde(project.file)}</code>.</span>
        </div>
      )}
      {!closed && !r.error && r.commits.length === 0 && <div className="sidebar-empty">No commits in range ({r.base ?? r.from ?? '?'}..{r.end || '?'}).</div>}
      {!closed &&
        r.stacks
          .filter((g) => g.shas.length > 0)
          .map((g, i, shown) => (
            <Fragment key={g.index}>
              {g.follow_on && !shown[i - 1]?.follow_on && (
                <div className="follow-on-divider" role="separator" title={FOLLOW_ON_TIP}>Follow-on · held back</div>
              )}
              <fieldset className={`pr-stack ${g.implicit === 'unstacked' ? 'unstacked' : ''} ${g.follow_on ? 'follow-on' : ''}`} style={{ ['--stack' as string]: stackColor(g.color) }}>
                <legend title={g.warning ?? `${g.shas.length} commit${g.shas.length === 1 ? '' : 's'}${g.follow_on ? `\n${FOLLOW_ON_TIP}` : ''}`}>
                  {stackLabel(g)}
                  {g.follow_on && <FollowOnBadge />}
                </legend>
                <ol className="commit-list">
                  {g.shas.map((sha) => {
                    const c = bySha.get(sha);
                    return c ? <CommitItem key={sha} project={project.slug} repo={r.name} c={c} route={route} followOn={!!g.follow_on} /> : null;
                  })}
                </ol>
                <StackTally commits={g.shas.map((s) => bySha.get(s)).filter((c): c is CommitSummary => !!c)} />
              </fieldset>
            </Fragment>
          ))}
    </section>
  );
}

/**
 * "2/4 ready" on a stack's bottom border (the title already fills the top one), once any of its PRs is ready
 * (published and merged count as ready); "4/4 merged" once they've all landed.
 */
function StackTally({ commits }: { commits: CommitSummary[] }) {
  const n = (s: CommitSummary['status']) => commits.filter((c) => c.status === s).length;
  const ready = n('ready') + n('published') + n('merged');
  if (!ready) return null;
  const tip = [`${n('ready')} ready`, n('published') && `${n('published')} published`, n('merged') && `${n('merged')} merged`, `${n('draft')} draft`].filter(Boolean).join(', ');
  if (n('merged') === commits.length) return <span className="pr-stack-tally is-merged" title={tip}>{commits.length}/{commits.length} merged</span>;
  return <span className="pr-stack-tally" title={tip}>{ready}/{commits.length} ready</span>;
}

// octicon eye-16: the files-viewed bar is about "viewed", like the Viewed checkboxes on Files changed
const EYE = 'M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z';

/** The files-viewed bar and count on each sidebar row. Off for now; flip to bring it back. */
const SHOW_FILES_VIEWED = false;

function CommitItem({ project, repo, c, route, followOn }: { project: string; repo: string; c: CommitSummary; route: Route; followOn?: boolean }) {
  const active = route.repo === repo && !!route.sha && c.sha.startsWith(route.sha.toLowerCase());
  const allViewed = c.filesChanged > 0 && c.viewedCount >= c.filesChanged;
  const url = routeUrl(project, repo, c.short, route.tab);
  const branch = c.branch ?? null;
  const note = branchNote(branch);
  return (
    <li>
      <a
        href={url}
        className={`commit-item ${active ? 'active' : ''}`}
        onClick={(e) => { e.preventDefault(); navigate(url); window.scrollTo(0, 0); }}
        title={`${c.title}${c.title_source === 'override' ? `\n(commit: ${c.subject})` : ''}\n${c.author}, ${relativeTime(c.date)}\n${c.viewedCount}/${c.filesChanged} files viewed`}
      >
        <span className="commit-num">{c.position}</span>
        <span className="commit-main">
          <span className="commit-line">
            <span className="commit-subject">{c.title}</span>
            <ReadinessBadge status={c.status} progress={c.progress} github={c.github} />
          </span>
          <span className="commit-sub">
            {branch ? (
              <span className={`commit-branch is-${branch.status}`} title={`${branch.name}\n${c.sha}${note ? `\n${note}` : ''}`}>
                <MiddleTruncate text={branch.name} />
              </span>
            ) : (
              <code className="commit-branch is-sha" title={c.sha}>{c.short}</code>
            )}
            <BranchStatusMarker branch={branch} />
            <PrBadge github={c.github} asSpan />
            {/* No per-row follow-on badge: it squeezed the branch name; the divider, stack badge and muting say it. */}
            {SHOW_FILES_VIEWED && c.filesChanged > 0 && (
              <span className={`viewed-mini ${allViewed ? 'done' : ''}`} title={`Files viewed: ${c.viewedCount} of ${c.filesChanged}`} aria-label={`Files viewed: ${c.viewedCount} of ${c.filesChanged}`}>
                <svg className="viewed-mini-eye" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d={EYE} /></svg>
                <span className="viewed-mini-bar"><span style={{ width: `${Math.min(100, (100 * c.viewedCount) / c.filesChanged)}%` }} /></span>
                {c.viewedCount}/{c.filesChanged}
              </span>
            )}
            <span className="commit-counts">
              <span className="color-add">+{c.additions}</span>
              <span className="color-del">−{c.deletions}</span>
            </span>
          </span>
        </span>
      </a>
    </li>
  );
}
