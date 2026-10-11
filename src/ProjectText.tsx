// The project intro (project.yaml `description:`) and per-stack notes (`stacks[].description:`): shown and
// edited in place on the project and stack pages and in the context boxes above them (stack and PR pages), with the
// same editor as the PR description. Saved into project.yaml by the server (the rest of the file is kept as it is).
// Nothing here generates text: it only shows, edits and composes what's in the file.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, stackColor, type RepoData, type StackGroup } from './api';
import { aggregate, type Aggregate, type Summary } from '../shared/totals';
import { Markdown, Octicon } from './Comments';
import { CopyButton, EditIconButton, MarkdownFieldEditor, type PrDraft } from './PrEdit';
import { normBody } from './prText';
import { linkTo, projectUrl, stackUrl, useLocalStorage, useTilde } from './util';
import { stackLabel } from './Stacks';
import { stackRef } from '../shared/stackRef';

/** Drafts of intro / stack-note edits, kept above the pages so they survive switching tabs, commits and pages. */
interface TextDrafts {
  drafts: Record<string, PrDraft>;
  setDraft: (key: string, d: PrDraft | null) => void;
  /** reload the project after a save (the SSE echo follows anyway) */
  refresh: () => void;
}
const Ctx = createContext<TextDrafts>({ drafts: {}, setDraft: () => {}, refresh: () => {} });

