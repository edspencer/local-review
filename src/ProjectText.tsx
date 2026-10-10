// The project intro (project.yaml `description:`) and per-stack notes (`stacks[].description:`): shown and
// edited in place on the project homepage and in the PR page's "Project context" box, with the same editor
// as the PR description. Saved into project.yaml by the server (the rest of the file is kept as it is).
// Nothing here generates text: it only shows, edits and composes what's in the file.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, stackColor, type RepoData, type StackGroup } from './api';
import { aggregate, type Aggregate, type Summary } from '../shared/totals';
import { Markdown, Octicon } from './Comments';
import { CopyButton, EditIconButton, MarkdownFieldEditor, type PrDraft } from './PrEdit';
import { normBody } from './prText';
import { navigate, useLocalStorage } from './util';

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
 * saved value (null or blank: not set, `empty` is shown instead).
 */
export function EditableText({ draftKey, label, text, what, placeholder, empty, file, save, className }: {
  draftKey: string;
  label?: ReactNode;
  text: string | null | undefined;
  what: string;
  placeholder: string;
  empty?: ReactNode;
  file: string;
  save: (text: string | null) => Promise<unknown>;
  className?: string;
}) {
  const { drafts, setDraft, refresh } = useContext(Ctx);
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
  return (
    <div className={`ptext ${draft ? 'is-editing' : ''} ${className ?? ''}`}>
      {(label || !draft) && (
        <div className="ptext-head">
          {label && <span className="ptext-label">{label}</span>}
          <span className="spacer" />
          {!draft && (
            <span className="comment-actions">
              {current && <CopyButton text={current} label={`Copy ${what} (Markdown)`} className="btn-octicon" />}
              <EditIconButton label={`Edit ${what}`} onClick={edit} />
            </span>
          )}
        </div>
      )}
      {draft ? (
        <>
          <MarkdownFieldEditor className="ptext-editor" current={current} what={what} placeholder={placeholder} draft={draft} setDraft={set} onSave={onSave} onCancel={() => set(null)} />
          <div className="ptext-hint muted">
            Saved in <code>{file}</code> (the rest of the file is kept as it is). ⌘↵ saves, Esc cancels. Empty removes it.
          </div>
        </>
      ) : current ? (
        <div className="ptext-body"><Markdown text={current} /></div>
      ) : (
        <div className="ptext-empty">
          <button type="button" className="btn-link" onClick={edit}>{empty ?? `Add ${what}`}</button>
        </div>
      )}
    </div>
  );
}

export function IntroText({ slug, text, file, label, className }: { slug: string; text: string | null; file: string; label?: ReactNode; className?: string }) {
  return (
    <EditableText
      draftKey={`intro:${slug}`}
      label={label}
      text={text}
      what="project intro"
      placeholder="One or two paragraphs of context for the whole effort. Every full PR body starts with this."
      empty="Add a project intro"
      file={file}
      save={(t) => api.setProjectDescription(slug, t)}
      className={className}
    />
  );
}

/** Only declared stacks have a place in project.yaml for a note (not Unstacked, not the implicit branch stack). */
export const canHaveNote = (g: StackGroup) => g.number !== null && !g.implicit;

export function StackNoteText({ slug, repo, group, file, label, className }: { slug: string; repo: string; group: StackGroup; file: string; label?: ReactNode; className?: string }) {
  return (
    <EditableText
      draftKey={`stack:${slug}:${repo}:${group.number}:${group.title}`}
      label={label}
      text={group.description}
      what="stack note"
      placeholder="Context for this stack: how it relates to the other stacks. Comes after the intro in each of its full PR bodies."
      empty="Add a stack note"
      file={file}
      save={(t) => api.setStackDescription(slug, repo, group.number!, group.title, t)}
      className={className}
    />
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "3 PRs · 12 files · +340 −20" */
export function StackWeight({ w }: { w: NonNullable<StackGroup['weight']> }) {
  return (
    <span className="stack-weight" title="PRs, distinct files changed, lines added / removed in this stack">
      {plural(w.prs, 'PR')} · {plural(w.files, 'file')} · <span className="color-add">+{w.additions.toLocaleString('en-US')}</span> <span className="color-del">−{w.deletions.toLocaleString('en-US')}</span>
    </span>
  );
}

/** A repo's totals with follow-on stacks left out and counted on the side (shared/totals.ts, as in the stack picture). */
export function repoAggregate(r: RepoData): Aggregate {
  const bySha = new Map(r.commits.map((c) => [c.sha, c]));
  return aggregate(
    r.stacks.map((g) => {
      const cs = g.shas.map((s) => bySha.get(s)).filter((c) => !!c);
      return { follow_on: g.follow_on, prs: cs.length, additions: cs.reduce((a, c) => a + c.additions, 0), deletions: cs.reduce((a, c) => a + c.deletions, 0) };
    }),
  );
}

export const FOLLOW_ON_TOTALS_TIP = 'Follow-on stacks (parked work) are left out of these totals; their own stack headers still show their numbers.';

/** "2 repos · 4 stacks · 12 PRs · +3,477 −155 · +1 follow-on stack (2 PRs)" */
export function TotalsLine({ s, className = '' }: { s: Summary; className?: string }) {
  return (
    <span className={`totals-line ${className}`}>
      {s.counts} · <span className="color-add">+{s.additions.toLocaleString('en-US')}</span> <span className="color-del">−{s.deletions.toLocaleString('en-US')}</span>
      {s.note && <> · <span className="follow-on-note" title={FOLLOW_ON_TOTALS_TIP}>{s.note}</span></>}
    </span>
  );
}

const CHEV = 'M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z';
const firstLine = (s: string) => s.replace(/[#>*_`[\]]/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/** The PR page's compact, collapsible "Project context": the intro and this PR's stack note, each editable. */
export function ProjectContextBox({ slug, repo, intro, group, file }: { slug: string; repo: string; intro: string | null; group: StackGroup | null; file: string }) {
  const [open, setOpen] = useLocalStorage('lr.projectContextOpen', true);
  const { drafts } = useContext(Ctx);
  const note = group && canHaveNote(group) ? group : null;
  const editing = Object.keys(drafts).some((k) => k === `intro:${slug}` || (note && k === `stack:${slug}:${repo}:${note.number}:${note.title}`));
  const isOpen = open || editing;
  const summary = firstLine(normBody(intro ?? '')) || (note?.description ? firstLine(note.description) : '');
  return (
    <section className={`project-context ${isOpen ? 'open' : ''}`} aria-label="Project context">
      <div className="project-context-head">
        <button type="button" className="project-context-toggle" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)} title={isOpen ? 'Collapse' : 'Expand'}>
          <Octicon d={CHEV} size={12} className="project-context-chev" />
          <span className="project-context-title">Project context</span>
          {!isOpen && <span className="project-context-summary muted">{summary || 'No intro yet'}</span>}
        </button>
        <a className="project-context-link" href={`/${encodeURIComponent(slug)}`} onClick={(e) => { e.preventDefault(); navigate(`/${encodeURIComponent(slug)}`); window.scrollTo(0, 0); }}>
          Project overview
        </a>
      </div>
      {isOpen && (
        <div className="project-context-body">
          <IntroText slug={slug} text={intro} file={file} label="Project intro" />
          {note && <StackNoteText slug={slug} repo={repo} group={note} file={file} label={<>Stack note · <span className="project-context-stack" style={{ ['--stack' as string]: stackColor(note.color) }}>{note.title}</span></>} />}
        </div>
      )}
    </section>
  );
}
