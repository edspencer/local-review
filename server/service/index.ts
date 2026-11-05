// `local-review service install | uninstall | start | stop | restart | status | logs`: run Local Review in the
// background, started at login and restarted if it exits, with the OS's own per-user service manager (manager.ts).
// Modelled on Hallway's `hallway service …` for its daemon (server/commands/services.ts there), and following
// edspencer/cli-contract's SPEC 0.1: `stop` doesn't disable, the one log file, exit 3 (not running) and 4 (not installed),
// and `stop` and `restart` refuse with 75 while the service is busy, unless --force (§4, with ../contract/busy-client.ts).
// Local Review has no config file, so the port and the environment it reads live in the service's definition, and a
// reinstall reads them back from it (they're kept unless you give new ones).
//
// What this writes: the service's definition (~/Library/LaunchAgents/local-review.server.plist or
// ~/.config/systemd/user/local-review-server.service), and the data home's logs/ directory. `uninstall` removes the
// definition and nothing else: the data home, logs included, stays as it is. `restart` rewrites the definition only
// when it's stale (an older format, or a Node or CLI that has gone), keeping what it runs otherwise. `logs` only reads.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from '../port.js';
import { ServiceManagerError, type ServiceManager, type ServiceStatus } from './manager.js';
import { type InstalledDefinition } from './manager.js';
import { checkBusy as askBusy, describeCounts, guardBusy } from '../contract/busy-client.js';
import { createOutput } from '../contract/output.js';
import { readLiveRuntimeFile } from '../contract/runtime-file.js';
import { updateNotice, updateSummary, type UpdateSummary } from '../contract/update-check.js';
import { BUSY_NOUNS } from '../busy.js';
import { CARRIED_ENV, LOG_FILE, type PlatformContext, RefusalError, buildSpec, isCheckout, managerFor, portOf, refusal, which } from './spec.js';

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
  /** Does Local Review answer on it, and as which version? Null if it doesn't. (Mocked in tests.) */
  health?: (port: number) => Promise<{ version: string | null } | null>;
  /** How often `logs --follow` looks for more. */
  pollMs?: number;
  /** Ends `logs --follow` (tests); otherwise it runs until it's interrupted. */
  signal?: AbortSignal;
  /** How the busy check asks /api/busy. (Mocked in tests.) */
  fetch?: typeof globalThis.fetch;
  /** This command's data home (config.HOME: --data-dir, LOCAL_REVIEW_HOME or ~/.local-review), for when nothing is installed. */
  dataHome?: string;
  /** This CLI's version, which `status` repeats an update check for (cli-contract SPEC §3). */
  version?: string;
}

export const SERVICE_USAGE = 'service needs one of: install, uninstall, start, stop, restart, status, logs';

/** cli-contract SPEC §2. */
export const EXIT_NOT_RUNNING = 3;
export const EXIT_NOT_INSTALLED = 4;

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

const defaultHealth = async (port: number) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = r.ok ? await r.json() : null;
    return body?.ok === true ? { version: typeof body.version === 'string' ? body.version : null } : null;
  } catch {
    return null;
  }
};
const answering = async (ctx: ServiceContext, port: number) => !!(await (ctx.health ?? defaultHealth)(port));

