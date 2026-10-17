// The per-user service manager behind `local-review service …`: a launchd LaunchAgent on macOS (launchd.ts), a
// systemd user unit on Linux (systemd.ts). Both take a fully resolved ServiceSpec (spec.ts does the resolving:
// absolute paths, PATH, environment) and turn it into one file plus a handful of lifecycle verbs. Every command goes
// through a Runner, so the lifecycle is tested with the runner mocked, on every OS. The shape follows Hallway's
// server/platform/services.ts, cut down to the one job Local Review has.
//
// The only files this writes are the service's own definition (through safefs.atomicWrite) and, on uninstall, it
// removes that one file again (removeServiceFile). Nothing here touches the data home except creating its logs/
// directory, which launchd and systemd need to exist before they can append to the log files in it.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../safefs.js';

/** The job. Everything in it is already absolute and resolved. */
export interface ServiceSpec {
  /** `local-review.server`: the launchd label, and (dots to hyphens) the systemd unit's name. */
  label: string;
  /** For people: `Local Review: the review UI on port 5622`. */
  description: string;
  /** The argv: [node, cli.js, 'serve', '--quiet', '--port', N], every path absolute and real (never a shim). */
  program: string[];
  cwd: string;
  /** The whole environment the job gets: PATH, plus LOCAL_REVIEW_HOME / LOCAL_REVIEW_USER when they were set. */
  env: Record<string, string>;
  /** Log files, appended to. */
  stdout: string;
  stderr: string;
  /** The Node the job runs (and its PATH starts with), recorded as a comment in the file. */
  node: { path: string; version: string };
}

/** What the service manager says about the job. */
export interface ServiceStatus {
  /** The definition file exists. */
  installed: boolean;
  /** The service manager knows it (launchd: bootstrapped; systemd: the unit loads). */
  loaded: boolean;
  running: boolean;
  pid: number | null;
  /** The last exit status, if it has exited. */
  lastExitCode: number | null;
  /** The manager's own word for it (`running`, `active (running)`, `inactive (dead)`, `failed`). */
  state: string | null;
  /** Starts at login. Null where the manager doesn't say. */
  enabled: boolean | null;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and resolves with its exit code and output (never rejects for a non-zero exit). */
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      if (e && e.code === 'ENOENT') resolve({ code: 127, stdout: '', stderr: `${cmd}: command not found` });
      else resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export class ServiceManagerError extends Error {}

/** What a definition file says, read back: so a reinstall can keep the port and environment it was installed with. */
export interface InstalledDefinition {
  program: string[];
  env: Record<string, string>;
}

export interface ServiceManager {
  kind: 'launchd' | 'systemd';
  /** What the job is called, for people: `LaunchAgent`, `systemd user unit`. */
  noun: string;
  /** For people, after an install: when it runs, and what keeps it running. */
  lifetime: string;
  /** Where the definition lives. */
  file: string;
  /** The definition's text. Pure. */
  render(spec: ServiceSpec): string;
  /** The program and environment a definition (as render writes it) sets, or null if it can't be read. */
  parse(text: string): InstalledDefinition | null;
  /** Write the definition (atomically) and tell the manager. True if it changed. Doesn't start anything. */
  write(spec: ServiceSpec): Promise<boolean>;
  /** Make it run now, and at login; a no-op if it's already running. */
  start(): Promise<void>;
  /** Restart it. `reload`: the definition changed, so re-read it first. Starts it if it wasn't loaded. */
  restart(opts?: { reload?: boolean }): Promise<void>;
  status(): Promise<ServiceStatus>;
  /** Stop it, unload it and delete the definition. */
  remove(): Promise<void>;
}

/** Write `text` to `file` atomically; false if it already had exactly that text. */
export function writeIfChanged(file: string, text: string): boolean {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return false;
  } catch {
    /* missing: write it */
  }
  atomicWrite(file, text);
  return true;
}

/**
 * The file names a service definition may have: the only files `service uninstall` removes. Anything else, and
 * anything not directly in the service directory, is refused, so this can never reach the data home or a file of
 * the user's. (test/fsguard.test.ts allows this one unlink and checks it stays behind this check.)
 */
export const SERVICE_FILE = /^local-review[.-]server\.(?:plist|service)$/;

export function removeServiceFile(file: string, dir: string) {
  if (!SERVICE_FILE.test(path.basename(file)) || path.dirname(path.resolve(file)) !== path.resolve(dir))
    throw new Error(`refusing to remove ${file}: not Local Review's service file in ${dir}`);
  try {
    fs.unlinkSync(file); // fs-guard: the service's own generated definition, nothing else (checked above)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
