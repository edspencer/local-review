// From "this local-review, now" to a fully resolved ServiceSpec: absolute, real paths for Node and the CLI, a PATH
// that survives the shell it was made in and finds git, the port, and the environment Local Review reads. Plus the
// two refusals, both from Hallway (server/services/transient.ts, resolve.ts): no service that runs Local Review out
// of npx's cache (or pnpm dlx's, bunx's, …), and none that runs a source checkout unless you say so.
// Everything here takes its environment, paths and platform as arguments, so the tests cover every OS from any OS.
import fs from 'node:fs';
import path from 'node:path';
import { type Runner, type ServiceManager, type ServiceSpec } from './manager.js';
import { launchdManager } from './launchd.js';
import { systemdManager } from './systemd.js';

export const LABEL = 'local-review.server';

// ---------------------------------------------------------------------------------------------------------------
// Where it's running from
// ---------------------------------------------------------------------------------------------------------------

export interface Transient {
  /** What it is, for messages: "npx's cache". */
  where: string;
  /** Who can delete it: "npm". */
  owner: string;
}

const TRANSIENT: readonly { re: RegExp; where: string; owner: string }[] = [
  { re: /[/\\]_npx[/\\]/i, where: "npx's cache", owner: 'npm' },
  // pnpm 9+: <cache dir>/dlx/<hash>/… (~/.cache/pnpm, ~/Library/Caches/pnpm)
  { re: /[/\\]pnpm[^/\\]*[/\\]dlx[/\\]/i, where: "pnpm dlx's cache", owner: 'pnpm' },
  { re: /[/\\]bunx-[^/\\]+[/\\]/i, where: "bunx's cache", owner: 'bun' },
  // older pnpm dlx and yarn dlx: a temporary dlx-<pid> directory
  { re: /[/\\]dlx-\d+[/\\]/i, where: 'a temporary dlx directory', owner: 'the package manager' },
];

/** Where `p` is transient (a package manager's run-once cache), or null if it isn't. Pure. */
export function transientInstall(p: string): Transient | null {
  const hit = TRANSIENT.find((t) => t.re.test(p));
  return hit ? { where: hit.where, owner: hit.owner } : null;
}

/** A source checkout rather than an installed package: the CLI isn't inside a node_modules directory. Pure. */
export const isCheckout = (cliScript: string) => !cliScript.split(/[/\\]/).includes('node_modules');

export class RefusalError extends Error {}

