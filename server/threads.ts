// The Comments tab's data (GET /api/projects/:project/threads): every thread on every PR of a project, or of one
// stack, as each PR page shows it (carried over after a rebase, inline threads placed on the current commit or
// marked outdated), in the tab's order (shared/threads.ts). Read-only: nothing here writes a file.
import { contextFor } from './context.js';
import { viewReview, type Thread } from './reviews.js';
import { dirStamp } from './stamps.js';
import { lastUpdate, orderThreads } from '../shared/threads.js';
import type { LoadedProject, LoadedRepo } from './projects.js';

export interface ThreadEntry {
  repo: string;
  /** the PR's commit (full sha) and its 1-based position in the repo's range */
  sha: string;
  position: number;
  thread: Thread;
  /** its newest comment or reply, written or edited (ISO), or null if none says */
  updated: string | null;
}

/** A review file that couldn't be read (invalid YAML): its threads are missing from the list until it's fixed. */
export interface ThreadsProblem {
  repo: string;
  sha: string;
  file: string;
  error: string;
}

interface RepoThreads {
  entries: ThreadEntry[];
  problems: ThreadsProblem[];
}

// per loaded repo (a new one whenever its range or project.yaml change: see loadProject) and as of its reviews/
// directory's stamp, as the sidebar payloads are cached (index.ts repoPayload). Shared between requests: read-only.
const cache = new WeakMap<LoadedRepo, { stamp: string; p: Promise<RepoThreads> }>();

function repoThreads(r: LoadedRepo): Promise<RepoThreads> {
  const stamp = dirStamp(r.reviewsDir); // before reading: a write after it changes it
  const hit = cache.get(r);
  if (hit?.stamp === stamp) return hit.p;
  const p = readRepoThreads(r);
  cache.set(r, { stamp, p });
  p.catch(() => {
    if (cache.get(r)?.p === p) cache.delete(r);
  });
  return p;
}

async function readRepoThreads(r: LoadedRepo): Promise<RepoThreads> {
  if (r.info.error) return { entries: [], problems: [] };
  const per = await Promise.all(
    r.info.commits.map(async (cm, i) => {
      const l = await viewReview(contextFor(r.reviewsDir, r.cfg, r.info, cm)).catch(() => null);
      if (!l) return { entries: [], problems: [] };
      if (l.parseError) return { entries: [], problems: [{ repo: r.cfg.name, sha: cm.sha, file: l.file ?? '', error: l.parseError }] };
      const entries = l.review.threads
        .filter((t) => t.comments.length > 0)
        .map((thread) => {
          const at = lastUpdate(thread);
          return { repo: r.cfg.name, sha: cm.sha, position: i + 1, thread, updated: at ? new Date(at).toISOString() : null };
        });
      return { entries, problems: [] };
    }),
  );
  return { entries: per.flatMap((x) => x.entries), problems: per.flatMap((x) => x.problems) };
}

/**
 * Every thread with a comment in it, across the project's repos (in sidebar order) or only `scope`'s: one repo, and
 * if `shas` is given only those PRs (a stack). Open threads first, then the most recently updated.
 */
export async function collectThreads(p: LoadedProject, scope?: { repo: string; shas?: readonly string[] }): Promise<{ threads: ThreadEntry[]; problems: ThreadsProblem[] }> {
  const repos = scope ? p.repos.filter((r) => r.cfg.name === scope.repo) : p.repos;
  const only = scope?.shas ? new Set(scope.shas) : null;
  const all = await Promise.all(repos.map(repoThreads));
  const keep = <T extends { sha: string }>(xs: T[]) => (only ? xs.filter((x) => only.has(x.sha)) : xs);
  return {
    threads: orderThreads(keep(all.flatMap((x) => x.entries))),
    problems: keep(all.flatMap((x) => x.problems)),
  };
}
