// `local-review service install | uninstall | status | restart`: run Local Review in the background, started at login
// and restarted if it exits, with the OS's own per-user service manager (manager.ts). Modelled on Hallway's
// `hallway service …` for its daemon (server/commands/services.ts there): the same subcommands, the same wording.
// Local Review has no config file, so the port and the environment it reads live in the service's definition, and a
// reinstall reads them back from it (they're kept unless you give new ones).
//
// What this writes: the service's definition (~/Library/LaunchAgents/local-review.server.plist or
// ~/.config/systemd/user/local-review-server.service), and the data home's logs/ directory. `uninstall` removes the
// definition and nothing else: the data home, logs included, stays as it is.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from '../port.js';
import { ServiceManagerError, type ServiceManager, type ServiceStatus } from './manager.js';
import { CARRIED_ENV, type PlatformContext, RefusalError, buildSpec, managerFor, portOf, refusal, which } from './spec.js';

export interface ServiceContext extends PlatformContext {
  /** Local Review's package root (config.ROOT): the service runs <root>/dist/server/cli.js. */
  root: string;
  /** The Node running this, and its version. */
  execPath: string;
  nodeVersion: string;
  out: (s: string) => void;
  err: (s: string) => void;
  /** How long to wait for the server to answer after a start. */
  waitMs?: number;
  /** Is something listening on 127.0.0.1:<port>? (Mocked in tests.) */
  isListening?: (port: number) => Promise<boolean>;
  /** Does Local Review answer on it? (Mocked in tests.) */
  answering?: (port: number) => Promise<boolean>;
}

export const SERVICE_USAGE = 'service needs one of: install, uninstall, status, restart';

/** `/Users/me/x` → `~/x`, for messages. */
const tildify = (p: string, home: string) => (p === home ? '~' : p.startsWith(home + '/') ? `~${p.slice(home.length)}` : p);

const realOr = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

const defaultIsListening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(1000);
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('timeout', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(false));
  });

const defaultAnswering = async (port: number) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json()).ok === true;
  } catch {
    return false;
  }
};

