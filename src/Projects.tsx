// `/`: the root page, every project as a card (a thumbnail of its stacks, its totals, readiness and last activity),
// most recently active first, in Active / Examples / Archived sections. With no projects at all, App shows the
// first-run page (Welcome.tsx) instead.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ProjectSummary, type ProjectsResponse } from './api';
import { ReadinessBadge } from './Readiness';
import { CopyLine } from './Welcome';
import { STATUS_LABEL, type PrStatus } from '../shared/readiness';
import { num, plural, summary } from '../shared/totals';
import { isTyping, linkTo, projectUrl, relativeTime, useLocalStorage, useTilde } from './util';

type Sort = 'recent' | 'title' | 'size' | 'open';
const SORTS: [Sort, string][] = [
  ['recent', 'Recent activity'],
  ['title', 'Title'],
  ['size', 'Size'],
  ['open', 'Open threads'],
];
const ORDER: PrStatus[] = ['merged', 'published', 'ready', 'draft']; // the readiness bar, left to right
const TALLY: PrStatus[] = ['draft', 'ready', 'published', 'merged'];

const size = (p: ProjectSummary) => p.commitCount + p.followOnCount + p.mergedCount;
const byRecent = (a: ProjectSummary, b: ProjectSummary) => b.activity.at.localeCompare(a.activity.at);
const COMPARE: Record<Sort, (a: ProjectSummary, b: ProjectSummary) => number> = {
  recent: byRecent,
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  size: (a, b) => size(b) - size(a) || byRecent(a, b),
  open: (a, b) => b.unresolved - a.unresolved || byRecent(a, b),
};

