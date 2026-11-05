// From edspencer/cli-contract reference/service/rotate.ts @ 1.0; local changes: none
// Rotating the service log (SPEC §7: "the tool rotates its own log, by copying it and then truncating it"). Lifted
// from Paddock's `service-log.ts`. Node built-ins only.
//
// The service manager is the writer, not the tool: launchd's `StandardOutPath` and systemd's `StandardOutput=append:`
// hold an append-mode descriptor on the file. Renaming the path doesn't move that descriptor, so a rename-and-recreate
// would send every later line to `service.log.1` and leave `service.log` empty for good. So the bytes are copied out
// and the file truncated in place (logrotate's `copytruncate`): the descriptor's next `O_APPEND` write lands at 0. A
// line written between the copy and the truncate is lost, which is the honest cost.
//
// The server runs it at boot and then on an unref'd timer: its output doesn't pass through any logger it could hook.
// Where there's no log file (every foreground `serve`), it does nothing.

import fs from 'node:fs';

/** Rotate once the log passes this. */
export const ROTATE_AT_BYTES = 8 * 1024 * 1024;

/** How many rotated generations to keep: `service.log.1` to `.3`. */
export const KEEP_GENERATIONS = 3;

/** How often the server looks. */
export const ROTATE_CHECK_MS = 15 * 60 * 1000;

export interface RotateOptions {
  maxBytes?: number;
  keep?: number;
  /** Where a warning goes. Failing to rotate is never fatal. */
  warn?: (message: string) => void;
}

/**
 * Rotates `file` if it has grown past the limit, and says whether it did. Never throws: a log folder that has gone
 * read-only is worth a warning, not a server that won't start.
 */
export function rotateLog(file: string, o: RotateOptions = {}): boolean {
  const maxBytes = o.maxBytes ?? ROTATE_AT_BYTES;
  const keep = o.keep ?? KEEP_GENERATIONS;
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
  } catch {
    // No log: a foreground run, or a service that hasn't written yet.
    return false;
  }
  try {
    // The generations shift down, oldest first, so nothing is overwritten before it has moved. The oldest goes.
    const gen = (n: number): string => `${file}.${String(n)}`;
    fs.rmSync(gen(keep), { force: true });
    for (let n = keep - 1; n >= 1; n--) if (fs.existsSync(gen(n))) fs.renameSync(gen(n), gen(n + 1));
    fs.copyFileSync(file, gen(1));
    // Truncate, never unlink: the manager's descriptor only keeps working if the file does.
    fs.truncateSync(file, 0);
    return true;
  } catch (err) {
    o.warn?.(`couldn't rotate ${file}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Rotates now, then every {@link ROTATE_CHECK_MS}, and returns a function that stops it. The timer is unref'd, so it
 * never keeps the process alive: a `serve` that won't exit on Ctrl-C is worse than a big log.
 */
export function startLogRotation(file: string, o: RotateOptions & { everyMs?: number } = {}): () => void {
  rotateLog(file, o);
  const timer = setInterval(() => rotateLog(file, o), o.everyMs ?? ROTATE_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
