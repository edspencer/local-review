// A repo's refs, fingerprinted from the files git keeps them in, without running git. Every commit, amend, rebase,
// reset, new or deleted branch, fetch and `git pack-refs` rewrites at least one of them (git writes a ref by renaming
// a lock file over it, so even a same-size rewrite is a new inode and mtime; packed-refs is compared by content, since
// a fetch rewrites it whether or not anything moved). stamps.ts runs git only when this
// changes, so an idle repo costs a few stats a round instead of two processes.
//
// It only stats (and reads `.git` / `commondir` to find the files), so it doesn't touch the repo, and it isn't git
// access: see the read-only guarantee page. The index and logs/ are left out on purpose: they change with ordinary
// editing and staging, not with refs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function statOf(p: string): string {
  try {
    const s = fs.statSync(p, { bigint: true });
    return `${s.mtimeNs}:${s.size}:${s.ino}`;
  } catch {
    return '-';
  }
}

/**
 * Every ref file under `dir`, recursively (ref names nest: refs/heads/feat/x), with its stat. Directories are listed
 * by name, not stat'd, and lock files are skipped: a `git fetch` that moves nothing still creates and removes
 * `.lock` files (changing the directories' mtimes), and that shouldn't count as a change.
 */
function walk(dir: string, rel: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    out.push(`${rel}:-`);
    return;
  }
  out.push(`${rel}/`);
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.name.endsWith('.lock')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, `${rel}/${e.name}`, out);
    else out.push(`${rel}/${e.name}:${statOf(p)}`);
  }
}

// packed-refs by content: a fetch rewrites it even when no ref in it moved. Read again only when its stat changes.
const packed = new Map<string, { stat: string; hash: string }>();
function packedRefsStamp(file: string): string {
  const stat = statOf(file);
  if (stat === '-') return '-';
  const hit = packed.get(file);
  if (hit?.stat === stat) return hit.hash;
  let hash: string;
  try {
    hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return stat;
  }
  packed.set(file, { stat, hash });
  return hash;
}

/** The repo's git dir and the common dir its refs live in (they differ in a linked worktree), or null. */
export function gitDirs(repo: string): { gitDir: string; commonDir: string } | null {
  const dotGit = path.join(repo, '.git');
  let gitDir: string;
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) gitDir = dotGit;
    else {
      // a linked worktree or a submodule: `.git` is a file saying where the git dir is
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(repo, m[1]);
    }
  } catch {
    // a bare repo: the path is the git dir
    if (!fs.existsSync(path.join(repo, 'HEAD')) || !fs.existsSync(path.join(repo, 'objects'))) return null;
    gitDir = repo;
  }
  let commonDir = gitDir;
  try {
    commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    /* not a linked worktree */
  }
  return { gitDir, commonDir };
}

/**
 * A stamp that changes whenever any of the repo's refs might have: HEAD, packed-refs, everything under refs/ (and
 * reftable/, for repos using that format). Null if this doesn't look like a repo layout we know: then ask git.
 */
export function refFilesStamp(repo: string): string | null {
  const dirs = gitDirs(repo);
  if (!dirs) return null;
  const { gitDir, commonDir } = dirs;
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) return null;
  const out = [`HEAD:${statOf(path.join(gitDir, 'HEAD'))}`];
  if (commonDir !== gitDir) out.push(`common/HEAD:${statOf(path.join(commonDir, 'HEAD'))}`);
  out.push(`packed-refs:${packedRefsStamp(path.join(commonDir, 'packed-refs'))}`);
  walk(path.join(commonDir, 'refs'), 'refs', out);
  if (fs.existsSync(path.join(commonDir, 'reftable'))) walk(path.join(commonDir, 'reftable'), 'reftable', out);
  return out.join('|');
}