/** Every word of the filter appears in the title, slug, a repo name or a branch name. */
export function matchesFilter(p: Pick<ProjectSummary, 'title' | 'slug' | 'repos' | 'branches'>, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [p.title, p.slug, ...p.repos, ...(p.branches ?? [])].join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

const ACTIVITY: Record<ProjectSummary['activity']['kind'], string> = { comment: 'comment', commit: 'commit', merged: 'merged', edit: 'updated' };

export function Projects({ list, onExamplesAdded, onExamplesRemoved }: { list: ProjectsResponse; onExamplesAdded: (slug: string) => void; onExamplesRemoved: () => void }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useLocalStorage<Sort>('lr.rootSort', 'recent');
  const [archivedOpen, setArchivedOpen] = useLocalStorage('lr.rootArchivedOpen', false);
  const filterRef = useRef<HTMLInputElement>(null);
  const tilde = useTilde();
  useEffect(() => {
    document.title = 'Projects · Local Review';
    return () => { document.title = 'Local Review'; };
  }, []);
  // `/` focuses the filter, as on GitHub
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shown = useMemo(() => list.projects.filter((p) => matchesFilter(p, query)).sort(COMPARE[COMPARE[sort] ? sort : 'recent']), [list.projects, query, sort]);
  // the examples get their own section once you have projects of your own; archived ones (everything landed) go last
  const own = list.projects.some((p) => !p.example);
  const active = shown.filter((p) => !p.archived && !(own && p.example));
  const examples = own ? shown.filter((p) => !p.archived && p.example) : [];
  const archived = shown.filter((p) => p.archived);
  const showArchived = archivedOpen || (!!query && archived.length > 0);
  const n = list.projects.length;

  return (
    <div className="page projects-page">
      <div className="projects-head">
        <h1>Projects</h1>
        <p className="projects-lede">
          A project is one piece of work: its repos, their commit ranges, and the PR stacks they split into.{' '}
          <span className="muted">
            {plural(n, 'project')} in <code title={list.projectsDir}>{tilde(list.projectsDir)}</code>
          </span>
        </p>
      </div>
      <div className="projects-toolbar">
        <input
          ref={filterRef}
          type="search"
          className="form-control projects-filter"
          placeholder="Filter by title, repo or branch…"
          aria-label="Filter projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }}
        />
        <label className="projects-sort">
          <span className="muted">Sort</span>
          <select className="form-select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        <span className="spacer" />
        <span className="projects-new" title="Creates ~/.local-review/projects/<slug>/project.yaml from a commented example; then edit it">
          <span className="muted">New project:</span> <CopyLine text="npx local-review init <slug>" label="the init command" />
        </span>
      </div>

      {shown.length === 0 && (
        <div className="blankslate">
          No project matches <strong>{query}</strong>. <button className="btn-link" onClick={() => setQuery('')}>Clear the filter</button>
        </div>
      )}
      {active.length > 0 && (
        <Section title="Active" count={active.length} projects={active} extra={!own && list.examples === 'present' ? <RemoveExamples count={list.projects.length} onRemoved={onExamplesRemoved} /> : undefined} />
      )}
      {examples.length > 0 && (
        <Section title="Examples" count={examples.length} projects={examples} extra={<RemoveExamples count={list.projects.filter((p) => p.example).length} onRemoved={onExamplesRemoved} />} />
      )}
      {archived.length > 0 && (
        <section className="projects-section">
          <h2 className="projects-section-head">
            <button type="button" className="projects-section-toggle" aria-expanded={showArchived} onClick={() => setArchivedOpen(!archivedOpen)} title="Projects whose PRs have all merged">
              <span aria-hidden="true">{showArchived ? '▾' : '▸'}</span> Archived <span className="Counter">{archived.length}</span>
            </button>
          </h2>
          {showArchived && <div className="projects-grid">{archived.map((p) => <ProjectCard key={p.slug} p={p} />)}</div>}
        </section>
      )}
      {list.examples !== 'present' && <AddExamples removed={list.examples === 'removed'} onAdded={onExamplesAdded} />}
    </div>
  );
}

function Section({ title, count, projects, extra }: { title: string; count: number; projects: ProjectSummary[]; extra?: React.ReactNode }) {
  return (
    <section className="projects-section">
      <h2 className="projects-section-head">
        {title} <span className="Counter">{count}</span>
        {extra}
      </h2>
      <div className="projects-grid">{projects.map((p) => <ProjectCard key={p.slug} p={p} />)}</div>
    </section>
  );
}

export function ProjectCard({ p }: { p: ProjectSummary }) {
  const s = summary(p.totals, p.repoCount);
  const url = projectUrl(p.slug);
  const thumb = `/api/projects/${encodeURIComponent(p.slug)}/thumb.svg?v=${p.thumb}`;
  const act = p.activity;
  return (
    <a className={`project-card ${p.archived ? 'is-archived' : ''}`} href={url} onClick={linkTo(url)} title={p.description?.trim() || p.title}>
      <span className="project-card-thumb">
        <img src={thumb} loading="lazy" decoding="async" width={280} height={150} alt={`The stacks of ${p.title}`} />
      </span>
      <span className="project-card-body">
        <span className="project-card-title">
          <span className="project-card-name">{p.title}</span>
          {p.example && <span className="example-tag">Example</span>}
          {p.archived && <span className="Label Label--merged">Archived</span>}
          {p.error && <span className="project-card-error" title={p.error}>⚠</span>}
        </span>
        <span className="project-card-counts">{s.counts}</span>
        <span className="project-card-counts">
          <span className="color-add">+{num(s.additions)}</span> <span className="color-del">−{num(s.deletions)}</span>
          {s.note && <> · <span className="follow-on-note" title={s.note}>+{num(p.totals.followOn.prs)} follow-on</span></>}
          {s.merged && <> · <span className="merged-note">{s.merged}</span></>}
        </span>
        <ReadinessBar r={p.readiness} />
        <span className="project-card-foot">
          <span className="project-card-tally">
            {TALLY.filter((k) => p.readiness[k]).map((k) => (
              <span key={k} className="project-card-tally-item" title={`${p.readiness[k]} ${STATUS_LABEL[k].toLowerCase()}`}>
                <ReadinessBadge status={k} size={14} title="" />
                {p.readiness[k]}
              </span>
            ))}
          </span>
          <span className="project-card-activity">
            {p.unresolved > 0 && <span className="Counter Counter--attn" title={`${p.unresolved} open thread${p.unresolved === 1 ? '' : 's'}`}>{p.unresolved}</span>}
            <span title={new Date(act.at).toLocaleString()}>{ACTIVITY[act.kind]} {relativeTime(act.at)}</span>
          </span>
        </span>
      </span>
    </a>
  );
}

/** One strip, merged → published → ready → draft, each status's share of the PRs (follow-on left out). */
function ReadinessBar({ r }: { r: Record<PrStatus, number> }) {
  const total = ORDER.reduce((a, k) => a + r[k], 0);
  return (
    <span className="readiness-bar" aria-hidden="true">
      {total > 0 && ORDER.filter((k) => r[k]).map((k) => <span key={k} className={`readiness-bar-seg is-${k}`} style={{ flexGrow: r[k] }} />)}
    </span>
  );
}

function RemoveExamples({ count, onRemoved }: { count: number; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.removeExamples();
      setConfirming(false);
      onRemoved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="projects-section-extra">
      {confirming ? (
        <>
          <span>Remove the {count} example project{count === 1 ? '' : 's'}? Nothing is deleted.</span>
          <button className="btn btn-sm btn-danger-outline" onClick={remove} disabled={busy}>{busy ? 'Removing…' : 'Remove'}</button>
          <button className="btn btn-sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
        </>
      ) : (
        <button className="btn-link" onClick={() => setConfirming(true)}>Remove example projects</button>
      )}
      {error && <span className="flash flash-error" role="alert">{error}</span>}
    </span>
  );
}

function AddExamples({ removed, onAdded }: { removed: boolean; onAdded: (slug: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tilde = useTilde();
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.addExamples();
      onAdded([...r.created, ...r.restored, ...r.existing][0] ?? '');
    } catch (e) {
      setError(tilde((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="projects-examples-hint">
      <span className="example-tag">Example</span> Want something to explore?{' '}
      <button className="btn-link" onClick={add} disabled={busy}>{busy ? 'Adding the example projects…' : removed ? 'Bring back the example projects' : 'Add the example projects'}</button>
      {error && <span className="flash flash-error" role="alert">{error}</span>}
    </p>
  );
}
