// The Comments tab of the stack and project pages: every thread on every PR there (published or not), open ones
// first, then the most recently updated (shared/threads.ts). Each thread is the one Files changed shows, folding
// the same way (threadFold.ts), with its PR and line above it; reply, resolve, edit and delete work as on the PR.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, stackColor, type CommitSummary, type ProjectData, type RepoData, type StackGroup, type Thread, type ThreadEntry, type ThreadsResponse } from './api';
import { AnchorSnippet, AuthorLabel, Avatar, ThreadView, type ThreadActions } from './Comments';
import { NO_FOLDS, isFolded, reconcileFolds, setFolded, type FoldState } from './threadFold';
import { StackLink, stackLabel } from './Stacks';
import { hoverPrefetch } from './commitCache';
import { entryKey, lastUpdate, orderThreads, sortKey, type SortKey } from '../shared/threads';
import { linkTo, relativeTime, routeUrl, useTilde } from './util';

/** Open threads on these PRs, for the tab's counter: from the sidebar's data, so it's there before the tab loads. */
export const openThreads = (commits: readonly CommitSummary[]) => commits.reduce((n, c) => n + c.unresolved, 0);

export function CommentsTab({ project, scope }: { project: ProjectData; scope?: { repo: RepoData; group: StackGroup; ref: string } }) {
  const [data, setData] = useState<{ key: string; r: ThreadsResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tilde = useTilde();
  const key = `${project.slug}\0${scope?.repo.name ?? ''}\0${scope?.ref ?? ''}`;
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    api
      .threads(project.slug, scope && { repo: scope.repo.name, stack: scope.ref })
      .then((r) => { if (n === seq.current) { setData({ key, r }); setError(null); } })
      .catch((e) => { if (n === seq.current) setError((e as Error).message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // the project payload is fetched again on every server event (App.tsx), so this follows every change live
  useEffect(load, [load, project]);
  const r = data?.key === key ? data.r : null;

  // threads acted on here keep the place they had (shared/threads.ts orderThreads): for this visit to the tab
  const held = useRef(new Map<string, SortKey>());
  useEffect(() => { held.current = new Map(); }, [key]);
  const threads = useMemo(() => (r ? orderThreads(r.threads, held.current) : []), [r]);

  // folds, as in Files changed (keyed per PR: thread ids are only unique in their own file)
  const [folds, setFolds] = useState<FoldState>(NO_FOLDS);
  const foldable = useMemo(() => threads.map((e) => ({ ...e.thread, id: entryKey(e) })), [threads]);
  const caughtUp = reconcileFolds(folds, foldable);
  if (caughtUp !== folds) setFolds(caughtUp);

  const commitOf = useMemo(() => {
    const m = new Map<string, { repo: RepoData; c: CommitSummary; group: StackGroup | undefined }>();
    for (const repo of project.repos) for (const c of repo.commits) m.set(`${repo.name}/${c.sha}`, { repo, c, group: repo.stacks[c.stack] });
    return m;
  }, [project]);

  const actionsFor = (e: ThreadEntry): ThreadActions => {
    const l = { project: project.slug, repo: e.repo };
    const hold = () => { if (!held.current.has(entryKey(e))) held.current.set(entryKey(e), sortKey(e.thread)); };
    const run = (p: () => Promise<unknown>) => { hold(); return p().then((x) => { load(); return x; }); };
    return {
      reply: (tid, body) => run(() => api.reply(l, e.sha, tid, body)),
      resolve: (tid, resolved) => run(() => api.resolve(l, e.sha, tid, resolved)),
      edit: (tid, cid, body) => run(() => api.editComment(l, e.sha, tid, cid, body)),
      remove: (tid, cid) => run(() => api.deleteComment(l, e.sha, tid, cid)),
    };
  };

  if (!r) return error ? <div className="flash flash-error">{tilde(error)}</div> : <div className="loading">Loading comments…</div>;
  const where = scope ? 'this stack' : 'this project';
  const multiRepo = project.repos.length > 1;
  return (
    <div className="comments-tab">
      {error && <div className="flash flash-error">{tilde(error)}</div>}
      {r.problems.length > 0 && (
        <div className="flash flash-warn" role="status">
          {r.problems.map((p) => <div key={p.file}>⚠ <code>{tilde(p.file)}</code> is not valid YAML, so its threads aren't listed: {tilde(p.error)}</div>)}
        </div>
      )}
      {threads.length === 0 ? (
        <div className="blankslate">No comments on {scope ? "this stack's" : "this project's"} PRs yet. Comment on a PR, or have an agent write a review file, and its threads show up here.</div>
      ) : (
        <div className="timeline">
          {threads.map((e) => {
            const k = entryKey(e);
            const at = commitOf.get(`${e.repo}/${e.sha}`);
            if (!at) return null; // a rebase in between the two payloads: back on the next refresh
            return (
              <CommentsTabItem
                key={k}
                project={project.slug}
                entry={e}
                commit={at.c}
                group={!scope ? at.group : undefined}
                repo={multiRepo && !scope ? e.repo : undefined}
                actions={actionsFor(e)}
                folded={isFolded(caughtUp, { ...e.thread, id: k })}
                setFolded={(f) => setFolds((s) => setFolded(s, k, f))}
              />
            );
          })}
        </div>
      )}
      <p className="yaml-hint muted">
        Every thread on {where}'s PRs, open ones first, then the most recently updated. They're stored in each PR's review file, under <code>{tilde(project.file.replace(/project\.yaml$/, 'reviews/'))}</code>; an agent's reply there shows up here live.
      </p>
    </div>
  );
}

/** `path:line` (or `:start-line`, or a range across old and new lines) for an inline thread, as the PR page shows it. */
function lineText(t: Thread): string {
  if (!t.line) return t.path ?? '';
  const mixed = !!t.start_line && !!t.start_side && t.start_side !== (t.side ?? 'right');
  const sign = (s?: string) => (s === 'left' ? '-' : '+');
  return `${t.path}:${mixed ? `${sign(t.start_side)}${t.start_line} to ${sign(t.side)}` : t.start_line ? `${t.start_line}-` : ''}${t.line}`;
}

function CommentsTabItem({ project, entry: e, commit: c, group, repo, actions, folded, setFolded }: {
  project: string;
  entry: ThreadEntry;
  commit: CommitSummary;
  group?: StackGroup;
  repo?: string;
  actions: ThreadActions;
  folded: boolean;
  setFolded: (f: boolean) => void;
}) {
  const t = e.thread;
  const first = t.comments[0];
  // inline threads open Files changed at their line; file and general ones, their file or the Conversation tab
  const prUrl = routeUrl(project, e.repo, c.short, 'conversation', null, t.path ? null : t.id);
  const lineUrl = t.path ? routeUrl(project, e.repo, c.short, 'files', t.path, t.line ? t.id : null) : null;
  const prefetch = hoverPrefetch({ project, repo: e.repo }, c.short);
  const updated = lastUpdate(t);
  const started = first?.created ? Date.parse(first.created) || 0 : 0;
  // a thread still placed on this commit: the commented lines from its anchor, at the lines they're on now
  const a = t.anchor;
  const context = a && t.line && !t.outdated ? <AnchorSnippet anchor={{ ...a, side: t.side ?? a.side, line: t.line, start_line: t.start_line, start_side: t.start_side }} /> : undefined;
  return (
    <div className={`timeline-item comments-tab-item ${t.resolved ? 'is-resolved' : ''}`}>
      <Avatar author={first?.author ?? 'unknown'} size={40} />
      <div className="timeline-review">
        <div className="timeline-review-header">
          <AuthorLabel author={first?.author ?? 'unknown'} />
          <span className="muted">commented <span title={first?.created ?? ''}>{relativeTime(first?.created)}</span> on</span>
          <a className="comments-tab-pr" href={prUrl} onClick={linkTo(prUrl, { scroll: false })} {...prefetch} title={`${e.repo} · ${c.short}`}>
            <span className="muted">#{c.position}</span> {c.title}
          </a>
          {lineUrl && (
            <a className="file-link" href={lineUrl} onClick={linkTo(lineUrl, { scroll: false })} {...prefetch} title={t.line ? 'Open it in Files changed' : 'Open the file in Files changed'}>
              {lineText(t)}
            </a>
          )}
          <span className="spacer" />
          {(repo || group) && (
            <span className="comments-tab-in muted">
              {repo && <span className="branch-name">{repo}</span>}
              {group && repo && ' '}
              {group && (
                <StackLink project={project} repo={e.repo} group={group} tab="comments" className="comments-tab-stack" style={{ ['--stack' as string]: stackColor(group.color) }} title="This stack's Comments tab">
                  {stackLabel(group)}
                </StackLink>
              )}
            </span>
          )}
          {updated > started + 1000 && relativeTime(e.updated) !== relativeTime(first?.created) && <span className="muted" title={e.updated ?? ''}>· updated {relativeTime(e.updated)}</span>}
        </div>
        <ThreadView thread={t} actions={actions} context={context} fold={{ folded, setFolded }} />
      </div>
    </div>
  );
}
