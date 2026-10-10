---
title: Never-delete guarantee
description: Your reviews are never irreparably deleted, and are snapshotted automatically.
---

**The server (and the CLI) can't irreparably delete anything in `~/.local-review`.** Writes are atomic and never
clobber another file, no file is ever unlinked or truncated, and `projects/` is snapshotted hourly whenever it changes.
A test fails the build if any code gains a way around that.

## The guarantees

- **Every write is atomic.** A new temp file in the same directory (opened with `wx`, so never over an existing file),
  then renamed over the target. A failed write leaves the old file as it was, and removes only its own temp file.
  `local-review init` only creates: its rename is a no-clobber one (below), so it never replaces a `project.yaml`.
- **Writes are operations, not files.** They're applied to a fresh read of the file, never a whole file from the
  browser, so a concurrent edit by an agent is kept ([how](/agents/comment-files/#concurrent-edits)). A file that
  isn't valid YAML is never overwritten (HTTP 409; fix it by hand).
- **No file's contents are ever unlinked or truncated.** A superseded file (after a
  [rebase re-match](/concepts/following-rebases/)) is renamed to `*.superseded-by-<sha8>.yaml.bak`, and a rename never
  replaces an existing file: it's a hard link (which fails if the name is taken) followed by dropping the old name, or,
  on file systems without hard links, an existence check under the per-file lock.
- **The only deletion anywhere is snapshot pruning**, guarded as below.

The one thing that removes your words is you: deleting your own comment in the UI removes it from the file, as you'd
expect. The previous version is in the snapshots. (An agent's comments can't be deleted from the UI at all.)

## Snapshots

When the server starts, and then every hour while it runs, it copies `projects/` to `backups/<timestamp>/` (with file
times preserved), but only if something changed since the newest snapshot. A snapshot is copied under a hidden
`.partial-…` name and renamed when complete, so every timestamped directory is a full copy.

It keeps the 50 most recent snapshots plus the first snapshot of each day for 30 days. Pruning only ever removes
directories directly inside `backups/` whose names are snapshot timestamps (not symlinks, not anything else you put
there), and never the newest.

Restoring is copying files back by hand: see [Restoring](/reference/data-directory/#restoring).

## How it's enforced

All of this lives in `server/safefs.ts` and `server/backups.ts`. `test/fsguard.test.ts` statically scans
`server/**/*.ts` and fails if any other code (or more code there) calls `unlink`, `rm`, `rmdir`, `truncate`,
`writeFile`, `rename`, `copyFile`/`cp`, or shells out to `rm`/`mv`/….

Contributors: if the guard fails on your change, route the write through `server/safefs.ts`; don't widen the test.
