import { useEffect, useState, useSyncExternalStore } from 'react';

// ---------- routing (tiny, history API) ----------
// /<project>/<repo>/<sha>[?tab=files&file=…]. `/<project>` opens its first commit; an old `/<repo>/<sha>`
// URL (from before projects) is redirected by App into the project that has that repo.
export interface Route {
  project: string | null;
  repo: string | null;
  sha: string | null;
  tab: 'conversation' | 'files' | 'stack';
  file: string | null;
  /** path segments as given, for redirecting old URLs */
  parts: string[];
}

function parse(): Route {
  const parts = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(window.location.search);
  return {
    project: parts[0] ?? null,
    repo: parts[1] ?? null,
    sha: parts[2] ?? null,
    tab: q.get('tab') === 'files' ? 'files' : q.get('tab') === 'stack' ? 'stack' : 'conversation',
    file: q.get('file'),
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

export function routeUrl(project: string, repo: string, sha: string, tab: Route['tab'] = 'conversation', file?: string | null) {
  const q = new URLSearchParams();
  if (tab !== 'conversation') q.set('tab', tab);
  if (file) q.set('file', file);
  const qs = q.toString();
  return `/${encodeURIComponent(project)}/${encodeURIComponent(repo)}/${sha}${qs ? `?${qs}` : ''}`;
}

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
