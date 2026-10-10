// Automatic snapshots of the projects directory: a plain recursive copy into backups/<timestamp>/, so restoring
// is just copying files back. Taken on server start and then hourly, each only if something changed since the
// newest snapshot. Pruning keeps the newest KEEP_RECENT snapshots plus the first snapshot of each (UTC) day for
// KEEP_DAYS days, and can only ever remove directories directly inside the backups dir whose names are
// snapshot timestamps (see assertPrunable).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const KEEP_RECENT = 50;
export const KEEP_DAYS = 30;
export const INTERVAL_MS = 60 * 60 * 1000;

/** `2026-10-09T08-45-12Z` (ISO 8601 UTC, ':' -> '-' so it's a valid file name everywhere), maybe `-2`, `-3`… */
export const SNAPSHOT_NAME = /^(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}Z(?:-\d{1,3})?$/;

export function snapshotName(d: Date) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/** Our own atomic-write temp files: never worth backing up. */
const isTemp = (name: string) => name.startsWith('.') && name.endsWith('.tmp');

/** A hash of every file's relative path and contents (symlinks are skipped, as cpSync would copy them as links). */
export function fingerprint(dir: string): string | null {
  const h = crypto.createHash('sha256');
  let files = 0;
  const walk = (d: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (isTemp(e.name)) continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        files++;
        h.update(`${r}\0`).update(fs.readFileSync(p)).update('\0');
      }
    }
  };
  walk(dir, '');
  return files ? h.digest('hex') : null;
}

/** Snapshot directory names in `backupsDir`, oldest first (the names sort chronologically). */
export function listSnapshots(backupsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && SNAPSHOT_NAME.test(e.name))
    .map((e) => e.name)
    .sort(compareNames);
}

function compareNames(a: string, b: string) {
  const [ta, na] = splitName(a);
  const [tb, nb] = splitName(b);
  return ta < tb ? -1 : ta > tb ? 1 : na - nb;
}
const splitName = (n: string): [string, number] => {
  const m = /^(.*Z)(?:-(\d+))?$/.exec(n)!;
  return [m[1], m[2] ? Number(m[2]) : 1];
};

/**
 * Copy `projectsDir` to `backupsDir/<timestamp>/` unless it's empty or identical to the newest snapshot.
 * The copy is made under a dot-name and renamed into place, so a snapshot directory is always complete.
 * Returns the new snapshot's name, or null if none was needed.
 */
export function takeSnapshot(projectsDir: string, backupsDir: string, now = new Date()): string | null {
  const fp = fingerprint(projectsDir);
  if (!fp) return null; // nothing to back up
  const existing = listSnapshots(backupsDir);
  const newest = existing[existing.length - 1];
  if (newest && fingerprint(path.join(backupsDir, newest)) === fp) return null;
  fs.mkdirSync(backupsDir, { recursive: true });
  const base = snapshotName(now);
  let name = base;
  for (let n = 2; fs.existsSync(path.join(backupsDir, name)); n++) name = `${base}-${n}`;
  const partial = path.join(backupsDir, `.partial-${name}-${process.pid}`);
  fs.cpSync(projectsDir, partial, {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
    filter: (src) => !isTemp(path.basename(src)),
  });
  const dest = path.join(backupsDir, name);
  if (fs.existsSync(dest)) throw new Error(`${dest} appeared while snapshotting; leaving the copy at ${partial}`);
  fs.renameSync(partial, dest); // fs-guard: a fresh dot-dir onto a name we just checked is free
  return name;
}

/** Which snapshots to keep: the newest KEEP_RECENT, plus the first of each UTC day in the last KEEP_DAYS days. */
export function snapshotsToKeep(names: string[], now = new Date()): Set<string> {
  const sorted = [...names].sort(compareNames);
  const keep = new Set(sorted.slice(-KEEP_RECENT));
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const seenDays = new Set<string>();
  for (const n of sorted) {
    const day = SNAPSHOT_NAME.exec(n)![1];
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    if (day >= cutoff) keep.add(n);
  }
  return keep;
}

/**
 * Throws unless `backupsDir/name` is something pruning may remove: `name` is a bare snapshot timestamp, the
 * target is a real directory (not a symlink) directly inside `backupsDir`, and `backupsDir` is a directory
 * called `backups` that is neither inside nor containing the projects directory.
 */
export function assertPrunable(backupsDir: string, name: string, projectsDir: string): string {
  if (typeof name !== 'string' || !SNAPSHOT_NAME.test(name) || name !== path.basename(name) || name.includes('/') || name.includes('\\')) {
    throw new Error(`refusing to prune ${JSON.stringify(name)}: not a snapshot name`);
  }
  const root = path.resolve(backupsDir);
  if (path.basename(root) !== 'backups') throw new Error(`refusing to prune in ${root}: not a backups/ directory`);
  const projects = path.resolve(projectsDir);
  const inside = (a: string, b: string) => a === b || a.startsWith(b + path.sep);
  if (inside(root, projects) || inside(projects, root)) throw new Error(`refusing to prune in ${root}: overlaps ${projects}`);
  const target = path.join(root, name);
  if (path.dirname(target) !== root) throw new Error(`refusing to prune ${target}: not directly inside ${root}`);
  const st = fs.lstatSync(target);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`refusing to prune ${target}: not a directory`);
  // the real path too, in case backupsDir itself is reached through a symlink into the projects
  const realRoot = fs.realpathSync(root);
  if (path.dirname(fs.realpathSync(target)) !== realRoot) throw new Error(`refusing to prune ${target}: resolves outside ${realRoot}`);
  if (fs.existsSync(projects) && inside(realRoot, fs.realpathSync(projects))) throw new Error(`refusing to prune in ${realRoot}: inside the projects`);
  return target;
}

/** Remove snapshots that `snapshotsToKeep` doesn't keep. Never removes the newest. Returns the removed names. */
export function pruneSnapshots(backupsDir: string, projectsDir: string, now = new Date()): string[] {
  const names = listSnapshots(backupsDir);
  const keep = snapshotsToKeep(names, now);
  const newest = names[names.length - 1];
  const removed: string[] = [];
  for (const n of names) {
    if (keep.has(n) || n === newest) continue;
    const target = assertPrunable(backupsDir, n, projectsDir);
    fs.rmSync(target, { recursive: true }); // fs-guard: backup pruning (assertPrunable checked the path)
    removed.push(n);
  }
  return removed;
}

/** Snapshot (if changed) and prune. Never throws: a failed snapshot must not take the server down. */
export function snapshotNow(projectsDir: string, backupsDir: string, now = new Date()) {
  try {
    const name = takeSnapshot(projectsDir, backupsDir, now);
    if (name) console.log(`[backups] snapshot ${path.join(backupsDir, name)}`);
    const removed = pruneSnapshots(backupsDir, projectsDir, now);
    if (removed.length) console.log(`[backups] pruned ${removed.length} old snapshot(s)`);
    return name;
  } catch (e) {
    console.error('[backups] snapshot failed:', e);
    return null;
  }
}

/** On start, and then hourly while running. */
export function startSnapshots(projectsDir: string, backupsDir: string | null) {
  if (!backupsDir) return;
  snapshotNow(projectsDir, backupsDir);
  setInterval(() => snapshotNow(projectsDir, backupsDir), INTERVAL_MS).unref();
}