export function TextDraftsProvider({ refresh, children }: { refresh: () => void; children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, PrDraft>>({});
  const setDraft = useCallback((key: string, d: PrDraft | null) => setDrafts((m) => { const n = { ...m }; if (d) n[key] = d; else delete n[key]; return n; }), []);
  const dirty = Object.values(drafts).some((d) => normBody(d.text) !== normBody(d.base));
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return <Ctx.Provider value={{ drafts, setDraft, refresh }}>{children}</Ctx.Provider>;
}

/**
 * A markdown text from project.yaml with Copy / Edit; Edit swaps it for the description editor. `text` is the
 * saved value (null or blank: not set, `empty` is shown instead). `frame="comment"` draws it as a timeline comment
 * box, like the PR description (the stack and project pages); the default is a plain block (the context boxes).
 */
export function EditableText({ draftKey, label, text, what, placeholder, empty, file, save, className, frame = 'plain', extraActions }: {
  draftKey: string;
  label?: ReactNode;
  text: string | null | undefined;
  what: string;
  placeholder: string;
  empty?: ReactNode;
  file: string;
  save: (text: string | null) => Promise<unknown>;
  className?: string;
  frame?: 'plain' | 'comment';
  /** more buttons beside Copy / Edit (hidden while editing) */
  extraActions?: ReactNode;
}) {
  const { drafts, setDraft, refresh } = useContext(Ctx);
  const tilde = useTilde();
  const draft = drafts[draftKey];
  const current = normBody(text ?? '');
  const set = (d: PrDraft | null) => setDraft(draftKey, d);
  const edit = () => set({ base: current, text: current });
  const onSave = async (t: string) => {
    const b = normBody(t);
    if (b !== current) await save(b.trim() ? b : null);
    set(null);
    refresh();
  };
  const actions = !draft && (
    <span className="comment-actions">
      {extraActions}
      {current && <CopyButton text={current} label={`Copy ${what} (Markdown)`} className="btn-octicon" />}
      <EditIconButton label={`Edit ${what}`} onClick={edit} />
    </span>
  );
  const editor = draft && (
    <>
      <MarkdownFieldEditor className="ptext-editor" current={current} what={what} placeholder={placeholder} draft={draft} setDraft={set} onSave={onSave} onCancel={() => set(null)} />
      <div className="ptext-hint muted">
        Saved in <code>{tilde(file)}</code> (the rest of the file is kept as it is). ⌘↵ saves, Esc cancels. Empty removes it.
      </div>
    </>
  );
  const shown = current ? <Markdown text={current} /> : <button type="button" className="btn-link" onClick={edit}>{empty ?? `Add ${what}`}</button>;
  if (frame === 'comment')
    return (
      <div className={`timeline-comment ptext ptext-comment ${draft ? 'is-editing' : ''} ${className ?? ''}`}>
        <div className="comment-header">
          {label}
          <span className="spacer" />
          {actions}
        </div>
        <div className={`timeline-comment-body ${current || draft ? '' : 'ptext-empty'}`}>{editor || shown}</div>
      </div>
    );
  return (
    <div className={`ptext ${draft ? 'is-editing' : ''} ${className ?? ''}`}>
      {(label || !draft) && (
        <div className="ptext-head">
          {label && <span className="ptext-label">{label}</span>}
          <span className="spacer" />
          {actions}
        </div>
      )}
      {editor || (current ? <div className="ptext-body">{shown}</div> : <div className="ptext-empty">{shown}</div>)}
    </div>
  );
}

type TextProps = { file: string; label?: ReactNode; className?: string; frame?: 'plain' | 'comment'; extraActions?: ReactNode };

export const introDraftKey = (slug: string) => `intro:${slug}`;

export function IntroText({ slug, text, ...rest }: { slug: string; text: string | null } & TextProps) {
  return (
    <EditableText
      draftKey={introDraftKey(slug)}
      text={text}
      what="project intro"
      placeholder="One or two paragraphs of context for the whole effort. Every full PR body starts with this."
      empty="Add a project intro"
      save={(t) => api.setProjectDescription(slug, t)}
      {...rest}
    />
  );
}

/** Only declared stacks have a place in project.yaml for a note (not Unstacked, not the implicit branch stack). */
export const canHaveNote = (g: StackGroup) => g.number !== null && !g.implicit;

export const stackDraftKey = (slug: string, repo: string, g: StackGroup) => `stack:${slug}:${repo}:${g.number}:${g.title}`;

export function StackNoteText({ slug, repo, group, ...rest }: { slug: string; repo: string; group: StackGroup } & TextProps) {
  return (
    <EditableText
      draftKey={stackDraftKey(slug, repo, group)}
      text={group.description}
      what="stack note"
      placeholder="Context for this stack: how it relates to the other stacks. Comes after the intro in each of its full PR bodies."
      empty="Add a stack note"
      save={(t) => api.setStackDescription(slug, repo, group.number!, group.title, t)}
      {...rest}
    />
  );
}

/** A repo's totals with follow-on stacks and merged PRs left out and counted on the side (shared/totals.ts, as in the stack picture). */
export function repoAggregate(r: RepoData): Aggregate {
  const bySha = new Map(r.commits.map((c) => [c.sha, c]));
  return aggregate(
    r.stacks.map((g) => {
      const cs = g.shas.map((s) => bySha.get(s)).filter((c) => !!c);
      const m = cs.filter((c) => c.landed);
      const sum = (xs: typeof cs) => ({ prs: xs.length, additions: xs.reduce((a, c) => a + c.additions, 0), deletions: xs.reduce((a, c) => a + c.deletions, 0) });
      return { follow_on: g.follow_on, ...sum(cs), merged: sum(m) };
    }),
  );
}

export const MERGED_TOTALS_TIP = 'Merged PRs (landed on GitHub) are left out of these totals; their stacks still show them.';
export const FOLLOW_ON_TOTALS_TIP = 'Follow-on stacks (parked work) are left out of these totals; their own stack headers still show their numbers.';

/** "2 repos · 4 stacks · 12 PRs · +3,477 −155 · +1 follow-on stack (2 PRs)" */
export function TotalsLine({ s, className = '' }: { s: Summary; className?: string }) {
  return (
    <span className={`totals-line ${className}`}>
      {s.counts} · <span className="color-add">+{s.additions.toLocaleString('en-US')}</span> <span className="color-del">−{s.deletions.toLocaleString('en-US')}</span>
      {s.note && <> · <span className="follow-on-note" title={FOLLOW_ON_TOTALS_TIP}>{s.note}</span></>}
      {s.merged && <> · <span className="merged-note" title={MERGED_TOTALS_TIP}>{s.merged}</span></>}
    </span>
  );
}

const CHEV = 'M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z';
/** A collapsed box's one-line summary: the first line of words (links reduced to theirs), else the first image's alt. */
export const firstLine = (s: string) => {
  const IMG = /!\[([^\]]*)\]\([^)]*\)|<img\b[^>]*>/g;
  const words = s
    .replace(IMG, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[#>*_`]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  const alt = /!\[([^\]]+)\]\(/.exec(s)?.[1].trim();
  return words ?? (alt ? `[image: ${alt}]` : '');
};

/** One collapsible, labelled context section (project or stack), with a link to the page the text belongs to. */
function ContextSection({ kind, title, summary, empty, href, linkLabel, open, setOpen, editing, style, children }: {
  kind: 'project' | 'stack';
  title: ReactNode;
  summary: string;
  empty: string;
  href: string;
  linkLabel: string;
  open: boolean;
  setOpen: (v: boolean) => void;
  editing: boolean;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const isOpen = open || editing;
  return (
    <section className={`project-context is-${kind} ${isOpen ? 'open' : ''}`} style={style} aria-label={kind === 'project' ? 'Project context' : 'Stack context'}>
      <div className="project-context-head">
        <button type="button" className="project-context-toggle" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)} title={isOpen ? 'Collapse' : 'Expand'}>
          <Octicon d={CHEV} size={12} className="project-context-chev" />
          <span className="project-context-title">{title}</span>
          {!isOpen && <span className="project-context-summary muted">{summary || empty}</span>}
        </button>
        <a className="project-context-link" href={href} onClick={linkTo(href)}>{linkLabel}</a>
      </div>
      {isOpen && <div className="project-context-body">{children}</div>}
    </section>
  );
}

