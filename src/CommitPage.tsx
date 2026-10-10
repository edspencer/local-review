import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, stackColor, type CommitResponse, type CommitSummary, type FileData, type GithubInfo, type LandedInfo, type Loc, type PrInfo, type RepoData, type Review, type StackGroup, type Thread } from './api';
import { BranchStatusMarker, PrBadge, branchNote } from './Branch';
import { Avatar, AuthorLabel, CommentForm, CommentView, Markdown, Octicon, ThreadView, reviewer, type ThreadActions } from './Comments';
import { FilesChanged, StatusIcon, type Draft } from './FilesChanged';
import { BodyEditor, CopyButton, DescriptionMenu, EditIconButton, EditedMarker, FULL_BODY_TIP, TitleEditor, type PrChange, type PrDraft } from './PrEdit';
import { fullPrBody, normBody, normTitle } from './prText';
import { ProjectContextBox } from './ProjectText';
import { FollowOnBadge, ReadinessBadge, ReadinessControl } from './Readiness';
import { progressOf, statusTooltip } from '../shared/readiness';
import { StackTab } from './StackTab';
import { navigate, relativeTime, routeUrl, type Route } from './util';

export function CommitPage({ route, loc: locProp, projectTitle, projectIntro, projectFile, reviewBump, onChanged, repoData, vizVersion }: { route: Route; loc: Loc; projectTitle: string; projectIntro: string | null; projectFile: string; reviewBump: Map<string, number>; onChanged: () => void; repoData?: RepoData; vizVersion: string }) {
  const sha = route.sha!;
  // stable identity: the parent builds a new object on every render
  const loc = useMemo(() => ({ project: locProp.project, repo: locProp.repo }), [locProp.project, locProp.repo]);
  const [data, setData] = useState<CommitResponse | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  // Optimistic "Viewed" toggles still waiting for the server: path -> [request token, viewed]. They are
  // laid over every review we receive (including SSE refreshes) until their own request settles.
  const pendingViewed = useRef(new Map<string, [number, boolean]>());
  const viewedToken = useRef(0);
  const withPending = useCallback((r: Review): Review => {
    if (!pendingViewed.current.size) return r;
    const set = new Set(r.viewed);
    for (const [p, [, v]] of pendingViewed.current) v ? set.add(p) : set.delete(p);
    return { ...r, viewed: [...set] };
  }, []);
  const receive = useCallback((r: Review) => setReview(withPending(r)), [withPending]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    pendingViewed.current.clear();
    api
      .commit(loc, sha)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setReview(d.review);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [loc, sha]);

  // live refresh when the YAML file for this commit changes (e.g. an agent replied)
  const fullSha = data?.commit.sha;
  const bump = fullSha ? reviewBump.get(`review:${loc.project}:${loc.repo}:${fullSha}`) ?? 0 : 0;
  useEffect(() => {
    if (!fullSha || bump === 0) return;
    api.review(loc, fullSha).then(receive).catch(() => {});
  }, [loc, fullSha, bump, receive]);
  // …and when its PR title / description override changes
  const prBump = fullSha ? reviewBump.get(`pr:${loc.project}:${loc.repo}:${fullSha}`) ?? 0 : 0;
  useEffect(() => {
    if (!fullSha || prBump === 0) return;
    api.pr(loc, fullSha).then((pr) => setData((d) => (d && d.commit.sha === fullSha ? { ...d, pr } : d))).catch(() => {});
  }, [loc, fullSha, prBump]);

  useEffect(() => {
    if (data?.pr.title) document.title = `${data.pr.title} · ${projectTitle} · Local Review`;
    return () => { document.title = 'Local Review'; };
  }, [data?.pr.title, projectTitle]);

  const wrap = useCallback(
    async (p: Promise<Review>) => {
      const r = await p;
      receive(r);
      setActionError(null);
      onChanged();
      return r;
    },
    [onChanged, receive],
  );

  const setViewed = useCallback(
    async (path: string, v: boolean) => {
      if (!fullSha) return;
      const token = ++viewedToken.current;
      pendingViewed.current.set(path, [token, v]);
      setReview((r) => (r ? withPending(r) : r));
      const settle = () => {
        if (pendingViewed.current.get(path)?.[0] === token) pendingViewed.current.delete(path);
      };
      try {
        const r = await api.viewed(loc, fullSha, path, v);
        settle();
        receive(r);
        setActionError(null);
        onChanged();
      } catch (e) {
        settle();
        // revert: back to what the server has (falling back to undoing our toggle locally)
        setReview((r) => {
          if (!r || pendingViewed.current.has(path)) return r;
          const set = new Set(r.viewed);
          v ? set.delete(path) : set.add(path);
          return { ...r, viewed: [...set] };
        });
        api.review(loc, fullSha).then(receive).catch(() => {});
        setActionError(`Couldn't save "Viewed" for ${path}: ${(e as Error).message}`);
        throw e;
      }
    },
    [loc, fullSha, withPending, receive, onChanged],
  );

  // PR title / description edits in progress, per commit (so a draft survives switching tabs or commits)
  const [titleDrafts, setTitleDrafts] = useState<Record<string, PrDraft>>({});
  const [bodyDrafts, setBodyDrafts] = useState<Record<string, PrDraft>>({});
  const titleDraft = fullSha ? titleDrafts[fullSha] : undefined;
  const bodyDraft = fullSha ? bodyDrafts[fullSha] : undefined;
  const setDraftFor = (set: typeof setTitleDrafts, sha: string) => (d: PrDraft | null) =>
    set((m) => { const n = { ...m }; if (d) n[sha] = d; else delete n[sha]; return n; });
  const dirty = Object.values(titleDrafts).some((d) => normTitle(d.text) !== normTitle(d.base)) || Object.values(bodyDrafts).some((d) => normBody(d.text) !== normBody(d.base));
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const savePr = useCallback(
    async (change: PrChange): Promise<PrInfo> => {
      const pr = await api.setPr(loc, fullSha!, change);
      setData((d) => (d && d.commit.sha === fullSha ? { ...d, pr } : d));
      onChanged(); // sidebar + stepper titles
      return pr;
    },
    [loc, fullSha, onChanged],
  );
  /** Save the title draft; a title equal to the commit subject clears the override. */
  const saveTitle = async (pr: PrInfo, text: string) => {
    const t = normTitle(text);
    if (t !== pr.title) await savePr({ title: t === normTitle(pr.commit_subject) ? null : t });
    setDraftFor(setTitleDrafts, fullSha!)(null);
  };
  /** Save the description draft; one equal to the commit body clears the override. */
  const saveBody = async (pr: PrInfo, text: string) => {
    const b = normBody(text);
    if (b !== normBody(pr.body) || (pr.body_source === 'override' && b === normBody(pr.commit_body))) await savePr({ body: b === normBody(pr.commit_body) ? null : b });
    setDraftFor(setBodyDrafts, fullSha!)(null);
  };

  const actions: ThreadActions = useMemo(
    () => ({
      reply: (tid, body) => wrap(api.reply(loc, fullSha!, tid, body)),
      resolve: (tid, resolved) => wrap(api.resolve(loc, fullSha!, tid, resolved)),
      edit: (tid, cid, body) => wrap(api.editComment(loc, fullSha!, tid, cid, body)),
      remove: (tid, cid) => wrap(api.deleteComment(loc, fullSha!, tid, cid)),
    }),
    [loc, fullSha, wrap],
  );

  if (error) return <div className="page"><div className="flash flash-error">{error}</div></div>;
  if (!data || !review || !data.commit.sha.startsWith(sha.toLowerCase())) return <div className="page"><div className="loading">Loading…</div></div>;

  const c = data.commit;
  const tab = route.tab;
  const go = (t: Route['tab']) => navigate(routeUrl(loc.project, loc.repo, sha, t));
  const goTo = (to: { repo: string; sha: string } | null) => {
    if (!to) return;
    navigate(routeUrl(loc.project, to.repo, to.sha.slice(0, 8), tab));
    window.scrollTo(0, 0);
  };
  // the stack this commit is in, with live counts from the sidebar's data (falling back to the commit payload)
  const liveCommit = repoData?.commits.find((x) => x.sha === c.sha);
  const group: StackGroup | null = (liveCommit && repoData?.stacks[liveCommit.stack]) || data.stack;
  const stackCommits = group && repoData ? (group.shas.map((s) => repoData.commits.find((x) => x.sha === s)).filter(Boolean) as CommitSummary[]) : [];
  // the commit's own branch and GitHub PR: live from the sidebar's data, else from the commit payload
  const branch = (liveCommit ? liveCommit.branch : c.branch) ?? null;
  const github = (liveCommit ? liveCommit.github : c.github) ?? null;
  const base = prBase(github, repoData, c.sha);
  // readiness: the status from the prs file (live via SSE), progress from the review on screen
  const status = data.pr.status;
  const progress = progressOf(review.threads, c.files.map((f) => f.path), review.viewed);
  const setStatus = async (s: 'draft' | 'ready') => {
    setStatusBusy(true);
    try {
      await savePr({ status: s });
      setActionError(null);
    } catch (e) {
      setActionError(`Couldn't mark it ${s}: ${(e as Error).message}`);
    } finally {
      setStatusBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="pr-header">
        {titleDraft ? (
          <TitleEditor
            pr={data.pr}
            draft={titleDraft}
            setDraft={setDraftFor(setTitleDrafts, c.sha)}
            onSave={(t) => saveTitle(data.pr, t)}
            onCancel={() => setDraftFor(setTitleDrafts, c.sha)(null)}
          />
        ) : (
          <div className="pr-title-row">
            <h1 className="pr-title">
              <span className="pr-title-text">{data.pr.title}</span> <span className="pr-number">#{data.index + 1}</span>
              {data.pr.title_source === 'override' && <> <EditedMarker what="title" original={data.pr.commit_subject} onRevert={() => savePr({ title: null })} /></>}
            </h1>
            <div className="pr-nav">
              <CopyButton text={data.pr.title} label="Copy title" />
              <button className="btn btn-sm" title="Edit the PR title (saved locally, the commit is unchanged)" onClick={() => setDraftFor(setTitleDrafts, c.sha)({ base: data.pr.title, text: data.pr.title })}>Edit</button>
              <span className="pr-nav-sep" aria-hidden="true" />
              <button className="btn btn-sm" disabled={!data.prev} onClick={() => goTo(data.prev)} title={`Previous commit in the project (k)${data.prev && data.prev.repo !== loc.repo ? ` · ${data.prev.repo}` : ''}`}>← Prev</button>
              <button className="btn btn-sm" disabled={!data.next} onClick={() => goTo(data.next)} title={`Next commit in the project (j)${data.next && data.next.repo !== loc.repo ? ` · ${data.next.repo}` : ''}`}>Next →</button>
            </div>
          </div>
        )}
        <div className="pr-meta">
          <ReadinessControl status={status} progress={progress} github={data.pr.github ?? github} busy={statusBusy} onSet={setStatus} mergedTip={landedTip(c.landed)} />
          <span>
            commit <strong>{data.index + 1}</strong> of {data.total} in <strong>{data.repo}</strong> ·{' '}
            {branch ? (
              <>
                <span className="pr-branch">
                  {base && <><span className="branch-name is-base" title={base.title}>{base.name}</span><span className="pr-branch-arrow" aria-hidden="true">←</span></>}
                  <span className={`branch-name is-${branch.status}`} title={`${branch.name}\n${c.sha}${branchNote(branch) ? `\n${branchNote(branch)}` : ''}`}>{branch.name}</span>
                  <BranchStatusMarker branch={branch} />
                  <CopyButton text={branch.name} label="Copy branch name" className="btn-octicon btn-copy-branch" />
                </span>
              </>
            ) : (
              <span className="branch-name" title="The repo's range end (this commit has no branch of its own)">{data.branch}</span>
            )}
            {github && status !== 'published' && status !== 'merged' && <> <PrBadge github={github} /></>} · <strong>{c.author}</strong> committed{' '}
            <span title={c.date}>{relativeTime(c.date)}</span>
            {c.landed?.at && <> · merged <span title={c.landed.at}>{relativeTime(c.landed.at)}</span>{c.landed.method && <> ({c.landed.method})</>}</>}
            {' '}· <code className="sha" title={c.sha} onClick={() => navigator.clipboard?.writeText(c.sha)}>{c.short}</code>
          </span>
        </div>
        {c.landed && c.landed.diff !== 'merge-base' && (
          <div className="flash landed-note" role="status">
            {c.landed.diff === 'merge-commit'
              ? <>This PR's head or base isn't in the local repo, so this is the merge commit's diff (<code>{c.landed.commit?.slice(0, 8)}</code> against its first parent).</>
              : <>Neither this PR's head and base nor its merge commit is in the local repo, so there's no diff to show. Fetching them would bring it back.</>}
          </div>
        )}
        {group && stackCommits.length > 0 && <StackStepper loc={loc} group={group} commits={stackCommits} current={c.sha} tab={tab} next={data.next} />}
        {actionError && <div className="flash flash-error" role="alert">{actionError} <button className="btn-link" onClick={() => setActionError(null)}>Dismiss</button></div>}
        {data.pr.parse_error && <div className="flash flash-error">PR file <code>{data.pr.file}</code> is not valid YAML, so the commit message is shown instead: {data.pr.parse_error}</div>}
        {review.parse_error && <div className="flash flash-error">Review file <code>{review.file}</code> is not valid YAML, so it's shown empty and won't be overwritten: {review.parse_error}</div>}
      </div>

      <div className="tabnav">
        <button className={`tabnav-tab ${tab === 'conversation' ? 'selected' : ''}`} onClick={() => go('conversation')}>
          💬 Conversation <span className="Counter">{review.threads.length}</span>
        </button>
        <button className={`tabnav-tab ${tab === 'files' ? 'selected' : ''}`} onClick={() => go('files')}>
          ± Files changed <span className="Counter">{c.files.length}</span>
        </button>
        <button className={`tabnav-tab ${tab === 'stack' ? 'selected' : ''}`} onClick={() => go('stack')} title="A picture of the PR stacks with this PR highlighted, to copy or download">
          ▤ Stack
        </button>
        <span className="spacer" />
        <span className="tabnav-extra">
          <span className="color-add">+{c.additions}</span> <span className="color-del">−{c.deletions}</span>
        </span>
      </div>

      {tab === 'stack' ? (
        <StackTab loc={loc} sha={c.sha} version={vizVersion} />
      ) : tab === 'conversation' ? (
        <Conversation
          data={data}
          loc={loc}
          review={review}
          actions={actions}
          onNew={(body) => wrap(api.newThread(loc, c.sha, { body }))}
          context={<ProjectContextBox slug={loc.project} repo={loc.repo} intro={projectIntro} group={group} file={projectFile} />}
          desc={{
            fullBody: fullPrBody({ intro: projectIntro, stackNote: group?.description, body: data.pr.body }),
            pr: data.pr,
            draft: bodyDraft,
            setDraft: setDraftFor(setBodyDrafts, c.sha),
            onSave: (b) => saveBody(data.pr, b),
            onRevert: () => savePr({ body: null }),
          }}
        />
      ) : (
        <FilesChanged
          files={c.files}
          review={review}
          actions={actions}
          focusFile={route.file}
          onFocusFile={(p) => navigate(routeUrl(loc.project, loc.repo, sha, 'files', p), true)}
          newThread={(d: Draft, body) => wrap(api.newThread(loc, c.sha, { ...d, body }))}
          setViewed={setViewed}
        />
      )}
    </div>
  );
}

/** The Merged pill's tooltip: what landed, and how. */
function landedTip(l: LandedInfo | null | undefined): string | undefined {
  if (!l) return undefined;
  return [
    l.at && `Merged ${l.at}${l.method ? ` (${l.method})` : ''}`,
    l.commit && `Merge commit ${l.commit.slice(0, 8)}`,
    l.diff === 'merge-base' ? `Diff: merge-base(base ${l.base?.slice(0, 8)}, head ${l.head?.slice(0, 8)})...head` : l.diff === 'merge-commit' ? 'Diff: the merge commit against its first parent' : 'No diff available',
  ].filter(Boolean).join('\n');
}

/**
 * What this commit's PR merges into: the GitHub PR's base, else the branch of the commit before it in the repo
 * (stacked PRs), else the repo's base ref for the first commit.
 */
function prBase(github: GithubInfo | null, repoData: RepoData | undefined, sha: string): { name: string; title: string } | null {
  if (github?.base) return { name: github.base, title: `Base of GitHub PR #${github.number}` };
  const i = repoData?.commits.findIndex((x) => x.sha === sha) ?? -1;
  if (i > 0) {
    const prev = repoData!.commits[i - 1].branch;
    return prev ? { name: prev.name, title: `Base: the previous commit's branch (stacked)` } : null;
  }
  if (i === 0 && repoData?.base) return { name: repoData.base, title: "Base: the repo's base ref in project.yaml" };
  return null;
}

/** This PR stack as a compact stepper (2 · [3] · 4) in the stack's colour, numbered like the sidebar. */
function StackStepper({ loc, group, commits, current, tab, next }: { loc: Loc; group: StackGroup; commits: CommitSummary[]; current: string; tab: Route['tab']; next: { repo: string; sha: string } | null }) {
  const idx = commits.findIndex((x) => x.sha === current);
  const go = (cm: CommitSummary) => { navigate(routeUrl(loc.project, loc.repo, cm.short, tab)); window.scrollTo(0, 0); };
  return (
    <nav className={`stack-stepper ${group.implicit === 'unstacked' ? 'unstacked' : ''} ${group.follow_on ? 'follow-on' : ''}`} aria-label="Commits in this PR stack" style={{ ['--stack' as string]: stackColor(group.color) }}>
      <span className="stepper-label" title={group.warning}>
        {group.title} · PR {idx + 1} of {commits.length}
        {group.follow_on && <FollowOnBadge />}
      </span>
      <ol className="stepper">
        {commits.map((cm, i) => {
          const cls = ['step', i === idx ? 'current' : '', i < idx ? 'before' : '', `is-${cm.status}`].join(' ');
          return (
            <li key={cm.sha} className={cls}>
              {i > 0 && <span className="step-line" aria-hidden="true" />}
              <a
                href={routeUrl(loc.project, loc.repo, cm.short, tab)}
                title={`#${cm.position} ${cm.title}\n${cm.short} · +${cm.additions} −${cm.deletions}\n${statusTooltip(cm.status, cm.progress, cm.github)}`}
                aria-current={i === idx ? 'step' : undefined}
                onClick={(e) => { e.preventDefault(); go(cm); }}
              >
                {cm.position}
                <ReadinessBadge status={cm.status} progress={cm.progress} github={cm.github} size={14} title="" />
              </a>
            </li>
          );
        })}
      </ol>
      {idx >= 0 && idx < commits.length - 1 && (
        <span className="stepper-next muted">
          Next: <button className="btn-link" onClick={() => go(commits[idx + 1])}>{commits[idx + 1].title}</button>
        </span>
      )}
      {idx === commits.length - 1 && <span className="stepper-next muted">{next ? 'End of this stack' : 'End of the project'}</span>}
    </nav>
  );
}

/** The PR description: the first comment box of the Conversation, with Edit / copy / "…" in its header. */
interface DescProps {
  pr: PrInfo;
  draft?: PrDraft;
  setDraft: (d: PrDraft | null) => void;
  onSave: (body: string) => Promise<unknown>;
  onRevert: () => Promise<unknown>;
  /** "Copy full PR body": project intro, stack note, separator, this description */
  fullBody: string;
}

/** Header extras of the PR description box: "edited", and Copy / Edit / "…" (hidden while editing). */
function DescriptionHeader({ pr, draft, setDraft, onRevert, fullBody }: DescProps) {
  const edit = () => setDraft({ base: pr.body, text: pr.body });
  return (
    <>
      {pr.body_source === 'override' && !draft && <EditedMarker what="description" original={pr.commit_body} onRevert={onRevert} />}
      <span className="spacer" />
      <span className="Label">Author</span>
      {!draft && (
        <span className="comment-actions">
          <CopyButton text={fullBody} label={FULL_BODY_TIP} className="btn-octicon" caption="Full body" />
          <CopyButton text={pr.body} label="Copy description (Markdown)" className="btn-octicon" />
          <EditIconButton label="Edit description" onClick={edit} />
          <DescriptionMenu pr={pr} onEdit={edit} onRevert={onRevert} fullBody={fullBody} />
        </span>
      )}
    </>
  );
}

function Conversation({ data, loc, review, actions, onNew, desc, context }: { data: CommitResponse; loc: Loc; review: Review; actions: ThreadActions; onNew: (body: string) => Promise<unknown>; desc: DescProps; context: React.ReactNode }) {
  const { pr, draft, setDraft, onSave } = desc;
  const c = data.commit;
  const filesByPath = useMemo(() => new Map(c.files.map((f) => [f.path, f])), [c.files]);
  const threads = useMemo(() => {
    const ts = review.threads.map((t, i) => ({ t, i, at: t.comments[0]?.created ? Date.parse(t.comments[0].created) : NaN }));
    ts.sort((a, b) => (Number.isNaN(a.at) || Number.isNaN(b.at) ? a.i - b.i : a.at - b.at || a.i - b.i));
    return ts.map((x) => x.t);
  }, [review.threads]);

  // Resolved threads fold GitHub-style: each consecutive run becomes one "N resolved conversations" row that
  // expands (one way) on click. Page-only state, reset per commit. A thread seen open on this page never folds
  // (resolving it here mustn't make it vanish), nor does one already expanded.
  const [unfolded, setUnfolded] = useState<{ sha: string; ids: Set<string> }>({ sha: c.sha, ids: new Set() });
  const seenOpen = useRef<{ sha: string; ids: Set<string> }>({ sha: c.sha, ids: new Set() });
  if (seenOpen.current.sha !== c.sha) seenOpen.current = { sha: c.sha, ids: new Set() };
  for (const t of threads) if (!t.resolved) seenOpen.current.ids.add(t.id);
  const shown = unfolded.sha === c.sha ? unfolded.ids : null;
  const expand = (ts: Thread[]) => setUnfolded((u) => ({ sha: c.sha, ids: new Set([...(u.sha === c.sha ? u.ids : []), ...ts.map((t) => t.id)]) }));
  const timeline: ({ kind: 'thread'; t: Thread } | { kind: 'fold'; threads: Thread[] })[] = [];
  for (const t of threads) {
    const folds = t.resolved && !seenOpen.current.ids.has(t.id) && !shown?.has(t.id);
    const last = timeline[timeline.length - 1];
    if (!folds) timeline.push({ kind: 'thread', t });
    else if (last?.kind === 'fold') last.threads.push(t);
    else timeline.push({ kind: 'fold', threads: [t] });
  }

  const renderThread = (t: Thread) =>
    t.path ? (
      <div className="timeline-item" key={t.id}>
        <Avatar author={t.comments[0]?.author ?? reviewer.id} size={40} />
        <div className="timeline-review">
          <div className="timeline-review-header">
            <AuthorLabel author={t.comments[0]?.author ?? 'unknown'} />
            <span className="muted">commented {relativeTime(t.comments[0]?.created)} on</span>
            <button className="btn-link file-link" onClick={() => navigate(routeUrl(loc.project, loc.repo, c.short, 'files', t.path))}>
              {t.path}
              {t.line ? `:${mixedRange(t) ? `${t.start_side === 'left' ? '-' : '+'}${t.start_line} to ${t.side === 'left' ? '-' : '+'}` : t.start_line ? `${t.start_line}-` : ''}${t.line}` : ''}
            </button>
          </div>
          <ThreadView thread={t} actions={actions} context={<Snippet file={filesByPath.get(t.path)} thread={t} />} />
        </div>
      </div>
    ) : (
      <GeneralThread key={t.id} t={t} actions={actions} />
    );

  return (
    <div className="conversation">
      <div className="timeline">
        <div className="timeline-item project-context-item">
          <span className="avatar-spacer" aria-hidden="true" />
          {context}
        </div>
        <div className="timeline-item">
          <Avatar author={c.author} size={40} />
          <div className={`timeline-comment pr-description ${draft ? 'is-editing' : ''}`}>
            <div className="comment-header">
              <strong>{c.author}</strong>
              <span className="muted">committed <span title={c.date}>{relativeTime(c.date)}</span></span>
              <DescriptionHeader {...desc} />
            </div>
            {draft ? (
              <BodyEditor pr={pr} draft={draft} setDraft={setDraft} onSave={onSave} onCancel={() => setDraft(null)} />
            ) : (
              <div className="timeline-comment-body">
                <Markdown text={pr.body} />
              </div>
            )}
          </div>
        </div>

        <div className="timeline-event">
          <span className="timeline-badge">⎇</span>
          <span>
            <code className="sha">{c.short}</code> changes <strong>{c.files.length}</strong> file{c.files.length === 1 ? '' : 's'}{' '}
            <span className="color-add">+{c.additions}</span> <span className="color-del">−{c.deletions}</span> ·{' '}
            <button className="btn-link" onClick={() => navigate(routeUrl(loc.project, loc.repo, c.short, 'files'))}>View files</button>
          </span>
        </div>

        {timeline.map((x) =>
          x.kind === 'fold' ? (
            <ResolvedFold key={`fold-${x.threads[0].id}`} threads={x.threads} onExpand={() => expand(x.threads)} />
          ) : (
            renderThread(x.t)
          ),
        )}

        <div className="timeline-item new-comment">
          <Avatar author={reviewer.id} size={40} />
          <div className="timeline-comment">
            <div className="comment-header"><strong>Add a comment</strong></div>
            <CommentForm onSubmit={onNew} />
          </div>
        </div>
        <p className="yaml-hint muted">
          Comments are stored in <code>{review.file}</code>. An agent can reply by appending to a thread's <code>comments</code> with <code>author: claude</code>; it shows up here live.
        </p>
      </div>
      <aside className="conversation-sidebar">
        <div className="sidebar-section">
          <h3>Files</h3>
          <ul className="sidebar-files">
            {c.files.map((f) => (
              <li key={f.path}>
                <StatusIcon status={f.status} />
                <button className="btn-link" title={f.path} onClick={() => navigate(routeUrl(loc.project, loc.repo, c.short, 'files', f.path))}>{f.path.split('/').pop()}</button>
                {review.viewed.includes(f.path) && <span className="muted" title="Viewed">✓</span>}
              </li>
            ))}
          </ul>
        </div>
        <div className="sidebar-section">
          <h3>PR title &amp; description</h3>
          <p className="muted pr-source">
            {data.pr.title_source === 'override' || data.pr.body_source === 'override'
              ? `${[data.pr.title_source === 'override' && 'Title', data.pr.body_source === 'override' && 'description'].filter(Boolean).join(' and ')} from`
              : 'From the commit message. Edit them above (saved locally) or in'}
          </p>
          <code className="review-file">{data.pr.file}</code>
        </div>
        <div className="sidebar-section">
          <h3>Review file</h3>
          <code className="review-file">{review.file}</code>
        </div>
        {review.patch_id && (
          <div className="sidebar-section">
            <h3>Patch-id</h3>
            <code className="review-file">{review.patch_id.slice(0, 16)}…</code>
          </div>
        )}
      </aside>
    </div>
  );
}

// octicon check-circle-16
const CHECK_CIRCLE = 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm1.5 0a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm10.28-1.72-4.5 4.5a.75.75 0 0 1-1.06 0l-2-2a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018l1.47 1.47 3.97-3.97a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z';

/**
 * A run of resolved threads folded into one row, like GitHub's hidden-items row. It renders none of the
 * threads (no comments, no code context) until clicked; expanding is one way.
 */
function ResolvedFold({ threads, onExpand }: { threads: Thread[]; onExpand: () => void }) {
  const n = threads.length;
  const files = [...new Set(threads.map((t) => t.path?.split('/').pop() ?? 'general'))];
  const where = files.length <= 3 ? files.join(', ') : `${files.slice(0, 3).join(', ')} +${files.length - 3}`;
  return (
    <div className="timeline-fold">
      <button type="button" className="timeline-fold-btn" onClick={onExpand} aria-expanded={false} title={`Show ${n === 1 ? 'it' : `all ${n}`}`}>
        <span className="timeline-fold-chev" aria-hidden="true">▸</span>
        <Octicon d={CHECK_CIRCLE} size={14} className="timeline-fold-icon" />
        <span className="timeline-fold-label">{n} resolved conversation{n === 1 ? '' : 's'}</span>
        <span className="timeline-fold-where muted">{where}</span>
      </button>
    </div>
  );
}

function GeneralThread({ t, actions }: { t: Thread; actions: ThreadActions }) {
  const [first, ...rest] = t.comments;
  if (!first) return null;
  return (
    <div className={`timeline-item ${t.resolved ? 'is-resolved' : ''}`} id={`thread-${t.id}`}>
      <Avatar author={first.author} size={40} />
      <div className="general-thread">
        <CommentView c={first} variant="timeline" onEdit={(b) => actions.edit(t.id, first.id, b)} onDelete={() => actions.remove(t.id, first.id)} />
        <div className="general-replies">
          <ThreadView thread={{ ...t, comments: rest }} actions={actions} />
        </div>
      </div>
    </div>
  );
}

function Snippet({ file, thread }: { file?: FileData; thread: Thread }) {
  if (!file || !thread.line || thread.outdated) return null; // outdated: ThreadView shows the stored anchor
  const content = thread.side === 'left' ? file.oldContent : file.newContent;
  if (content == null) return null;
  const lines = content.split('\n');
  const end = Math.min(thread.line, lines.length);
  // a range spanning old and new lines: show (and highlight) only its end, on thread.side
  const startLine = mixedRange(thread) ? undefined : thread.start_line;
  const start = Math.max(1, startLine ?? end - 3);
  const highlightFrom = startLine ?? thread.line;
  return (
    <div className="snippet">
      <table>
        <tbody>
          {lines.slice(start - 1, end).map((l, i) => {
            const n = start + i;
            const hl = n >= highlightFrom && n <= thread.line!;
            return (
              <tr key={n} className={hl ? `hl ${thread.side === 'left' ? 'hl-del' : 'hl-add'}` : ''}>
                <td className="ln">{n}</td>
                <td className="code">{l || ' '}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const mixedRange = (t: Thread) => !!t.start_line && !!t.start_side && t.start_side !== (t.side ?? 'right');
