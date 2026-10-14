import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { tildify } from '../shared/paths';

// ---------- routing (tiny, history API) ----------
// /<project>/<repo>/<sha>[?tab=files&file=…&thread=…] is a PR page; /<project>/<repo>/stacks/<ref>[?tab=stack|comments]
// a stack page (shared/stackRef.ts); /<project>[?tab=stack|comments] the project page. `/<project>/<repo>` opens its first commit; an old
// `/<repo>/<sha>` URL (from before projects) is redirected by App into the project that has that repo.
export interface Route {
  project: string | null;
  repo: string | null;
  sha: string | null;
  /** a stack page's ref (`2-groundwork`, `unstacked`), '' for `…/stacks/` alone; null: not a stack page */
  stack: string | null;
  tab: 'conversation' | 'files' | 'stack' | 'comments';
  file: string | null;
  /** a PR page's `?thread=<id>`: scroll to that thread (and open it), on its Conversation or Files changed tab */
  thread: string | null;
  /** path segments as given, for redirecting old URLs */
  parts: string[];
}

function parse(): Route {
  const parts = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(window.location.search);
  const stack = parts[2] === 'stacks' ? parts[3] ?? '' : null;
  return {
    project: parts[0] ?? null,
    repo: parts[1] ?? null,
    sha: stack === null ? parts[2] ?? null : null,
    stack,
    tab: q.get('tab') === 'files' ? 'files' : q.get('tab') === 'stack' ? 'stack' : q.get('tab') === 'comments' ? 'comments' : 'conversation',
    file: q.get('file'),
    thread: q.get('thread'),
    parts,
  };
}

let current = parse();
const subs = new Set<() => void>();
const notify = () => {
  current = parse();
  subs.forEach((f) => f());
};
window.addEventListener('popstate', notify);

export function useRoute(): Route {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => current,
  );
}

export function routeUrl(project: string, repo: string, sha: string, tab: Route['tab'] = 'conversation', file?: string | null, thread?: string | null) {
  const q = new URLSearchParams();
  if (tab !== 'conversation') q.set('tab', tab);
  if (file) q.set('file', file);
  if (thread) q.set('thread', thread);
  const qs = q.toString();
  return `/${encodeURIComponent(project)}/${encodeURIComponent(repo)}/${sha}${qs ? `?${qs}` : ''}`;
}

/** A PR page's tab for a link from wherever you are: PRs have no Comments tab, so that one opens Conversation. */
export const prTab = (tab: Route['tab']): Route['tab'] => (tab === 'comments' ? 'conversation' : tab);

const withTab = (path: string, tab: Route['tab']) => (tab === 'stack' || tab === 'comments' ? `${path}?tab=${tab}` : path);

/** The project page: its intro (Conversation), every thread in it (Comments) or the whole project's stack picture. */
export const projectUrl = (project: string, tab: Route['tab'] = 'conversation') => withTab(`/${encodeURIComponent(project)}`, tab);

/** A stack page, by its ref (shared/stackRef.ts): its note (Conversation), its threads (Comments) or its stack picture. */
export const stackUrl = (project: string, repo: string, ref: string, tab: Route['tab'] = 'conversation') =>
  withTab(`/${encodeURIComponent(project)}/${encodeURIComponent(repo)}/stacks/${encodeURIComponent(ref)}`, tab);

/**
 * A plain click on an in-app link: navigate without reloading (modifier clicks still open a new tab). A project or
 * stack page is on screen at once, so it scrolls to the top here; a PR page does that itself once it has loaded
 * (`scroll: false`), so the page you're leaving doesn't jump while it stays up.
 */
export const linkTo = (url: string, { scroll = true } = {}) => (e: React.MouseEvent) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(url);
  if (scroll) window.scrollTo(0, 0);
};

export function navigate(url: string, replace = false) {
  if (url === window.location.pathname + window.location.search) return;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  notify();
}

// ---------- misc ----------
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  const abs = Math.abs(s);
  const fmt = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'} ago`;
  if (abs < 45) return 'just now';
  if (abs < 3600) return fmt(Math.round(abs / 60), 'minute');
  if (abs < 86400) return fmt(Math.round(abs / 3600), 'hour');
  if (abs < 86400 * 30) return fmt(Math.round(abs / 86400), 'day');
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, [key, v]);
  return [v, setV];
}

/** Re-render every minute so relative times stay fresh. */
export function useTick(ms = 60000) {
  const [, set] = useState(0);
  useEffect(() => {
    const i = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(i);
  }, [ms]);
}

export function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    // checkboxes, radios and buttons don't take text, so shortcuts still apply (e.g. right after ticking "Viewed")
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** A short, stable hash of a string (FNV-1a), e.g. as a cache-busting version. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// ---------- the project ----------
/** The project being shown: Markdown resolves `assets/<name>` images against it, and editors upload to it. */
export const ProjectContext = createContext<string | null>(null);

// ---------- linked projects ----------
/**
 * The project on screen's links (project.yaml `after:`): the project it builds on, the ones that build on it, and
 * whether any of its repos starts where the predecessor's range ends (then the stack picture can show that one's
 * stacks too, greyed out). `next` leaves out hidden successors (project.yaml `hidden: true`); `hiddenNext` says there
 * were some, so the page doesn't call this one the last of its chain.
 */
export interface ProjectLinks {
  after: { slug: string; title: string } | null;
  next: { slug: string; title: string }[];
  hiddenNext: boolean;
  buildsOn: boolean;
}
export const LinksContext = createContext<ProjectLinks>({ after: null, next: [], hiddenNext: false, buildsOn: false });

// ---------- paths ----------
/** The server's home directory (from /api/projects), so paths under it can be shown as `~/…`. */
export const HomeContext = createContext<string | null>(null);

/** Shows a path, or a message with paths in it, home-relative (`~/.local-review/…`): shared/paths.ts. */
export function useTilde() {
  const home = useContext(HomeContext);
  return useCallback((s: string) => tildify(s, home), [home]);
}
