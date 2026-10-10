// Branch tagging: which git branch stands for each candidate PR (commit). Local Review has no naming scheme: the
// agent that writes the code creates plain branches (`git branch <name> <sha>`) and records the name in
// prs/<repo>/<sha>.yaml (`branch:`, or `github.branch` once the PR exists). Here we read the repo's branches
// (read-only, one `git for-each-ref` per range) and reconcile the recorded name with what git says.
import { git, isSha } from './git.js';
import type { PrOverride } from './prs.js';

export interface RefEntry {
  ref: string; // full ref name, e.g. refs/heads/me/x, refs/remotes/origin/me/x
  name: string; // short name: me/x, origin/me/x
  sha: string;
  remote: boolean;
}

export interface RefIndex {
  refs: RefEntry[];
  byRef: Map<string, RefEntry>;
  bySha: Map<string, RefEntry[]>;
  remotes: string[]; // remote names that have refs, e.g. ['origin']
  symrefs: Map<string, string>; // e.g. origin/HEAD -> origin/main (short names)
}

export type BranchStatus = 'ok' | 'moved' | 'missing' | 'discovered' | 'merged';

export interface BranchInfo {
  name: string;
  status: BranchStatus;
  points_at?: string; // full sha the recorded branch points at, when `moved`
  discovered: string[]; // every branch pointing at this commit (local first, then remote; the range tip last)
}

const SEP = '\x1f';

export function emptyRefIndex(): RefIndex {
  return { refs: [], byRef: new Map(), bySha: new Map(), remotes: [], symrefs: new Map() };
}

export function parseRefs(out: string): RefIndex {
  const idx = emptyRefIndex();
  const remotes = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [sha, ref, symref] = line.split(SEP);
    if (!ref) continue;
    const remote = ref.startsWith('refs/remotes/');
    const name = ref.replace(/^refs\/(heads|remotes)\//, '');
    if (remote) remotes.add(name.split('/')[0]);
    if (symref) {
      // origin/HEAD: not a branch of its own, just remember where it points
      idx.symrefs.set(name, symref.replace(/^refs\/(heads|remotes)\//, ''));
      continue;
    }
    if (!isSha(sha)) continue; // a ref to something that isn't a 40-hex object name
    const e: RefEntry = { ref, name, sha, remote };
    idx.refs.push(e);
    idx.byRef.set(ref, e);
    const list = idx.bySha.get(sha) ?? [];
    list.push(e);
    idx.bySha.set(sha, list);
  }
  idx.remotes = [...remotes].sort();
  return idx;
}

/** The git call that lists every branch, in the format parseRefs reads. */
export const REF_LIST_ARGS = ['for-each-ref', `--format=%(objectname)${SEP}%(refname)${SEP}%(symref)`, '--end-of-options', 'refs/heads', 'refs/remotes'];

/**
 * All local and remote-tracking branches of a repo, in one read-only call. (`--points-at` takes a single
 * object, so for a whole range one listing of every branch is the batched form.) Never throws.
 */
export async function loadRefs(repo: string): Promise<RefIndex> {
  try {
    return parseRefs(await git(repo, REF_LIST_ARGS));
  } catch {
    return emptyRefIndex();
  }
}

/** Find a recorded branch name: local `refs/heads/<n>` first, then `refs/remotes/<n>`, then `<remote>/<n>`. */
export function lookupBranch(idx: RefIndex, name: string): RefEntry | null {
  const local = idx.byRef.get(`refs/heads/${name}`);
  if (local) return local;
  const asRemote = idx.byRef.get(`refs/remotes/${name}`);
  if (asRemote) return asRemote;
  for (const r of idx.remotes) {
    const e = idx.byRef.get(`refs/remotes/${r}/${name}`);
    if (e) return e;
  }
  return null;
}

/** `origin/main` -> `main` (any remote that has refs here), `refs/heads/main` -> `main`; else unchanged. */
export function stripRemote(idx: RefIndex, ref: string): string {
  let r = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
  r = idx.symrefs.get(r) ?? r; // origin/HEAD -> origin/main
  for (const remote of idx.remotes) if (r.startsWith(remote + '/')) return r.slice(remote.length + 1);
  return r;
}

/** Is this ref the range's own tip branch (e.g. me/my-feature, or origin/me/my-feature)? */
function isTip(idx: RefIndex, e: RefEntry, tip: string | null): boolean {
  if (!tip) return false;
  const t = tip.replace(/^refs\/heads\//, '');
  if (!e.remote) return e.name === t;
  return e.name === t || stripRemote(idx, e.name) === t;
}

/** Branches pointing at `sha`, best first: local non-tip, remote non-tip, then the tip branch (local, remote). */
export function discoveredFor(idx: RefIndex, sha: string, tip: string | null): string[] {
  const list = idx.bySha.get(sha) ?? [];
  const rank = (e: RefEntry) => (isTip(idx, e, tip) ? 2 : 0) + (e.remote ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map((e) => e.name);
}

/**
 * Reconcile what prs/<sha>.yaml records with git. Recorded name: `github.branch`, else `branch`. Then:
 * ok (exists, points here), moved (exists, points elsewhere: `points_at`), missing (not in git). With nothing
 * recorded: the best discovered branch (a local non-tip one first), status `discovered`; else null. A landed PR's
 * recorded branch is `merged`, whatever git says (never a warning).
 */
export function reconcileBranch(idx: RefIndex, sha: string, override: PrOverride | undefined, tip: string | null): BranchInfo | null {
  const recorded = override?.github?.branch ?? override?.branch;
  // a landed PR's branch is history: it may be deleted or reused by now, and that's no problem
  if (override?.landed) return recorded ? { name: recorded, status: 'merged', discovered: [] } : null;
  const discovered = discoveredFor(idx, sha, tip);
  if (recorded) {
    const e = lookupBranch(idx, recorded);
    if (!e) return { name: recorded, status: 'missing', discovered };
    if (e.sha === sha) return { name: recorded, status: 'ok', discovered };
    return { name: recorded, status: 'moved', points_at: e.sha, discovered };
  }
  return discovered.length ? { name: discovered[0], status: 'discovered', discovered } : null;
}