/**
 * The context that flows down to a page, above its own text: the project intro (on stack and PR pages) and the
 * stack note (on PR pages, for a declared stack), as separate collapsible sections, each editable in place and
 * linking to its own page. Open / closed is remembered per kind.
 */
export function ContextBoxes({ slug, repo, intro, group, file }: { slug: string; repo?: string; intro: string | null; group?: StackGroup | null; file: string }) {
  const [projectOpen, setProjectOpen] = useLocalStorage('lr.projectContextOpen', true);
  const [stackOpen, setStackOpen] = useLocalStorage('lr.stackContextOpen', true);
  const { drafts } = useContext(Ctx);
  const note = repo && group && canHaveNote(group) ? group : null;
  return (
    <div className="context-boxes">
      <ContextSection
        kind="project"
        title="Project context"
        summary={firstLine(normBody(intro ?? ''))}
        empty="No intro yet"
        href={projectUrl(slug)}
        linkLabel="Project page"
        open={projectOpen}
        setOpen={setProjectOpen}
        editing={introDraftKey(slug) in drafts}
      >
        <IntroText slug={slug} text={intro} file={file} className="ptext-inline" />
      </ContextSection>
      {note && repo && (
        <ContextSection
          kind="stack"
          title={<>Stack context <span className="project-context-stack">{stackLabel(note)}</span></>}
          summary={firstLine(normBody(note.description ?? ''))}
          empty="No stack note yet"
          href={stackUrl(slug, repo, stackRef(note))}
          linkLabel="Stack page"
          open={stackOpen}
          setOpen={setStackOpen}
          editing={stackDraftKey(slug, repo, note) in drafts}
          style={{ ['--stack' as string]: stackColor(note.color) }}
        >
          <StackNoteText slug={slug} repo={repo} group={note} file={file} className="ptext-inline" />
        </ContextSection>
      )}
    </div>
  );
}
