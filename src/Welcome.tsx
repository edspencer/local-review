// The first-run page (no projects yet) and the strip that marks the example projects. The examples are made by the
// server (server/examples.ts): create-only, and "remove" renames each project.yaml to a .bak, so nothing is deleted.
import { useState } from 'react';
import markUrl from '../brand/mark.svg';
import { api, type ProjectsResponse } from './api';
import { navigate, useTilde } from './util';

const DOCS = 'https://local-review.edspencer.net';

export function CopyLine({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-line">
      <code>{text}</code>
      <button
        type="button"
        className="btn-octicon"
        title={`Copy ${label ?? 'command'}`}
        onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
      >
        {copied ? '✓ copied' : '⧉ copy'}
      </button>
    </div>
  );
}

// octicons telescope-16 and git-pull-request-16
const TELESCOPE = 'M14.184 1.143v-.001l1.422 2.464a1.75 1.75 0 0 1-.757 2.451L3.104 11.713a1.75 1.75 0 0 1-2.275-.702l-.447-.775a1.75 1.75 0 0 1 .53-2.32L11.682.573a1.748 1.748 0 0 1 2.502.57Zm-4.709 9.32h-.001l2.644 3.863a.75.75 0 1 1-1.238.848l-1.881-2.75v2.826a.75.75 0 0 1-1.5 0v-2.826l-1.881 2.75a.75.75 0 1 1-1.238-.848l2.049-2.992a.746.746 0 0 1 .293-.253l1.809-.87a.749.749 0 0 1 .944.252ZM9.436 3.92h-.001l-4.97 3.39.942 1.63 5.42-2.61Zm3.091-2.108h.001l-1.85 1.26 1.505 2.605 2.016-.97a.247.247 0 0 0 .13-.151.247.247 0 0 0-.022-.199l-1.422-2.464a.253.253 0 0 0-.161-.119.254.254 0 0 0-.197.038ZM1.756 9.157a.25.25 0 0 0-.075.33l.447.775a.25.25 0 0 0 .325.1l1.598-.769-.83-1.436-1.465 1Z';
const PR = 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z';
const Icon = ({ d }: { d: string }) => (
  <span className="welcome-icon" aria-hidden="true">
    <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d={d} /></svg>
  </span>
);

const EXAMPLE_REPOS: [string, string][] = [
  ['orchard-api', 'Go'],
  ['orchard-sdk', 'TypeScript'],
  ['orchard-web', 'React'],
  ['orchard-infra', 'Terraform'],
];

/** The add-the-examples button and its result or error. `onAdded` gets the slug to open. */
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
    <>
      <button className="btn btn-plum" onClick={add} disabled={busy}>
        {busy ? 'Creating the examples…' : removed ? 'Bring back the example projects' : 'Add the example projects'}
      </button>
      {error && <div className="flash flash-error welcome-error" role="alert">{error}</div>}
    </>
  );
}

