import { useEffect, useState, type ReactNode } from 'react';
import type { Loc } from './api';

type Scope = 'project' | 'repo' | 'stack';
const SCOPES: [Scope, string, string][] = [
  ['stack', 'This stack', 'Only the stack this PR is in'],
  ['repo', 'This repo', 'Only the stacks of this repo'],
  ['project', 'Whole project', 'Every repo and stack in the project'],
];
const SCOPE_KEY = 'lr.stackScope';
const TITLE_KEY = 'lr.stackTitle'; // global, like the scope: one choice for every PR and project

/**
 * The "Stack" tab: the server-rendered picture of the project's PR stacks with this PR highlighted
 * (GET …/stack.png), to paste next to a real PR. `version` changes whenever the project data does, so the
 * image follows edits to project.yaml, PR titles and new commits.
 */
export function StackTab({ loc, sha, version }: { loc: Loc; sha: string; version: string }) {
  const [scope, setScopeState] = useState<Scope>(() => {
    const s = localStorage.getItem(SCOPE_KEY);
    return s === 'repo' || s === 'project' ? s : 'stack';
  });
  const setScope = (s: Scope) => {
    setScopeState(s);
    localStorage.setItem(SCOPE_KEY, s);
  };
  return (
    <StackPicture
      base={`/api/projects/${encodeURIComponent(loc.project)}/repos/${encodeURIComponent(loc.repo)}/commits/${sha}/stack`}
      query={scope !== 'project' ? `scope=${scope}` : ''}
      version={version}
      alt={`PR stacks of ${loc.project}, with this PR highlighted`}
      hint={<code>…/commits/{sha.slice(0, 8)}/stack.png</code>}
      controls={
        <div className="BtnGroup" role="group" aria-label="What to show">
          {SCOPES.map(([s, label, title]) => (
            <button key={s} className={`btn btn-sm ${scope === s ? 'selected' : ''}`} title={title} aria-pressed={scope === s} onClick={() => setScope(s)}>{label}</button>
          ))}
        </div>
      }
    />
  );
}

/**
 * A stack picture from the server (`base`.png / .svg, with `query`), with the Show title toggle and Copy image /
 * Download PNG / SVG: the PR page's Stack tab, and the stack and project pages' ones. `controls` go first in the toolbar.
 */
export function StackPicture({ base, query = '', version, alt, hint, controls }: { base: string; query?: string; version: string; alt: string; hint: ReactNode; controls?: ReactNode }) {
  const [showTitle, setShowTitleState] = useState(() => localStorage.getItem(TITLE_KEY) !== '0');
  const setShowTitle = (v: boolean) => {
    setShowTitleState(v);
    localStorage.setItem(TITLE_KEY, v ? '1' : '0');
  };
  const [loadError, setLoadError] = useState(false);
  const q = [query, !showTitle && 'title=0'].filter(Boolean).join('&');
  const png = `${base}.png${q ? `?${q}` : ''}`;
  // the cache-busting `v` only changes the URL when the data does, so the <img> re-fetches exactly then
  const shown = `${png}${q ? '&' : '?'}v=${encodeURIComponent(version)}`;
  useEffect(() => setLoadError(false), [shown]);
  const { copy, copyError, copyImage } = useCopyImage(png);

  return (
    <div className="stack-tab">
      <div className="stack-tab-toolbar">
        {controls}
        <label className="stack-tab-check" title="The project title and summary line at the top of the image">
          <input type="checkbox" checked={showTitle} onChange={(e) => setShowTitle(e.target.checked)} /> Show title
        </label>
        <span className="spacer" />
        <ImageActions base={base} q={q} copy={copy} onCopy={copyImage} />
      </div>
      {copy === 'error' && <div className="flash flash-error" role="alert">Couldn't copy the image: {copyError}. Use Download PNG instead.</div>}
      <div className="stack-tab-canvas">
        {loadError ? (
          <div className="flash flash-error">Couldn't render the stack image. See the server log.</div>
        ) : (
          // 680 CSS px wide: the PNG is 2x, so it's crisp on retina screens
          <img src={shown} width={680} alt={alt} onError={() => setLoadError(true)} />
        )}
      </div>
      <p className="stack-tab-hint muted">
        Drawn on the server ({hint}, also <code>.svg</code>). Bars share one square-root scale across the
        image, so stacks and PRs are comparable.
      </p>
    </div>
  );
}

/** Copy the PNG at `url` to the clipboard (ClipboardItem), with a short-lived "copied" / error state. */
export function useCopyImage(url: string) {
  const [copy, setCopy] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const [copyError, setCopyError] = useState<string | null>(null);
  useEffect(() => {
    if (copy !== 'copied' && copy !== 'error') return;
    const t = setTimeout(() => setCopy('idle'), copy === 'copied' ? 1500 : 4000);
    return () => clearTimeout(t);
  }, [copy]);
  const copyImage = async () => {
    setCopy('copying');
    setCopyError(null);
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('this browser cannot copy images (no ClipboardItem)');
      // pass the blob as a promise: Safari only allows clipboard writes started synchronously in the click
      const blob = fetch(url, { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopy('copied');
    } catch (e) {
      setCopyError((e as Error).message);
      setCopy('error');
    }
  };
  return { copy, copyError, copyImage };
}

/** Copy image / Download PNG / SVG, for the picture at `base`.png / .svg with query `q`. */
export function ImageActions({ base, q, copy, onCopy, downloadTitle }: { base: string; q: string; copy: ReturnType<typeof useCopyImage>['copy']; onCopy: () => void; downloadTitle?: string }) {
  const png = `${base}.png${q ? `?${q}` : ''}`;
  return (
    <>
      <button className={`btn btn-sm ${copy === 'copied' ? 'is-copied' : ''}`} onClick={onCopy} disabled={copy === 'copying'} title="Copy the PNG to the clipboard, to paste into a PR description or Slack">
        {copy === 'copied' ? '✓ Copied' : copy === 'copying' ? 'Copying…' : 'Copy image'}
      </button>
      <a className="btn btn-sm" href={`${png}${q ? '&' : '?'}download`} download title={downloadTitle ?? 'Download the PNG (2x, 1360px wide)'}>Download PNG</a>
      <a className="btn-link stack-tab-svg" href={`${base}.svg${q ? `?${q}` : ''}`} target="_blank" rel="noreferrer" title="Open the SVG it is drawn from">SVG</a>
    </>
  );
}
