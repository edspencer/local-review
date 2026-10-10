// The only places the server writes, renames or removes files under the data home. Rules (test/fsguard.test.ts
// enforces that no other server file calls a deleting or overwriting fs function):
//  - every write is atomic: a fresh temp file in the same directory, renamed over the target;
//  - a rename never clobbers an existing file (renameNoClobber), except atomicWrite replacing the file it updates;
//  - nothing is unlinked except our own temp file after a failed write, and the old name of a file that has
//    just been hard-linked to its new name (so the data is still there, under the new name).
// Superseded files are renamed to `.bak`, never deleted. Automatic snapshots (backups.ts) cover the rest.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TEMP_NAME = /^\..+\.\d+\.\d+\.[0-9a-f]{6}\.tmp$/;

/**
 * Write `text` (or bytes) to `file` atomically: temp file in the same directory, then rename. With `createOnly`,
 * never replace an existing `file` (fails with ExistsError instead), even one that appears while writing.
 */
export function atomicWrite(file: string, text: string | Uint8Array, { createOnly = false } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' }); // 'wx': never over an existing file (bytes ignore the encoding)
    if (!createOnly && fs.existsSync(file)) fs.renameSync(tmp, file); // the update itself: replaces the previous version of `file`
    else renameNoClobber(tmp, file); // creating: fails rather than replace a file that appeared meanwhile
  } catch (e) {
    removeOwnTemp(tmp);
    throw e;
  }
}

/** Clean up a temp file written by atomicWrite whose rename failed. Refuses anything that isn't one. */
function removeOwnTemp(tmp: string) {
  if (!TEMP_NAME.test(path.basename(tmp))) return;
  try {
    fs.unlinkSync(tmp); // fs-guard: temp-file cleanup (only our own .tmp, never renamed into place)
  } catch {
    /* already gone */
  }
}

export class ExistsError extends Error {
  code = 'EEXIST';
}

/**
 * Rename `from` to `to`, failing with EEXIST if `to` exists (fs.rename would silently replace it). Done as a hard
 * link (atomic, fails if `to` exists) and then dropping the old name, only once both names are the same file.
 */
export function renameNoClobber(from: string, to: string) {
  try {
    fs.linkSync(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new ExistsError(`${to} already exists; not replacing it`);
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw e;
    // a file system without hard links: check, then rename (we hold the per-file lock, so this is only racy
    // against a hand edit creating exactly this name in the same instant)
    if (fs.existsSync(to)) throw new ExistsError(`${to} already exists; not replacing it`);
    fs.renameSync(from, to);
    return;
  }
  const a = fs.statSync(from);
  const b = fs.statSync(to);
  if (a.ino !== b.ino || a.dev !== b.dev) return; // should not happen; keep both names rather than risk anything
  fs.unlinkSync(from); // fs-guard: drop the old name of a file that is now also linked at `to`
}

/**
 * Move a superseded file out of the way of matching: `<name>.yaml` -> `<name>.<tag>.yaml.bak`, or
 * `<name>.<tag>.2.yaml.bak`, … if that exists. Never replaces an existing file. Returns the new path.
 */
export function renameToBak(file: string, tag: string): string {
  for (let n = 1; n < 1000; n++) {
    const bak = file.replace(/\.yaml$/, n === 1 ? `.${tag}.yaml.bak` : `.${tag}.${n}.yaml.bak`);
    if (fs.existsSync(bak)) continue;
    try {
      renameNoClobber(file, bak);
      return bak;
    } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
    }
  }
  throw new Error(`no free .bak name for ${file}`);
}