async function waitUntilAnswering(ctx: ServiceContext, port: number): Promise<boolean> {
  const answering = ctx.answering ?? defaultAnswering;
  const end = Date.now() + (ctx.waitMs ?? 15_000);
  for (;;) {
    if (await answering(port)) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The last lines of the service's logs, for a start that didn't come up. */
function logTail(files: string[], lines = 20): string {
  return files
    .map((f) => {
      let text = '';
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        return '';
      }
      const tail = text.trimEnd().split('\n').slice(-lines).join('\n');
      return tail ? `==> ${f} <==\n${tail}\n` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** What the installed definition says, or null if there's none (or it can't be read). */
function installed(m: ServiceManager) {
  try {
    return m.parse(fs.readFileSync(m.file, 'utf8'));
  } catch {
    return null;
  }
}

/** The data home a job with this environment uses (config.ts's rule, for the job's env rather than ours). */
const dataHome = (env: Record<string, string | undefined>, userHome: string) => (env.LOCAL_REVIEW_HOME ? env.LOCAL_REVIEW_HOME : path.join(userHome, '.local-review'));

/** A LOCAL_REVIEW_HOME as given (`~/x`, a relative path) → the absolute path the job needs. */
const absoluteHome = (v: string, userHome: string) => path.resolve(v === '~' ? userHome : v.startsWith('~/') ? path.join(userHome, v.slice(2)) : v);

// ---------------------------------------------------------------------------------------------------------------

export interface InstallFlags {
  port?: number;
  dryRun?: boolean;
  fromCheckout?: boolean;
}

export async function install(ctx: ServiceContext, flags: InstallFlags): Promise<number> {
  const m = managerFor(ctx);
  const cliScript = path.join(realOr(ctx.root), 'dist', 'server', 'cli.js');
  const why = refusal(cliScript, { fromCheckout: flags.fromCheckout });
  if (why) throw new RefusalError(why);
  if (!fs.existsSync(cliScript)) throw new RefusalError(`${cliScript} doesn't exist: build Local Review first (npm run build)`);
  const node = { path: realOr(ctx.execPath), version: ctx.nodeVersion };

  // the port and environment: given now, else as installed before, else the defaults
  const before = installed(m);
  const keptPort = flags.port === undefined ? (before && portOf(before.program)) : null;
  const port = flags.port ?? keptPort ?? DEFAULT_PORT;
  const carried: Record<string, string> = {};
  for (const k of CARRIED_ENV) {
    const now = ctx.env[k];
    if (now) carried[k] = k === 'LOCAL_REVIEW_HOME' ? absoluteHome(now, ctx.userHome) : now;
    else if (before?.env[k]) carried[k] = before.env[k];
  }
  const home = dataHome(carried, ctx.userHome);
  const spec = buildSpec({ cliScript, node, port, home, carried, inheritedPath: ctx.env.PATH, userHome: ctx.userHome });
  if (!which('git', spec.env.PATH))
    throw new RefusalError(`can't find git on your PATH (${spec.env.PATH}). Local Review runs git to read your repos; install it, then run \`local-review service install\` again.`);

  const t = (p: string) => tildify(p, ctx.userHome);
  const notes = [
    ...(keptPort && keptPort !== DEFAULT_PORT ? [`Port ${port}, as it was installed (--port changes it).`] : []),
    ...CARRIED_ENV.filter((k) => carried[k] && !ctx.env[k]).map((k) => `${k}=${carried[k]}, as it was installed (uninstall first to drop it).`),
  ];
  if (flags.dryRun) {
    ctx.out(`Would write the ${m.noun} ${t(m.file)} (--dry-run: nothing written, nothing started):\n\n${m.render(spec)}\n`);
    for (const n of notes) ctx.out(`${n}\n`);
    return 0;
  }

  const st = await m.status();
  if (!st.running && (await (ctx.isListening ?? defaultIsListening)(port)))
    throw new Error(`port ${port} is already in use (is \`local-review\` running in a terminal?). Stop that first, or pick another port with --port <n>.`);
  fs.mkdirSync(path.dirname(spec.stdout), { recursive: true }); // launchd and systemd append to the logs, but won't make their directory

  const changed = await m.write(spec);
  if (st.loaded && changed) await m.restart({ reload: true });
  else await m.start();

  ctx.out(`Installed Local Review as a ${m.noun}: ${t(m.file)}${changed ? '' : ' (unchanged)'}\n`);
  for (const n of notes) ctx.out(`${n}\n`);
  if (!(await waitUntilAnswering(ctx, port))) {
    ctx.err(`local-review: the service was started, but nothing answered on http://localhost:${port} in time.\n`);
    const tail = logTail([spec.stderr, spec.stdout]);
    ctx.err(tail ? `\nThe last lines of its logs:\n${tail}` : `\nIt wrote nothing to its logs (${t(spec.stdout)}). \`local-review service status\` says more.\n`);
    return 1;
  }
  ctx.out(`It's running: http://localhost:${port}\n`);
  ctx.out(`${m.lifetime}\n`);
  ctx.out(`Data: ${t(home)}. Logs: ${t(spec.stdout)} and ${path.basename(spec.stderr)}.\n`);
  return 0;
}

export async function uninstall(ctx: ServiceContext): Promise<number> {
  const m = managerFor(ctx);
  const def = installed(m);
  const st = await m.status();
  await m.remove();
  const home = tildify(dataHome(def?.env ?? {}, ctx.userHome), ctx.userHome);
  ctx.out(
    st.installed || st.loaded
      ? `Removed Local Review's service (${tildify(m.file, ctx.userHome)}). Your data in ${home} is untouched.\n`
      : "Local Review wasn't installed as a service; nothing to do.\n",
  );
  return 0;
}

export interface StatusReport extends ServiceStatus {
  file: string;
  manager: ServiceManager['kind'];
  port: number | null;
  url: string | null;
  answering: boolean;
  node: string | null;
  cli: string | null;
  home: string | null;
  logs: { out: string; err: string } | null;
  warnings: string[];
}

export async function statusReport(ctx: ServiceContext): Promise<StatusReport> {
  const m = managerFor(ctx);
  const st = await m.status();
  const def = installed(m);
  const port = def ? portOf(def.program) : null;
  const home = def ? dataHome(def.env, ctx.userHome) : null;
  const node = def?.program[0] ?? null;
  const cli = def?.program[1] ?? null;
  const warnings: string[] = [];
  for (const [what, p] of [
    ['Node', node],
    ['Local Review', cli],
  ] as const)
    if (p && !fs.existsSync(p)) warnings.push(`The ${what} it runs, ${p}, isn't there any more: run \`local-review service install\` again.`);
  const here = path.join(realOr(ctx.root), 'dist', 'server', 'cli.js');
  if (cli && fs.existsSync(cli) && cli !== here && !refusal(here))
    warnings.push(`It runs ${cli}, not this local-review (${here}). \`local-review service install\` points it at this one.`);
  return {
    ...st,
    file: m.file,
    manager: m.kind,
    port,
    url: port ? `http://localhost:${port}` : null,
    answering: port ? await (ctx.answering ?? defaultAnswering)(port) : false,
    node,
    cli,
    home,
    logs: home ? { out: path.join(home, 'logs', 'server.out.log'), err: path.join(home, 'logs', 'server.err.log') } : null,
    warnings,
  };
}

export async function status(ctx: ServiceContext, { json = false } = {}): Promise<number> {
  const r = await statusReport(ctx);
  if (json) {
    ctx.out(JSON.stringify(r, null, 2) + '\n');
    return 0;
  }
  const t = (p: string) => tildify(p, ctx.userHome);
  const lines = [
    `Service:   ${r.installed ? t(r.file) : 'not installed (`local-review service install`)'}`,
    `Loaded:    ${r.loaded ? 'yes' : 'no'}${r.loaded && r.state ? ` (${r.state})` : ''}${r.enabled !== null ? `, ${r.enabled ? 'starts at login' : "doesn't start at login"}` : ''}`,
    `Running:   ${r.running ? `yes, pid ${r.pid}` : 'no'}${r.lastExitCode !== null ? ` (last exit status ${r.lastExitCode})` : ''}`,
    ...(r.url ? [`UI:        ${r.answering ? r.url : `nothing answering on ${r.url}`}`] : []),
    ...(r.node ? [`Node:      ${t(r.node)}`] : []),
    ...(r.cli ? [`Runs:      ${t(r.cli)}`] : []),
    ...(r.home ? [`Data:      ${t(r.home)}`] : []),
    ...(r.logs ? [`Logs:      ${t(r.logs.out)} and ${path.basename(r.logs.err)}`] : []),
    ...r.warnings.map((w) => `\nWarning: ${w}`),
  ];
  ctx.out(lines.join('\n') + '\n');
  return 0;
}

export async function restart(ctx: ServiceContext): Promise<number> {
  const m = managerFor(ctx);
  const def = installed(m);
  if (!def || !fs.existsSync(m.file)) throw new RefusalError("Local Review isn't installed as a service; install it with `local-review service install`");
  await m.restart();
  const port = portOf(def.program) ?? DEFAULT_PORT;
  if (!(await waitUntilAnswering(ctx, port))) {
    ctx.err(`local-review: restarted the service, but nothing answered on http://localhost:${port} in time.\n`);
    const home = dataHome(def.env, ctx.userHome);
    const tail = logTail([path.join(home, 'logs', 'server.err.log'), path.join(home, 'logs', 'server.out.log')]);
    if (tail) ctx.err(`\nThe last lines of its logs:\n${tail}`);
    return 1;
  }
  ctx.out(`Restarted Local Review: http://localhost:${port}\n`);
  return 0;
}

/** The context for the real thing: this process, this OS, the real launchctl / systemctl. */
export function realContext(root: string): ServiceContext {
  return {
    platform: process.platform,
    userHome: os.homedir(),
    env: process.env,
    root,
    execPath: process.execPath,
    nodeVersion: process.version,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };
}

export { RefusalError, ServiceManagerError };
