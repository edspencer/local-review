// What GitHub says about published PRs (server/github.ts), in the UI: the project's summaries (App loads them and
// shares them through GithubContext), the thread chip beside a PR link, the "synced … ago · Refresh" line, the stack
// tally's extra counts and the PR page's "On GitHub" card. All from Local Review's cache; only Refresh (and a page
// coming back into view, if the sync is on) asks the server to fetch.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, type CommitSummary, type GithubInfo, type Loc, type ProjectGithub } from './api';
import { prKey, prRef, threadsLine, type GhComment, type GhPrSnapshot, type GhSummary, type GhThread } from '../shared/github';
import { relativeTime } from './util';

export interface GithubState {
  data: ProjectGithub | null;
  /** bumps whenever a fetch finished (the PR page's card reloads its snapshot) */
  version: number;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export const GithubContext = createContext<GithubState>({ data: null, version: 0, refreshing: false, error: null, refresh: () => {} });

/** A page coming back into view asks at most this often (the server also skips what's under a minute old). */
const FOCUS_THROTTLE_MS = 30_000;

/** The project's GitHub state for App: loaded with the project, again on a `github` event, and on coming into view. */
export function useProjectGithub(slug: string | null): GithubState & { reload: () => void } {
  const [data, setData] = useState<ProjectGithub | null>(null);
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  const reload = useCallback(() => {
    const s = slugRef.current;
    if (!s) return;
    api.github(s).then((g) => {
      if (slugRef.current !== s) return;
      setData(g);
      setVersion((v) => v + 1);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    reload();
  }, [slug, reload]);

  const post = useCallback((reason: 'button' | 'focus') => {
    const s = slugRef.current;
    if (!s) return Promise.resolve();
    return api.githubRefresh(s, reason).then((r) => {
      if (slugRef.current !== s) return;
      setData(r.github);
      setVersion((v) => v + 1);
      setError(r.results.find((x) => x.error)?.error ?? null);
    });
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setError(null);
    post('button').catch((e) => setError((e as Error).message)).finally(() => setRefreshing(false));
  }, [post]);

  // back into view (another tab, another window): catch up if the sync is on; the server decides if it's due
  const lastFocus = useRef(0);
  const enabled = !!data?.enabled;
  useEffect(() => {
    if (!enabled) return;
    const onShow = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastFocus.current < FOCUS_THROTTLE_MS) return;
      lastFocus.current = Date.now();
      post('focus').catch(() => {});
    };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    return () => {
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
    };
  }, [enabled, post]);

  return { data, version, refreshing, error, refresh, reload };
}

/** A commit's PR summary, if GitHub's been asked about it: by its URL, else by number in its repo (a bare `github: 12`). */
export function ghSummary(data: ProjectGithub | null, repo: string, github: GithubInfo | null | undefined): GhSummary | null {
  if (!data || !github) return null;
  const ref = prRef(github.url);
  const key = ref ? prKey(ref) : data.aliases[`${repo}#${github.number}`];
  return (key && data.prs[key]) || null;
}

export function useGhSummary(repo: string, github: GithubInfo | null | undefined): GhSummary | null {
  return ghSummary(useContext(GithubContext).data, repo, github);
}

const COMMENT = 'M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z';
const SYNC = 'M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z';
const MARK = 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';

const svg = (d: string, size = 12) => (
  <svg className="gh-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true"><path fill="currentColor" d={d} /></svg>
);

function openUrl(url: string, e: React.SyntheticEvent) {
  e.preventDefault();
  e.stopPropagation();
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * The review threads beside a PR link: amber with the open count when some need you, else grey with the total (all
 * answered or resolved); nothing without threads. Opens the first open (else answered) thread on GitHub. A span with
 * role=link, as it sits inside the sidebar row's link.
 */
export function GhThreadChip({ s }: { s: GhSummary | null }) {
  if (!s || !s.threads.total) return null;
  const { open, answered, resolved, total } = s.threads;
  const url = s.first_open ?? s.url;
  const title = `${threadsLine(s.threads)}${open ? '\nOpen: the last word is someone else\'s (your turn)' : ''}${answered ? '\nAnswered: the last word is yours (theirs to resolve)' : ''}\n${url}`;
  return (
    <span
      className={`gh-chip ${open ? 'is-open' : 'is-done'}`}
      role="link"
      tabIndex={0}
      title={title}
      aria-label={`${open} open, ${answered} answered, ${resolved} resolved review threads on GitHub`}
      onClick={(e) => openUrl(url, e)}
      onAuxClick={(e) => { if (e.button === 1) openUrl(url, e); }}
      onKeyDown={(e) => { if (e.key === 'Enter') openUrl(url, e); }}
    >
      {svg(COMMENT)}
      {open || total}
    </span>
  );
}

/** "· 4/6 approved · 4 to answer" after a stack's "6/6 ready", from the PRs GitHub's been asked about. */
export function ghTally(data: ProjectGithub | null, repo: string, commits: CommitSummary[]): { text: string; open: number; tip: string } | null {
  const sums = commits.filter((c) => !c.landed).map((c) => ghSummary(data, repo, c.github)).filter((s): s is GhSummary => !!s && s.state === 'open');
  if (!sums.length) return null;
  const approved = sums.filter((s) => s.approved_by.length && !s.changes_requested_by.length).length;
  const blocked = sums.filter((s) => s.tone === 'blocked').length;
  const open = sums.reduce((a, s) => a + s.threads.open, 0);
  const tip = [`${approved} of ${sums.length} open PRs on GitHub approved`, blocked && `${blocked} with failing checks or changes requested`, `${open} review thread${open === 1 ? '' : 's'} waiting for your answer`].filter(Boolean).join('\n');
  return { text: `${approved}/${sums.length} approved`, open, tip };
}

/** "GitHub synced 2m ago · Refresh" above the sidebar's repos, once the sync is on or anything's been fetched. */
export function GhSyncLine() {
  const { data, refreshing, error, refresh } = useContext(GithubContext);
  if (!data || data.optedOut || (!data.enabled && !data.fetchedAt) || !data.repos.length) return null;
  const err = error ?? data.error;
  const when = data.fetchedAt ? `synced ${relativeTime(data.fetchedAt)}` : 'not synced yet';
  const tip = [
    data.enabled ? `Fetched again once older than ${Math.round(data.maxAgeMs / 60000) || 1} min while this page is open (github.max_age in config.yaml), and when you come back to it` : 'The GitHub sync is off (github.sync in config.yaml): only Refresh or `local-review github refresh` fetch',
    ...data.repos.map((r) => `${r.key}: ${r.prs} PR${r.prs === 1 ? '' : 's'}, ${r.fetched_at ? `fetched ${relativeTime(r.fetched_at)}` : 'never fetched'}${r.error ? ` (last attempt failed: ${r.error})` : ''}`),
  ].join('\n');
  return (
    <div className={`gh-sync ${err ? 'has-error' : ''}`} title={tip}>
      {svg(SYNC)}
      <span className="gh-sync-when">{refreshing ? 'Fetching from GitHub…' : `GitHub ${when}`}</span>
      {!refreshing && (
        <button type="button" className="btn-link gh-sync-refresh" onClick={refresh}>
          Refresh
        </button>
      )}
      {err && !refreshing && <span className="gh-sync-error" title={err}>{err}</span>}
    </div>
  );
}

// ---------------- the PR page's "On GitHub" card ----------------
const excerpt = (s: string, n = 280) => {
  const t = s.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function Who({ c }: { c: GhComment | null }) {
  return <strong>{c?.author ?? 'ghost'}</strong>;
}

function ThreadRow({ t }: { t: GhThread }) {
  const last = t.last;
  return (
    <li className={`gh-thread is-${t.state}`}>
      <div className="gh-thread-head">
        <a href={t.url} target="_blank" rel="noreferrer noopener" className="gh-thread-where" title={`${t.path}${t.line ? `:${t.line}` : ''} on GitHub`}>
          <code>{t.path.split('/').pop()}{t.line ? `:${t.line}` : ''}</code> ↗
        </a>
        <span className="muted">
          {t.comments[0] && <>started by <Who c={t.comments[0]} /> · </>}
          {t.total} comment{t.total === 1 ? '' : 's'}
          {t.outdated && <> · <span className="gh-outdated">outdated</span></>}
        </span>
      </div>
      {last && (
        <div className="gh-thread-last">
          <Who c={last} />{last.at && <span className="muted"> {relativeTime(last.at)}</span>}: {excerpt(last.body)}
        </div>
      )}
    </li>
  );
}

function Fold({ title, count, children, open = false }: { title: string; count: number; children: React.ReactNode; open?: boolean }) {
  if (!count) return null;
  return (
    <details className="gh-fold" open={open}>
      <summary>
        {title} <span className="Counter">{count}</span>
      </summary>
      {children}
    </details>
  );
}

/**
 * What GitHub says about this PR: approvals, checks, the review threads that need you (open), the ones waiting on the
 * reviewer (answered), and the reviews' summaries and the PR's comments, folded. Links go to GitHub.
 */
export function GithubCard({ loc, sha, github }: { loc: Loc; sha: string; github: GithubInfo | null }) {
  const { version, data, refresh, refreshing } = useContext(GithubContext);
  const [snap, setSnap] = useState<GhPrSnapshot | null | undefined>(undefined);
  useEffect(() => {
    if (!github) return;
    let live = true;
    api.prGithub(loc, sha).then((s) => live && setSnap(s)).catch(() => live && setSnap(null));
    return () => { live = false; };
  }, [loc, sha, github?.url, version]);
  if (!github || !snap) return null;
  const sum = ghSummary(data, loc.repo, github);
  const open = snap.threads.filter((t) => t.state === 'open');
  const answered = snap.threads.filter((t) => t.state === 'answered');
  const resolved = snap.threads.filter((t) => t.state === 'resolved');
  const people = (xs: string[]) => xs.join(', ');
  return (
    <div className={`gh-card ${sum?.tone ? `is-${sum.tone}` : ''}`}>
      <div className="gh-card-head">
        {svg(MARK, 16)}
        <strong>On GitHub</strong>
        <a href={snap.url} target="_blank" rel="noreferrer noopener" className="pr-badge">#{snap.number}<span className="pr-badge-ext" aria-hidden="true">↗</span></a>
        {snap.state !== 'open' ? <span className="gh-pill">{snap.state}</span> : snap.draft && <span className="gh-pill">draft on GitHub</span>}
        <span className="gh-card-sync muted" title={snap.fetched_at}>
          fetched {relativeTime(snap.fetched_at)} ·{' '}
          <button type="button" className="btn-link" onClick={refresh} disabled={refreshing}>{refreshing ? 'fetching…' : 'Refresh'}</button>
        </span>
      </div>
      <ul className="gh-facts">
        {snap.changes_requested_by.length > 0 && <li className="is-bad"><a href={`${snap.url}/files`} target="_blank" rel="noreferrer noopener">Changes requested by {people(snap.changes_requested_by)}</a></li>}
        <li className={snap.approved_by.length ? 'is-good' : ''}>
          <a href={snap.url} target="_blank" rel="noreferrer noopener">{snap.approved_by.length ? `Approved by ${people(snap.approved_by)}` : 'No approval yet'}</a>
        </li>
        {snap.checks && (
          <li className={snap.checks === 'failing' ? 'is-bad' : snap.checks === 'passing' ? 'is-good' : ''}>
            <a href={`${snap.url}/checks`} target="_blank" rel="noreferrer noopener">Checks {snap.checks}</a>
          </li>
        )}
        <li className={open.length ? 'is-warn' : ''}>{threadsLine({ total: snap.threads.length, open: open.length, answered: answered.length, resolved: resolved.length })}</li>
      </ul>
      {open.length > 0 && (
        <>
          <h4 className="gh-sub">Your turn <span className="muted">(the last word is someone else's)</span></h4>
          <ul className="gh-threads">{open.map((t) => <ThreadRow key={t.url} t={t} />)}</ul>
        </>
      )}
      <Fold title="Answered: theirs to resolve" count={answered.length}>
        <ul className="gh-threads">{answered.map((t) => <ThreadRow key={t.url} t={t} />)}</ul>
      </Fold>
      <Fold title="Resolved" count={resolved.length}>
        <ul className="gh-threads">{resolved.map((t) => <ThreadRow key={t.url} t={t} />)}</ul>
      </Fold>
      <Fold title="Review summaries" count={snap.reviews.length}>
        <ul className="gh-comments">
          {snap.reviews.map((r) => (
            <li key={r.url}>
              <Who c={r} /> <span className="muted">{r.state.toLowerCase().replace('_', ' ')} {r.at && relativeTime(r.at)}</span>: {excerpt(r.body)}{' '}
              {r.url && <a href={r.url} target="_blank" rel="noreferrer noopener">↗</a>}
            </li>
          ))}
        </ul>
      </Fold>
      <Fold title="PR comments" count={snap.conversation_total}>
        <ul className="gh-comments">
          {snap.conversation.map((c) => (
            <li key={c.url}>
              <Who c={c} /> <span className="muted">{c.at && relativeTime(c.at)}</span>: {excerpt(c.body)} {c.url && <a href={c.url} target="_blank" rel="noreferrer noopener">↗</a>}
            </li>
          ))}
        </ul>
      </Fold>
    </div>
  );
}