/** Why a service mustn't run `cliScript` (its real path), or null if it may. */
export function refusal(cliScript: string, { fromCheckout = false } = {}): string | null {
  const t = transientInstall(cliScript);
  if (t)
    return `Local Review is running from ${t.where}, which ${t.owner} can delete at any time, so a service that runs it would break at some later login. Install it first: \`npm i -g local-review\`, then run \`local-review service install\` again.`;
  if (isCheckout(cliScript) && !fromCheckout)
    return (
      `Local Review is running from a source checkout (${path.dirname(path.dirname(path.dirname(cliScript)))}), not an installed package: a service would run ` +
      "whatever that checkout last built, and break when it's cleaned or rebuilt. Install it first: `npm i -g local-review`, then run `local-review service install` again. " +
      'To run the checkout on purpose, add --from-checkout.'
    );
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The PATH trap (Hallway's docs: "The PATH trap")
// ---------------------------------------------------------------------------------------------------------------

/** PATH entries that belong to one shell session or one npm invocation, never to a long-lived job. */
export const PER_SHELL_PATTERNS: readonly RegExp[] = [
  /[/\\]fnm_multishells[/\\]/, // fnm: a symlink per terminal, never cleaned up
  /[/\\]_npx[/\\]/, // npx's per-invocation package cache
  /[/\\]node-gyp-bin$/, // added by `npm run` for the script it's running
  /[/\\]node_modules[/\\]\.bin$/, // likewise (and by npx): a package's own tools, not the user's
];

/** Where the usual tools (git among them) live, after the current PATH; only those that exist are kept. */
export const SYSTEM_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isExecutableFile = (p: string) => {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Kept on the job's PATH: absolute, not per-shell, and an existing directory. */
const keep = (dir: string) => !!dir && path.posix.isAbsolute(dir) && !PER_SHELL_PATTERNS.some((re) => re.test(dir) || re.test(`${dir}/`)) && isDir(dir);

/** The job's PATH: Node's bin first, then the usable part of `inherited`, then the system directories. */
export function servicePath(nodeBin: string, inherited: string | undefined): string {
  const out: string[] = [];
  const add = (d: string) => {
    const clean = d === '/' ? d : d.replace(/\/+$/, '');
    if (!out.includes(clean) && keep(clean)) out.push(clean);
  };
  add(nodeBin);
  for (const d of (inherited ?? '').split(':')) add(d);
  for (const d of SYSTEM_DIRS) add(d);
  return out.join(':');
}

/** `which`: the first executable called `name` on `pathVar`, or null. */
export function which(name: string, pathVar: string): string | null {
  for (const dir of pathVar.split(':')) {
    const p = path.posix.join(dir, name);
    if (dir && isExecutableFile(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The platform
// ---------------------------------------------------------------------------------------------------------------

export interface PlatformContext {
  platform: NodeJS.Platform;
  /** The user's home directory ($HOME). */
  userHome: string;
  env: NodeJS.ProcessEnv;
  uid?: number;
  run?: Runner;
  sleep?: (ms: number) => Promise<void>;
}

/** Why this OS can't have the service, or null. */
export function unsupported(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin' || platform === 'linux') return null;
  if (platform === 'win32')
    return "`local-review service` doesn't support Windows yet (there's no per-user launchd or systemd there). Run `local-review` in a terminal instead, or start it at logon with Task Scheduler yourself.";
  return `\`local-review service\` supports macOS (launchd) and Linux (systemd), not ${platform}. Run \`local-review\` in a terminal instead.`;
}

/** The directory the service's definition goes in: ~/Library/LaunchAgents, or the systemd user unit directory. */
export function serviceDir(ctx: PlatformContext): string {
  if (ctx.platform === 'darwin') return path.posix.join(ctx.userHome, 'Library', 'LaunchAgents');
  const xdg = ctx.env.XDG_CONFIG_HOME;
  return path.posix.join(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(ctx.userHome, '.config'), 'systemd', 'user');
}

export function managerFor(ctx: PlatformContext): ServiceManager {
  const why = unsupported(ctx.platform);
  if (why) throw new RefusalError(why);
  const dir = serviceDir(ctx);
  if (ctx.platform === 'darwin') return launchdManager({ dir, label: LABEL, uid: ctx.uid ?? process.getuid?.() ?? 0, run: ctx.run, sleep: ctx.sleep });
  return systemdManager({ dir, label: LABEL, run: ctx.run });
}

// ---------------------------------------------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------------------------------------------

/** The environment variables Local Review reads that a service carries over (the job's environment is otherwise empty). */
export const CARRIED_ENV = ['LOCAL_REVIEW_HOME', 'LOCAL_REVIEW_USER'] as const;

export interface SpecInput {
  /** The compiled CLI, real path (dist/server/cli.js). */
  cliScript: string;
  node: { path: string; version: string };
  port: number;
  /** The data home, resolved: where logs/ goes, and the job's working directory. */
  home: string;
  /** LOCAL_REVIEW_HOME / LOCAL_REVIEW_USER, if they're to be set. */
  carried: Partial<Record<(typeof CARRIED_ENV)[number], string>>;
  /** The PATH the job's starts from. */
  inheritedPath: string | undefined;
  /** The user's home directory: the job's HOME. */
  userHome: string;
}

export function buildSpec(i: SpecInput): ServiceSpec {
  const logs = path.posix.join(i.home, 'logs');
  return {
    label: LABEL,
    description: `Local Review: the review UI on http://localhost:${i.port}`,
    program: [i.node.path, i.cliScript, 'serve', '--quiet', '--port', String(i.port)],
    cwd: i.home,
    // HOME as well: launchd and systemd set one, but this makes sure the data home, the logs and git's user.name (the
    // reviewer's id) are the ones `service install` resolved, even where the two would differ
    env: { PATH: servicePath(path.posix.dirname(i.node.path), i.inheritedPath), HOME: i.userHome, ...i.carried },
    stdout: path.posix.join(logs, 'server.out.log'),
    stderr: path.posix.join(logs, 'server.err.log'),
    node: i.node,
  };
}

/** The port an installed definition's program passes (`--port N`), or null. */
export function portOf(program: string[]): number | null {
  const i = program.indexOf('--port');
  const n = i >= 0 ? Number(program[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}
