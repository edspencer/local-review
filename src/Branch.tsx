import type { BranchInfo, GithubInfo } from './api';
import { Octicon } from './Comments';

// octicon alert-16
const ALERT = 'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z';

/** How many trailing characters a middle-truncated branch name always keeps (the distinctive end). */
const TAIL = 12;

/**
 * A branch name, truncated in the middle when it doesn't fit (`me/feature/02-fl…ag-parser`): the head
 * shrinks with an ellipsis, the last few characters always show. Pure CSS, so it adapts to the sidebar width.
 */
export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  const cut = text.length > TAIL + 4 ? text.length - TAIL : text.length;
  return (
    <span className={`mid-trunc ${className ?? ''}`}>
      <span className="mid-trunc-head">{text.slice(0, cut)}</span>
      {cut < text.length && <span className="mid-trunc-tail">{text.slice(cut)}</span>}
    </span>
  );
}

/** One line describing the branch's state, for tooltips; null when there's nothing to say. */
export function branchNote(b: BranchInfo | null | undefined): string | null {
  if (!b) return null;
  const others = b.discovered.filter((d) => d !== b.name);
  const also = others.length ? `\nAlso at this commit: ${others.join(', ')}` : '';
  if (b.status === 'moved') return `Branch ${b.name} has moved: it now points at ${b.points_at ? b.points_at.slice(0, 8) : 'another commit'}, not this commit${also}`;
  if (b.status === 'missing') return `Branch ${b.name} no longer exists in git${also}`;
  if (b.status === 'discovered') return `Branch ${b.name} (found in git, not recorded)${also}`;
  if (b.follow_ups) return `Branch ${b.name} is at this PR's head, ${b.follow_ups} follow-up commit${b.follow_ups === 1 ? '' : 's'} above its first${also}`;
  if (b.status === 'merged') return `Branch ${b.name}: merged on GitHub (it may be deleted by now; that's fine)`;
  return also ? also.slice(1) : null;
}

/** A small warning icon for a moved or missing branch (nothing otherwise). */
export function BranchStatusMarker({ branch }: { branch: BranchInfo | null | undefined }) {
  if (!branch || (branch.status !== 'moved' && branch.status !== 'missing')) return null;
  const note = branchNote(branch)!;
  return (
    <span className={`branch-status branch-status-${branch.status}`} title={note} aria-label={note} role="img">
      <Octicon d={ALERT} size={11} />
    </span>
  );
}

/**
 * GitHub's PR number as a small muted badge, `#1234 ↗`, opening the PR in a new tab. `asSpan` renders it as a
 * span with link behaviour, for use inside another link (the sidebar rows are <a>s; links can't nest).
 */
export function PrBadge({ github, asSpan }: { github: GithubInfo | null | undefined; asSpan?: boolean }) {
  if (!github) return null;
  const label = `#${github.number}`;
  const title = `GitHub PR ${label}${github.base ? ` into ${github.base}` : ''}\n${github.url}`;
  const body = (
    <>
      {label}
      <span className="pr-badge-ext" aria-hidden="true">↗</span>
    </>
  );
  if (!asSpan)
    return (
      <a className="pr-badge" href={github.url} target="_blank" rel="noreferrer noopener" title={title}>
        {body}
      </a>
    );
  const open = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(github.url, '_blank', 'noopener,noreferrer');
  };
  return (
    <span
      className="pr-badge"
      role="link"
      tabIndex={0}
      title={title}
      onClick={open}
      onAuxClick={(e) => { if (e.button === 1) open(e); }}
      onKeyDown={(e) => { if (e.key === 'Enter') open(e); }}
    >
      {body}
    </span>
  );
}
