// `/`: the root page, every project as a card (a thumbnail of its stacks, its totals, readiness and last activity),
// most recently active first, in Active / Examples / Archived sections. With no projects at all, App shows the
// first-run page (Welcome.tsx) instead.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ProjectSummary, type ProjectsResponse } from './api';
import { ReadinessBadge } from './Readiness';
import { CopyLine } from './Welcome';
import { STATUS_LABEL, type PrStatus } from '../shared/readiness';
import { num, plural, summary } from '../shared/totals';
import { chainGroups } from '../shared/chains';
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

  // linked projects (`after:`) stay together, in chain order, as one group: shown if any of them matches the filter,
  // sorted by their most recently active member (or the first one's title, their total size, their open threads)
  const shown = useMemo(() => {
    const cmp = COMPARE[COMPARE[sort] ? sort : 'recent'];
    const lead = (g: ProjectSummary[]) => (sort === 'recent' ? g.slice().sort(byRecent)[0] : sort === 'title' ? g[0] : { ...g[0], commitCount: g.reduce((a, p) => a + size(p), 0), followOnCount: 0, mergedCount: 0, unresolved: g.reduce((a, p) => a + p.unresolved, 0), activity: g.slice().sort(byRecent)[0].activity });
    return chainGroups(list.projects)
      .filter((g) => g.some((p) => matchesFilter(p, query)))
      .sort((a, b) => cmp(lead(a), lead(b)));
  }, [list.projects, query, sort]);
  // the examples get their own section once you have projects of your own; archived ones (everything landed) go last.
  // A chain is archived only once all of it is, and an example chain only if all of it is examples.
  const own = list.projects.some((p) => !p.example);
  const archived = shown.filter((g) => g.every((p) => p.archived));
  const examples = own ? shown.filter((g) => !g.every((p) => p.archived) && g.every((p) => p.example)) : [];
  const active = shown.filter((g) => !archived.includes(g) && !examples.includes(g));
  const count = (gs: ProjectSummary[][]) => gs.reduce((a, g) => a + g.length, 0);
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
        <Section title="Active" count={count(active)} groups={active} extra={
            !own && list.examples === 'present' ? (
              <>
                <RemoveExamples count={list.projects.length} onRemoved={onExamplesRemoved} />
                {!!list.newExamples?.length && <AddExamples removed={false} count={list.newExamples.length} onAdded={onExamplesAdded} inline />}
              </>
            ) : undefined
          } />
      )}
      {examples.length > 0 && (
        <Section
          title="Examples"
          count={count(examples)}
          groups={examples}
          extra={
            <>
              <RemoveExamples count={list.projects.filter((p) => p.example).length} onRemoved={onExamplesRemoved} />
              {!!list.newExamples?.length && <AddExamples removed={false} count={list.newExamples.length} onAdded={onExamplesAdded} inline />}
            </>
          }
        />
      )}
      {archived.length > 0 && (
        <section className="projects-section">
          <h2 className="projects-section-head">
            <button type="button" className="projects-section-toggle" aria-expanded={showArchived} onClick={() => setArchivedOpen(!archivedOpen)} title="Projects whose PRs have all merged">
              <span aria-hidden="true">{showArchived ? '▾' : '▸'}</span> Archived <span className="Counter">{count(archived)}</span>
            </button>
          </h2>
          {showArchived && <Groups groups={archived} />}
        </section>
      )}
      {list.examples !== 'present' && <AddExamples removed={list.examples === 'removed'} onAdded={onExamplesAdded} />}
    </div>
  );
}

function Section({ title, count, groups, extra }: { title: string; count: number; groups: ProjectSummary[][]; extra?: React.ReactNode }) {
  return (
    <section className="projects-section">
      <h2 className="projects-section-head">
        {title} <span className="Counter">{count}</span>
        {extra}
      </h2>
      <Groups groups={groups} />
    </section>
  );
}

function Groups({ groups }: { groups: ProjectSummary[][] }) {
  return <div className="projects-grid">{groups.map((g) => (g.length === 1 ? <ProjectCard key={g[0].slug} p={g[0]} /> : <ProjectChain key={g[0].slug} chain={g} />))}</div>;
}

/**
 * Linked projects (`after:`) as one group spanning the row: the cards in chain order, an arrow from each project to
 * the ones that build on it, headed by the first one's title.
 */
function ProjectChain({ chain }: { chain: ProjectSummary[] }) {
  const titleOf = (slug: string | null) => chain.find((p) => p.slug === slug)?.title ?? slug;
  return (
    <section className="project-chain" aria-label={`${chain.length} linked projects`}>
      <h3 className="project-chain-head">
        <svg className="octicon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d={LINK_ICON} /></svg>
        {chain[0].title} <span className="muted">· {chain.length} linked projects, each building on the one before</span>
      </h3>
      <ol className="project-chain-list">
        {chain.map((p, i) => (
          <li key={p.slug} className="project-chain-step">
            <span className="project-chain-step-label">{i + 1} · {i === 0 ? 'first' : <>builds on <strong>{titleOf(p.after)}</strong></>}</span>
            <ProjectCard p={p} />
          </li>
        ))}
      </ol>
    </section>
  );
}

// octicon link-16
export const LINK_ICON = 'm7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z';

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

function AddExamples({ removed, onAdded, count, inline }: { removed: boolean; onAdded: (slug: string) => void; count?: number; inline?: boolean }) {
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
  if (inline)
    return (
      <span className="projects-section-extra">
        <button className="btn-link" onClick={add} disabled={busy} title="Example projects new in this version of Local Review; the ones you have are left as they are">
          {busy ? 'Adding…' : `Add ${count === 1 ? 'the new example project' : `${count} new example projects`}`}
        </button>
        {error && <span className="flash flash-error" role="alert">{error}</span>}
      </span>
    );
  return (
    <p className="projects-examples-hint">
      <span className="example-tag">Example</span> Want something to explore?{' '}
      <button className="btn-link" onClick={add} disabled={busy}>{busy ? 'Adding the example projects…' : removed ? 'Bring back the example projects' : 'Add the example projects'}</button>
      {error && <span className="flash flash-error" role="alert">{error}</span>}
    </p>
  );
}