export function Welcome({ list, notice, onChanged }: { list: ProjectsResponse; notice?: string | null; onChanged: () => Promise<unknown> | void }) {
  const tilde = useTilde();
  const removed = list.examples === 'removed';
  return (
    <div className="page welcome">
      {notice && <div className="flash welcome-notice" role="status">{notice}</div>}
      <section className="welcome-hero">
        <img src={markUrl} alt="" width={56} height={56} />
        <div>
          <div className="welcome-eyebrow">Welcome to Local Review</div>
          <h1>Review your agent's commits like pull requests, before anything goes to GitHub.</h1>
          <p>
            Every commit is a PR, grouped into stacks across your repos. Your comments are plain YAML files next to the work, so
            your coding agent can read them and answer in the thread.
          </p>
        </div>
      </section>

      <div className="welcome-cards">
        <section className="welcome-card is-tour">
          <h2>
            <Icon d={TELESCOPE} /> Look around an example
          </h2>
          <p>
            <strong>Orchard</strong> is a made-up booking app for fitness studios. Its three example projects have stacked PRs
            across four repos, review threads, an agent's replies and a fully merged stack.
          </p>
          <ul className="welcome-repos" aria-label="The example repos">
            {EXAMPLE_REPOS.map(([name, lang]) => (
              <li key={name}>
                <code>{name}</code> <span>{lang}</span>
              </li>
            ))}
          </ul>
          <AddExamples removed={removed} onAdded={(slug) => Promise.resolve(onChanged()).then(() => navigate(slug ? `/${encodeURIComponent(slug)}` : '/'))} />
          <p className="welcome-fine">
            {removed
              ? "You removed them earlier. They come back as you left them, with any comments you wrote."
              : <>Takes about a second, with no network: it writes four small git repos and the projects into <code>{tilde(list.projectsDir.replace(/[\\/]projects$/, ''))}</code>.</>}{' '}
            Remove them again any time: they're hidden, never deleted.
          </p>
        </section>

        <section className="welcome-card">
          <h2>
            <Icon d={PR} /> Review your own work
          </h2>
          <ol className="welcome-steps">
            <li>
              Create a project
              <CopyLine text="npx local-review init my-feature" />
            </li>
            <li>
              Point it at your repos: set each one's <code>path</code> and <code>branch</code> in
              <code className="welcome-path">{tilde(list.projectsDir)}/my-feature/project.yaml</code>
            </li>
            <li>It shows up here as soon as you save. No restart.</li>
          </ol>
          <div className="welcome-agent">
            <div className="welcome-agent-label">Or ask your coding agent</div>
            <CopyLine label="prompt" text="Run `npx local-review guide`, then set up a Local Review project for the branch you're on." />
          </div>
        </section>
      </div>

      <footer className="welcome-links">
        <a href={`${DOCS}/getting-started/quickstart/`} target="_blank" rel="noreferrer">Quickstart</a>
        <a href={`${DOCS}/reference/project-yaml/`} target="_blank" rel="noreferrer">project.yaml</a>
        <a href={`${DOCS}/agents/agent-guide/`} target="_blank" rel="noreferrer">Working with agents</a>
        <span className="welcome-promise" title="Local Review never modifies your repos, never deletes your review data, and only listens on 127.0.0.1">
          Read-only on your repos · never deletes your data · localhost only
        </span>
      </footer>
    </div>
  );
}

/** At the top of the sidebar on an example project: what it is, and a way to remove all of them (after a confirm). */
export function ExamplesStrip({ count, onRemoved }: { count: number; onRemoved: () => void }) {
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
    <div className="examples-strip" role="note">
      <div className="examples-strip-head">
        <span className="example-tag">Example</span>
        <span>Made-up data to explore.</span>
      </div>
      {confirming ? (
        <div className="examples-strip-confirm">
          <span>
            Remove the {count} example project{count === 1 ? '' : 's'}? Your own projects aren't touched, and nothing is deleted.
          </span>
          <span className="examples-strip-actions">
            <button className="btn btn-sm btn-danger-outline" onClick={remove} disabled={busy}>{busy ? 'Removing…' : 'Remove'}</button>
            <button className="btn btn-sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
          </span>
        </div>
      ) : (
        <button className="btn-link examples-strip-remove" onClick={() => setConfirming(true)}>Remove examples</button>
      )}
      {error && <div className="flash flash-error" role="alert">{error}</div>}
    </div>
  );
}

/**
 * The last item in the project switcher, once you have projects of your own: "Add example projects" (or "Bring back
 * …" after a remove), or, while they're there, "Remove example projects" with the same inline confirm as the strip.
 */
export function ExamplesMenuItem({ list, onAdded, onRemoved }: { list: ProjectsResponse; onAdded: (slug: string) => void; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tilde = useTilde();
  const present = list.examples === 'present';
  const count = list.projects.filter((p) => p.example).length;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(tilde((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const add = () =>
    run(async () => {
      const r = await api.addExamples();
      onAdded([...r.created, ...r.restored, ...r.existing][0] ?? '');
    });
  const remove = () =>
    run(async () => {
      await api.removeExamples();
      setConfirming(false);
      onRemoved();
    });
  return (
    <li className="project-menu-section project-menu-examples" role="presentation">
      {present && confirming ? (
        <div className="project-menu-examples-confirm">
          <span>Remove the {count} example project{count === 1 ? '' : 's'}? Nothing is deleted.</span>
          <span className="examples-strip-actions">
            <button className="btn btn-sm btn-danger-outline" onClick={remove} disabled={busy}>{busy ? 'Removing…' : 'Remove'}</button>
            <button className="btn btn-sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
          </span>
        </div>
      ) : (
        <button type="button" className="project-menu-examples-btn" onClick={present ? () => setConfirming(true) : add} disabled={busy}>
          <span className="example-tag">Example</span>
          {present ? 'Remove example projects' : busy ? 'Adding example projects…' : list.examples === 'removed' ? 'Bring back the example projects' : 'Add example projects'}
        </button>
      )}
      {error && <div className="flash flash-error project-menu-examples-error" role="alert">{error}</div>}
    </li>
  );
}
