import type { GithubInfo } from './api';
import { PrBadge } from './Branch';
import { progressFraction, progressText, statusTooltip, type PrStatus, type Progress } from '../shared/readiness';

// octicon git-pull-request-16
const PR_ICON = 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z';

// octicon git-merge-16
const MERGE_ICON = 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z';

/** A pie wedge from 12 o'clock, clockwise, as an SVG path (0 < f < 1). */
function wedge(f: number, r: number, c = 8): string {
  const a = 2 * Math.PI * f;
  const x = c + r * Math.sin(a);
  const y = c - r * Math.cos(a);
  return `M${c} ${c}V${c - r}A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
}

/**
 * A PR's readiness as one small round badge: a progress pie while it's a draft (a full pie at 100%, still a
 * draft until the reviewer marks it ready), a white tick on green once ready, the PR icon on blue once published, and
 * GitHub's merge icon on its merged purple once it has landed.
 * The tooltip has the details (`title=""`: decorative, next to a label that says it).
 */
export function ReadinessBadge({ status, progress, github, size = 16, title }: { status: PrStatus; progress?: Progress | null; github?: GithubInfo | null; size?: number; title?: string }) {
  const tip = title ?? statusTooltip(status, progress ?? null, github);
  let inner: React.ReactNode;
  if (status === 'published' || status === 'merged') {
    inner = (
      <>
        <circle cx="8" cy="8" r="8" className="rb-fill" />
        <path d={status === 'merged' ? MERGE_ICON : PR_ICON} transform="translate(3.1 3.1) scale(0.6125)" className="rb-mark" />
      </>
    );
  } else if (status === 'ready') {
    inner = (
      <>
        <circle cx="8" cy="8" r="8" className="rb-fill" />
        <path d="M4.6 8.3 6.9 10.6 11.4 5.8" fill="none" className="rb-mark" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  } else {
    const f = progress ? Math.max(0, Math.min(1, progressFraction(progress))) : 0;
    inner = (
      <>
        <circle cx="8" cy="8" r="7.25" className="rb-ring" fill="none" strokeWidth="1.4" />
        {f >= 1 ? <circle cx="8" cy="8" r="5.5" className="rb-pie" /> : f > 0 ? <path d={wedge(f, 5.5)} className="rb-pie" /> : null}
      </>
    );
  }
  return (
    <span className={`readiness-badge is-${status}`} {...(tip ? { title: tip, role: 'img', 'aria-label': tip } : { 'aria-hidden': true })}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">{inner}</svg>
    </span>
  );
}

/**
 * The commit page's readiness control, where GitHub has its Open / Draft state: a Draft | Ready segmented toggle
 * (writes `status:` to the prs file), or "Published" with the PR link once a `github:` record exists, or a purple
 * "Merged" once a `landed:` record does, and the review progress next to it.
 */
export function ReadinessControl({ status, progress, github, busy, onSet, mergedTip }: { status: PrStatus; progress: Progress; github: GithubInfo | null; busy: boolean; onSet: (s: 'draft' | 'ready') => void; mergedTip?: string }) {
  return (
    <span className="readiness-control">
      {status === 'published' || status === 'merged' ? (
        <span className={`State State--${status}`} title={[statusTooltip(status, progress, github), status === 'merged' ? mergedTip : ''].filter(Boolean).join('\n')}>
          <ReadinessBadge status={status} github={github} size={14} title="" /> {status === 'merged' ? 'Merged' : 'Published'}
          {github && <PrBadge github={github} />}
        </span>
      ) : (
        <span className="readiness-toggle" role="radiogroup" aria-label="PR readiness (saved in the prs file)">
          {(['draft', 'ready'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={status === s}
              className={`readiness-opt is-${s} ${status === s ? 'selected' : ''}`}
              disabled={busy}
              title={s === 'ready' ? 'Mark as ready: reviewed and fine to publish (writes status: ready)' : 'Back to draft (removes status:)'}
              onClick={() => status !== s && onSet(s)}
            >
              {s === 'ready' && <ReadinessBadge status="ready" size={14} title="" />}
              {s === 'ready' ? 'Ready' : 'Draft'}
            </button>
          ))}
        </span>
      )}
      <span className="readiness-progress" title={progressText(progress)}>
        {status === 'published' || status === 'merged' ? null : <ReadinessBadge status="draft" progress={progress} size={14} title="" />}
        {progress.resolved + progress.viewed} of {progress.threads + progress.files} done
      </span>
    </span>
  );
}

export const FOLLOW_ON_TIP = 'Follow-on stack: parked work, held back from the stacks going up now (project.yaml follow_on: true). Review it as normal; `local-review plan` leaves it out unless asked.';

/** The small "follow-on" pill on a held-back stack's title and on each of its PRs. */
export function FollowOnBadge({ className = '' }: { className?: string }) {
  return <span className={`Label Label--follow-on ${className}`} title={FOLLOW_ON_TIP}>follow-on</span>;
}