/** Wait (up to ctx.waitMs) until Local Review answers on `port`, or, with `gone`, until it doesn't. */
async function waitUntil(ctx: ServiceContext, port: number, { gone = false } = {}): Promise<boolean> {
  const end = Date.now() + (ctx.waitMs ?? 15_000);
  for (;;) {
    if ((await answering(ctx, port)) !== gone) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The last `lines` lines of a file, reading only as much of its end as that takes; null if it can't be read. */
export function tailLines(file: string, lines: number): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let pos = size;
    let newlines = 0;
    // one more newline than lines: the file's own trailing one
    while (pos > 0 && newlines <= lines) {
      const len = Math.min(65536, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      chunks.unshift(buf);
      for (const b of buf) if (b === 10) newlines++;
    }
    const text = Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
    return lines <= 0 || !text ? '' : text.split('\n').slice(-lines).join('\n') + '\n';
  } finally {
    fs.closeSync(fd);
  }
}

/** The last lines of the service's logs, for a start that didn't come up. */
function logTail(files: string[], lines = 20): string {
  return files
    .map((f) => {
      const tail = tailLines(f, lines);
      return tail ? `==> ${f} <==\n${tail}` : '';
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

/** The files an installed service logs to: what its definition names, else where this version would put them. */
const logsOf = (def: InstalledDefinition, userHome: string) => (def.logs.length ? def.logs : [path.join(dataHome(def.env, userHome), 'logs', LOG_FILE)]);

/** start, stop, restart and logs with no service to act on: exit 4 (cli-contract SPEC §2). */
function notInstalled(ctx: ServiceContext): number {
  ctx.err("local-review: Local Review isn't installed as a service; install it with `local-review service install`\n");
  return EXIT_NOT_INSTALLED;
}

/** The version of the Local Review whose dist/server/cli.js this is, or null. */
function versionAt(cli: string | null): string | null {
  if (!cli) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(path.dirname(cli))), 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------

export interface InstallFlags {
  port?: number;
  dryRun?: boolean;
  fromCheckout?: boolean;
  /**
   * Re-render the installed service in this version's format, from what its definition records (port, data home,
   * environment, PATH), not from this shell's environment; --port still wins. Exit 4 with nothing installed. It's what
   * `update` runs through the new version's CLI (cli-contract SPEC §1, §5 step 11).
   */
  refresh?: boolean;
}

export async function install(ctx: ServiceContext, flags: InstallFlags): Promise<number> {
  const m = managerFor(ctx);
  const before = installed(m);
  if (flags.refresh && !before) {
    ctx.err("local-review: Local Review isn't installed as a service, so there's nothing to refresh; install it with `local-review service install`\n");
    return EXIT_NOT_INSTALLED;
  }
  const cliScript = path.join(realOr(ctx.root), 'dist', 'server', 'cli.js');
  // a refresh keeps a service that was installed from a checkout on purpose
  const why = refusal(cliScript, { fromCheckout: flags.fromCheckout || (flags.refresh && !!before?.program[1] && isCheckout(before.program[1])) });
  if (why) throw new RefusalError(why);
  if (!fs.existsSync(cliScript)) throw new RefusalError(`${cliScript} doesn't exist: build Local Review first (npm run build)`);
  const node = { path: realOr(ctx.execPath), version: ctx.nodeVersion };

  // the port and environment: given now, else as installed before, else the defaults. A refresh reads only the
  // definition: what this shell happens to export isn't what the service was installed with
  const keptPort = flags.port === undefined ? (before && portOf(before.program)) : null;
  const port = flags.port ?? keptPort ?? DEFAULT_PORT;
  const carried: Record<string, string> = {};
  for (const k of CARRIED_ENV) {
    const now = flags.refresh ? undefined : ctx.env[k];
    if (now) carried[k] = k === 'LOCAL_REVIEW_HOME' ? absoluteHome(now, ctx.userHome) : now;
    else if (before?.env[k]) carried[k] = before.env[k];
  }
  const userHome = (flags.refresh && before?.env.HOME) || ctx.userHome;
  const inheritedPath = flags.refresh ? (before?.env.PATH ?? ctx.env.PATH) : ctx.env.PATH;
  const home = dataHome(carried, userHome);
  const spec = buildSpec({ cliScript, node, port, home, carried, inheritedPath, userHome });
  if (!which('git', spec.env.PATH))
    throw new RefusalError(`can't find git on your PATH (${spec.env.PATH}). Local Review runs git to read your repos; install it, then run \`local-review service install\` again.`);

  const t = (p: string) => tildify(p, ctx.userHome);
  const notes = flags.refresh
    ? []
    : [
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
  fs.mkdirSync(path.dirname(spec.log), { recursive: true }); // launchd and systemd append to the logs, but won't make their directory

  const changed = await m.write(spec);
  // A service that's running is replaced, not left serving the old process: systemd's start (like `enable --now`)
  // leaves an active unit alone (cli-contract SPEC §1, §7). A refresh restarts it whatever it's doing: `update` runs
  // it to bring up the version it has just installed. A first install only starts: systemd allows five starts in ten
  // seconds.
  if (st.loaded && (changed || st.running || flags.refresh)) await m.restart({ reload: changed });
  else await m.start();

  ctx.out(`${flags.refresh ? 'Refreshed' : 'Installed'} Local Review as a ${m.noun}: ${t(m.file)}${changed ? '' : ' (unchanged)'}\n`);
  for (const n of notes) ctx.out(`${n}\n`);
  if (!(await waitUntil(ctx, port))) {
    ctx.err(`local-review: the service was started, but nothing answered on http://localhost:${port} in time.\n`);
    const tail = logTail([spec.log]);
    ctx.err(tail ? `\nThe last lines of its log:\n${tail}` : `\nIt wrote nothing to its log (${t(spec.log)}). \`local-review service status\` says more.\n`);
    return 1;
  }
  ctx.out(`It's running: http://localhost:${port}\n`);
  if (flags.refresh) return 0;
  ctx.out(`${m.lifetime}\n`);
  ctx.out(`Data: ${t(home)}. Log: ${t(spec.log)} (\`local-review service logs\`).\n`);
  return 0;
}

/** Nothing answered after a start: say so, with the last lines of its log. Exit 1. */
function didntAnswer(ctx: ServiceContext, what: string, port: number, def: InstalledDefinition): number {
  ctx.err(`local-review: ${what}, but nothing answered on http://localhost:${port} in time.\n`);
  const tail = logTail(logsOf(def, ctx.userHome));
  if (tail) ctx.err(`\nThe last lines of its log:\n${tail}`);
  return 1;
}

export async function start(ctx: ServiceContext): Promise<number> {
  const m = managerFor(ctx);
  const def = installed(m);
  if (!def) return notInstalled(ctx);
  const port = portOf(def.program) ?? DEFAULT_PORT;
  const st = await m.status();
  if (st.running && (await answering(ctx, port))) {
    ctx.out(`Local Review is already running: http://localhost:${port}\n`);
    return 0;
  }
  if (!st.running && (await (ctx.isListening ?? defaultIsListening)(port)))
    throw new Error(`port ${port} is already in use (is \`local-review\` running in a terminal?). Stop that first, or move the service with \`local-review service install --port <n>\`.`);
  await m.start();
  if (!(await waitUntil(ctx, port))) return didntAnswer(ctx, 'started the service', port, def);
  ctx.out(`Started Local Review: http://localhost:${port}\n`);
  return 0;
}

/**
 * cli-contract SPEC §4: before a stop or restart, ask the service (on the port its definition names) whether it's
 * busy. Null to go ahead; 75 after printing the refusal. With --force, the same message prefixed `Overriding:`.
 * Nothing answering goes ahead: there's nothing to cut short.
 */
function checkBusy(ctx: ServiceContext, def: InstalledDefinition, port: number, force: boolean, what: string) {
  return guardBusy({
    home: dataHome(def.env, ctx.userHome),
    url: `http://127.0.0.1:${port}`,
    name: 'Local Review',
    nouns: BUSY_NOUNS,
    force,
    fetch: ctx.fetch,
    hint: `Try again once it has finished (\`local-review busy\` says when), or ${what} it anyway with --force.`,
    out: createOutput({ tool: 'local-review', stdout: { write: ctx.out }, stderr: { write: ctx.err } }),
  });
}

/** Stop it until `service start` or the next login: it stays installed and enabled (cli-contract SPEC §1). */
export async function stop(ctx: ServiceContext, { force = false } = {}): Promise<number> {
  const m = managerFor(ctx);
  const def = installed(m);
  if (!def) return notInstalled(ctx);
  const port = portOf(def.program) ?? DEFAULT_PORT;
  const st = await m.status();
  if (st.running) {
    const refused = await checkBusy(ctx, def, port, force, 'stop');
    if (refused !== null) return refused;
  }
  await m.stop();
  if (!(await waitUntil(ctx, port, { gone: true }))) {
    ctx.err(`local-review: stopped the service, but something still answers on http://localhost:${port} (is \`local-review\` running in a terminal?)\n`);
    return 1;
  }
  ctx.out(`${st.running ? 'Stopped Local Review.' : "Local Review's service wasn't running."} ${m.stopped} To keep it off, \`local-review service uninstall\`.\n`);
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
  /** The version that answers, from its /api/health. */
  version: string | null;
  /** The same, by the name cli-contract's schemas/service-status.schema.json gives it. */
  runningVersion: string | null;
  /** The service's file when it's installed (`file` is where it would be either way). */
  unit: string | null;
  /** What its /api/busy said, when it answers. */
  busy?: { busy: boolean; counts: Record<string, number> };
  /** The version of the Local Review the service runs, on disk (what a restart would run). */
  installedVersion: string | null;
  node: string | null;
  cli: string | null;
  home: string | null;
  /** Its log file (`service logs`). */
  log: string | null;
  warnings: string[];
  /** What the last `update --check` (or `doctor`) found, from <data>/update-check.json; left out, never null, when there's nothing to repeat. */
  update?: UpdateSummary;
}

export async function statusReport(ctx: ServiceContext): Promise<StatusReport> {
  const m = managerFor(ctx);
  let st: ServiceStatus;
  try {
    st = await m.status();
  } catch (e) {
    // no service file, and no service manager to ask (a container without systemd): not installed, all the same
    if (!(e instanceof ServiceManagerError) || fs.existsSync(m.file)) throw e;
    st = { installed: false, loaded: false, running: false, pid: null, lastExitCode: null, state: null, enabled: null };
  }
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
  const logs = def ? logsOf(def, ctx.userHome) : [];
  if (logs.length > 1) warnings.push(`It logs to ${logs.join(' and ')}, as an older Local Review set it up. \`local-review service restart\` moves it to one file, logs/${LOG_FILE}.`);
  const health = port && st.running ? await (ctx.health ?? defaultHealth)(port) : null;
  const installedVersion = versionAt(cli);
  const busy = health && port ? await askBusy({ home: home!, url: `http://127.0.0.1:${port}`, fetch: ctx.fetch }) : null;
  if (health?.version && installedVersion && health.version !== installedVersion)
    warnings.push(`It's running ${health.version}, but ${installedVersion} is installed: \`local-review service restart\` runs ${installedVersion}.`);
  // never asks the registry: it repeats what `update --check` or `doctor` last found, for this version (SPEC §3)
  const updateHome = home ?? ctx.dataHome;
  const update = updateHome && ctx.version ? updateSummary(updateHome, { currentVersion: ctx.version }) : undefined;
  return {
    ...st,
    file: m.file,
    manager: m.kind,
    port,
    url: port ? `http://localhost:${port}` : null,
    answering: !!health,
    version: health?.version ?? null,
    runningVersion: health?.version ?? null,
    unit: st.installed ? m.file : null,
    ...(busy && (busy.state === 'busy' || busy.state === 'idle') ? { busy: { busy: busy.answer.busy, counts: busy.answer.counts ?? {} } } : {}),
    installedVersion,
    node,
    cli,
    home,
    log: logs[0] ?? null,
    warnings,
    ...(update ? { update } : {}),
  };
}

/** status's exit code: 0 running and answering, 3 installed but not, 4 not installed (cli-contract SPEC §2). */
export const statusCode = (r: StatusReport) => (!r.installed ? EXIT_NOT_INSTALLED : r.running && r.answering ? 0 : EXIT_NOT_RUNNING);

export async function status(ctx: ServiceContext, { json = false } = {}): Promise<number> {
  const r = await statusReport(ctx);
  if (json) {
    ctx.out(JSON.stringify(r, null, 2) + '\n');
    // the prose goes to stderr, so it says the same with --json (cli-contract SPEC §3)
    if (r.update?.updateAvailable && ctx.version) ctx.err(`${updateNoticeFor(ctx.version, r.update.latest)}\n`);
    return statusCode(r);
  }
  const t = (p: string) => tildify(p, ctx.userHome);
  const lines = [
    `Service:   ${r.installed ? t(r.file) : 'not installed (`local-review service install`)'}`,
    `Loaded:    ${r.loaded ? 'yes' : 'no'}${r.loaded && r.state ? ` (${r.state})` : ''}${r.enabled !== null ? `, ${r.enabled ? 'starts at login' : "doesn't start at login"}` : ''}`,
    `Running:   ${r.running ? `yes, pid ${r.pid}` : 'no'}${r.lastExitCode !== null ? ` (last exit status ${r.lastExitCode})` : ''}`,
    ...(r.url ? [`UI:        ${r.answering ? r.url : `nothing answering on ${r.url}`}`] : []),
    ...(r.busy ? [`Busy:      ${r.busy.busy ? `yes (${describeCounts(r.busy.counts, BUSY_NOUNS) || 'busy'})` : 'no'}`] : []),
    ...(r.installedVersion ? [`Version:   ${r.installedVersion}`] : []),
    ...(r.node ? [`Node:      ${t(r.node)}`] : []),
    ...(r.cli ? [`Runs:      ${t(r.cli)}`] : []),
    ...(r.home ? [`Data:      ${t(r.home)}`] : []),
    ...(r.log ? [`Log:       ${t(r.log)}`] : []),
    ...r.warnings.map((w) => `\nWarning: ${w}`),
  ];
  ctx.out(lines.join('\n') + '\n');
  if (r.update?.updateAvailable && ctx.version) ctx.err(`\n${updateNoticeFor(ctx.version, r.update.latest)}\n`);
  return statusCode(r);
}

/**
 * The definition this version would write for an installed service: the same Node, CLI, port and environment, in
 * this version's format. If the Node or CLI it names has gone, this local-review and its Node instead. Null when the
 * definition can't be read well enough to keep what it runs.
 */
function refreshedSpec(ctx: ServiceContext, def: InstalledDefinition) {
  let [nodePath, cliScript] = def.program;
  const port = portOf(def.program);
  if (!nodePath || !cliScript || !port) return null;
  let node = { path: nodePath, version: def.nodeVersion ?? 'unknown' };
  let moved = false;
  if (!fs.existsSync(nodePath) || !fs.existsSync(cliScript)) {
    const here = path.join(realOr(ctx.root), 'dist', 'server', 'cli.js');
    const why = refusal(here) ?? (fs.existsSync(here) ? null : `${here} doesn't exist`);
    if (why) throw new RefusalError(`the Node or Local Review the service runs (${nodePath}, ${cliScript}) has gone, and this local-review can't take its place: ${why}`);
    node = { path: realOr(ctx.execPath), version: ctx.nodeVersion };
    cliScript = here;
    moved = true;
  }
  const carried: Record<string, string> = {};
  for (const k of CARRIED_ENV) if (def.env[k]) carried[k] = def.env[k];
  const userHome = def.env.HOME || ctx.userHome;
  return { moved, spec: buildSpec({ cliScript, node, port, home: dataHome(carried, userHome), carried, inheritedPath: def.env.PATH, userHome }) };
}

export async function restart(ctx: ServiceContext, { force = false } = {}): Promise<number> {
  const m = managerFor(ctx);
  const def = installed(m);
  if (!def || !fs.existsSync(m.file)) return notInstalled(ctx);
  const refused = await checkBusy(ctx, def, portOf(def.program) ?? DEFAULT_PORT, force, 'restart');
  if (refused !== null) return refused;
  // a stale definition (an older format, or what it runs has gone) is rewritten first (cli-contract SPEC §1)
  const fresh = refreshedSpec(ctx, def);
  let changed = false;
  if (fresh) {
    fs.mkdirSync(path.dirname(fresh.spec.log), { recursive: true });
    changed = await m.write(fresh.spec);
  }
  if (changed) await m.restart({ reload: true });
  else await m.restart();
  const port = portOf(def.program) ?? DEFAULT_PORT;
  if (changed)
    ctx.out(
      `Updated its ${m.noun} (${tildify(m.file, ctx.userHome)})${fresh!.moved ? `: it runs ${tildify(fresh!.spec.program[1], ctx.userHome)} now, with Node ${fresh!.spec.node.version}` : ''}. Log: ${tildify(fresh!.spec.log, ctx.userHome)}.\n`,
    );
  if (!(await waitUntil(ctx, port))) return didntAnswer(ctx, 'restarted the service', port, fresh && changed ? { ...def, logs: [fresh.spec.log] } : def);
  ctx.out(`Restarted Local Review: http://localhost:${port}\n`);
  return 0;
}

export interface LogsFlags {
  follow?: boolean;
  /** How many lines from the end (default 50). */
  lines?: number;
}

/** `service logs [-f] [-n <lines>]`: the end of the service's log file, and with -f what it writes next. Only reads. */
export async function logs(ctx: ServiceContext, { follow = false, lines = 50 }: LogsFlags = {}): Promise<number> {
  const m = managerFor(ctx);
  const def = installed(m);
  if (!def) return notInstalled(ctx);
  const files = logsOf(def, ctx.userHome);
  const t = (p: string) => tildify(p, ctx.userHome);
  if (files.length > 1) ctx.err(`(An older Local Review set this service up with two log files. \`local-review service restart\` moves it to one, logs/${LOG_FILE}.)\n`);
  const offsets = new Map<string, number>();
  for (const f of files) {
    const tail = tailLines(f, lines);
    if (files.length > 1) ctx.out(`==> ${f} <==\n`);
    if (tail === null) ctx.err(`No log yet at ${t(f)}${files.length > 1 ? '' : ': the service writes it when it starts'}.\n`);
    else ctx.out(tail);
    offsets.set(f, sizeOf(f));
  }
  if (!follow) return 0;
  let last = files.at(-1);
  await new Promise<void>((resolve) => {
    const tick = () => {
      for (const f of files) {
        const size = sizeOf(f);
        let from = offsets.get(f) ?? 0;
        if (size < from) from = 0; // truncated or replaced: from its start
        if (size > from) {
          if (files.length > 1 && last !== f) ctx.out(`\n==> ${f} <==\n`);
          last = f;
          ctx.out(readRange(f, from, size));
        }
        offsets.set(f, size);
      }
    };
    const timer = setInterval(tick, ctx.pollMs ?? 500);
    ctx.signal?.addEventListener('abort', () => {
      clearInterval(timer);
      tick();
      resolve();
    });
  });
  return 0;
}

const sizeOf = (f: string) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
};

function readRange(f: string, from: number, to: number): string {
  const fd = fs.openSync(f, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** SPEC §3's notice, as `status` repeats it from the cache. */
export const updateNoticeFor = (current: string, latest: string) =>
  updateNotice({ name: 'Local Review', current, target: latest, command: 'local-review update', changelog: changelogUrl(latest) });

/** The release notes for a version: the notice's `Changes:` line. */
export const changelogUrl = (v: string) => `https://github.com/edspencer/local-review/releases/tag/v${v}`;

// ---------------------------------------------------------------------------------------------------------------
// What `local-review update` needs from the service (cli-contract SPEC §5): ../update.ts
// ---------------------------------------------------------------------------------------------------------------

export interface UpdateServiceHooks {
  /** The data home for update.lock and update-check.json: the service's, when one is installed (what `status` reads). */
  home: string;
  /** Where the busy check asks: the port the installed service's definition names, else runtime.json. */
  busyUrl?: string;
  hooks: {
    inspect(): { installed: boolean; running: boolean; url?: string; log?: string };
    stop(): void;
    refresh(cli: string): { status: number | null; stdout: string; stderr: string };
    tail(lines: number): string;
  };
}

/**
 * The service, for `update`. Its stop and refresh run a CLI as a child, synchronously, as update.ts's hooks are: the
 * stop is this CLI's own `service stop --force` (update has asked the busy question already), and the refresh is
 * `<node> <cli> service install --refresh` with whichever CLI update names (the new one, or the old one on a rollback).
 */
export async function updateHooks(ctx: ServiceContext, self: { cli: string; execArgv?: string[] }): Promise<UpdateServiceHooks> {
  const m = managerFor(ctx);
  const first = installed(m);
  const home = first ? dataHome(first.env, ctx.userHome) : (ctx.dataHome ?? dataHome(ctx.env, ctx.userHome));
  const portNow = () => {
    const def = installed(m);
    return def ? (portOf(def.program) ?? DEFAULT_PORT) : null;
  };
  const firstPort = portNow();
  // is the service answering now? Only a hint for update's question; it never decides anything
  const running = firstPort !== null && (await answering(ctx, firstPort));
  const node = ctx.execPath;
  const run = (args: string[]) => {
    const r = spawnSync(node, args, { encoding: 'utf8', timeout: 120_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
  };
  return {
    home,
    ...(firstPort !== null ? { busyUrl: `http://127.0.0.1:${firstPort}` } : {}),
    hooks: {
      inspect() {
        const def = installed(m);
        if (!def) {
          // a foreground `serve`, found the only honest way: its runtime.json (never a guessed port)
          const live = readLiveRuntimeFile(home);
          return { installed: false, running: live !== null, ...(live ? { url: live.url } : {}) };
        }
        return { installed: true, running, url: `http://127.0.0.1:${portOf(def.program) ?? DEFAULT_PORT}`, log: logsOf(def, ctx.userHome)[0] };
      },
      stop() {
        const r = run([...(self.execArgv ?? []), self.cli, 'service', 'stop', '--force']);
        if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^local-review: /, '') || `service stop exited ${r.status}`);
      },
      refresh: (cli) => run([cli, 'service', 'install', '--refresh']),
      tail(lines) {
        const def = installed(m);
        return (def && tailLines(logsOf(def, ctx.userHome)[0], lines)) || '';
      },
    },
  };
}

/** The context for the real thing: this process, this OS, the real launchctl / systemctl. */
export function realContext(root: string, o: { dataHome?: string; version?: string } = {}): ServiceContext {
  return {
    ...o,
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
