// `local-review doctor [--json] [--offline]`: cli-contract SPEC §1's checks, each a ✓ / ! / ✗ line, with a `fix:` line
// under every failure. It grows out of the warnings `service status` prints (service/index.ts's statusReport), plus the
// spec's own checks (Node against `engines`, how it was installed, the port, linger, the data home, a newer version)
// and Local Review's (git, which it can't work without, and gh, which publishing and the GitHub sync use).
// Exit 1 if any check failed; warnings don't change it.
//
// It only reads, apart from <data>/update-check.json: like `update --check`, it writes what it found there, so
// `service status` can repeat it (SPEC §3). It asks the npm registry only because a person ran it; --offline doesn't.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describeInstall, detectInstall, updateCommand, type InstallInfo } from './contract/install-method.js';
import { fetchHealth } from './contract/health.js';
import { npmConfigGet, npmGlobalRoot } from './contract/package-manager.js';
import { RegistryError, resolveRegistry, resolveTarget } from './contract/registry.js';
import { readLiveRuntimeFile } from './contract/runtime-file.js';
import { compareVersions, isPrerelease, satisfiesEngines } from './contract/semver.js';
import { updateNotice, writeUpdateCheck } from './contract/update-check.js';
import { DEFAULT_PORT } from './port.js';
import { type ServiceContext, changelogUrl, statusReport } from './service/index.js';
import { which } from './service/spec.js';
import { lingerOf, lingerUser } from './service/linger.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface Check {
  /** Stable, for scripts: the spec's own (node-engines, install-method, unit, running-version, port, linger, data-home, update), then git and gh. */
  id: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

const MARK: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✗', skip: '-' };

export interface DoctorInput {
  ctx: ServiceContext;
  /** This CLI's version, and the package's `engines.node`. */
  version: string;
  engines: string | undefined;
  /** This command's data home (config.HOME). */
  home: string;
  /** process.argv[1], for SPEC §6's walk-up. */
  entry: string;
  offline?: boolean;
  /** Mocked in tests. */
  nodeVersion?: string;
  npmGlobalRoot?: () => string | undefined;
  registry?: string;
  isListening?: (port: number) => Promise<boolean>;
  /** Linux's linger for this user: true, false, or null when loginctl can't say. */
  linger?: () => Promise<boolean | null>;
  /** The PATH git and gh are looked for on. */
  path?: string;
}

const tildify = (p: string, home: string) => (p === home ? '~' : p.startsWith(home + '/') ? `~${p.slice(home.length)}` : p);

export async function diagnose(i: DoctorInput): Promise<{ checks: Check[]; notice?: string }> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const ctx = i.ctx;
  const t = (p: string) => tildify(p, ctx.userHome);
  let notice: string | undefined;

  // ---- this Node against the package's engines
  const nodeVersion = i.nodeVersion ?? process.versions.node;
  const engines = satisfiesEngines(nodeVersion, i.engines ? { node: i.engines } : undefined);
  if (engines.ok === false)
    add({ id: 'node-engines', status: 'fail', message: `Node ${nodeVersion} is too old: Local Review ${i.version} needs Node ${i.engines}`, fix: `install Node ${i.engines} (with nvm, fnm, Homebrew, …), then run local-review with it` });
  else add({ id: 'node-engines', status: 'pass', message: `Node ${nodeVersion}${i.engines ? ` (Local Review needs ${i.engines})` : ''}` });

  // ---- how it was installed (SPEC §6)
  const info: InstallInfo = detectInstall({ packageName: 'local-review', envPrefix: 'LOCAL_REVIEW', entry: i.entry, env: ctx.env, npmGlobalRoot: i.npmGlobalRoot ?? (() => npmGlobalRoot({ env: ctx.env })) });
  const how = describeInstall(info, 'local-review');
  if (info.canUpdate) add({ id: 'install-method', status: 'pass', message: `Local Review ${i.version}, ${how}: \`local-review update\` can update it` });
  else {
    const cmd = updateCommand(info, { packageName: 'local-review', checkoutCommand: 'git pull && npm install && npm run build' });
    add({ id: 'install-method', status: 'warn', message: `Local Review ${i.version}, ${how}: \`local-review update\` can't update it`, fix: `${cmd.command}${cmd.note ? `    (${cmd.note})` : ''}` });
  }

  // ---- the service: what `service status` warns about
  let report: Awaited<ReturnType<typeof statusReport>> | null = null;
  try {
    report = await statusReport(ctx);
  } catch (e) {
    add({ id: 'unit', status: 'warn', message: `couldn't ask the service manager: ${(e as Error).message}` });
  }
  if (report && !report.installed) add({ id: 'unit', status: 'skip', message: "it isn't installed as a service (`local-review service install` runs it in the background)" });
  else if (report) {
    // the running-version warning is the next check's
    const warnings = report.warnings.filter((w) => !/^It's running /.test(w));
    if (!warnings.length) add({ id: 'unit', status: 'pass', message: `the service is installed (${report.manager}): ${t(report.file)}` });
    for (const w of warnings)
      add(/isn't there any more/.test(w) ? { id: 'unit', status: 'fail', message: w, fix: '`local-review service install` (it keeps the port and the data home)' } : { id: 'unit', status: 'warn', message: w });
  }

  // ---- the running version is the installed one: the service's, or a `serve` in a terminal
  const live = readLiveRuntimeFile(i.home);
  const running = report?.answering ? { version: report.runningVersion, where: report.url!, installed: report.installedVersion, via: 'service' as const } : live ? { version: live.version, where: live.url, installed: i.version, via: 'serve' as const } : null;
  if (!running) add({ id: 'running-version', status: 'skip', message: "Local Review isn't running" });
  else if (running.version && running.installed && running.version !== running.installed)
    add({
      id: 'running-version',
      status: 'fail',
      message: `${running.where} is running ${running.version}, but ${running.installed} is installed: it's still running the code it started with`,
      fix: running.via === 'service' ? '`local-review service restart`' : 'stop the `local-review` in its terminal (Ctrl-C) and start it again',
    });
  else add({ id: 'running-version', status: 'pass', message: `${running.where} is running ${running.version ?? 'an unknown version'}${running.via === 'serve' ? ' (in a terminal)' : ''}` });

  // ---- the port: free, or held by Local Review
  const port = report?.port ?? live?.port ?? DEFAULT_PORT;
  const listening = await (i.isListening ?? defaultIsListening)(port);
  const health = listening ? await fetchHealth({ url: `http://127.0.0.1:${port}`, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) }) : undefined;
  if (!listening) add({ id: 'port', status: 'pass', message: `port ${port} is free` });
  else if (health) add({ id: 'port', status: 'pass', message: `port ${port} is Local Review's${health.version ? ` (${health.version})` : ''}` });
  else
    add({
      id: 'port',
      status: 'fail',
      message: `something that isn't Local Review is listening on port ${port}`,
      fix: report?.installed ? `stop it, or move the service: \`local-review service install --port <n>\`` : `stop it, or run Local Review on another port: \`local-review --port <n>\``,
    });

  // ---- linger, on Linux: without it the service stops when you log out
  if (ctx.platform !== 'linux') add({ id: 'linger', status: 'skip', message: 'linger is a Linux thing' });
  else {
    const user = lingerUser(ctx.env);
    const on = await (i.linger ?? (() => lingerOf(user)))();
    if (on === true) add({ id: 'linger', status: 'pass', message: `linger is on for ${user}: the service runs while you're logged out, and starts at boot` });
    else if (on === false && report?.installed)
      add({ id: 'linger', status: 'warn', message: `linger is off for ${user}: the service stops when you log out, and starts only when you log in`, fix: `sudo loginctl enable-linger ${user}` });
    else if (on === false) add({ id: 'linger', status: 'pass', message: `linger is off for ${user}, which only matters once it's a service (then: sudo loginctl enable-linger ${user})` });
    else add({ id: 'linger', status: 'skip', message: "couldn't ask loginctl about linger" });
  }

  // ---- the data home
  const home = report?.home ?? i.home;
  const writable = writableOrCreatable(home);
  if (writable === true) add({ id: 'data-home', status: 'pass', message: `the data home ${t(home)} is writable` });
  else if (writable === 'creatable') add({ id: 'data-home', status: 'pass', message: `the data home ${t(home)} doesn't exist yet; it's made the first time Local Review writes to it` });
  else add({ id: 'data-home', status: 'fail', message: `the data home ${t(home)} isn't writable: ${writable}`, fix: `check its permissions, or use another one with --data-dir <path> (or LOCAL_REVIEW_HOME)` });

  // ---- Local Review's own: git (it reads every repo with it) and gh (publishing, the GitHub sync)
  const pathVar = i.path ?? ctx.env.PATH ?? '';
  const git = which('git', pathVar);
  if (git) add({ id: 'git', status: 'pass', message: `git: ${t(git)}` });
  else add({ id: 'git', status: 'fail', message: "git isn't on your PATH: Local Review reads your repos with it", fix: 'install git (https://git-scm.com/downloads)' });
  const gh = which('gh', pathVar);
  if (gh) add({ id: 'gh', status: 'pass', message: `gh: ${t(gh)}` });
  else add({ id: 'gh', status: 'warn', message: "gh isn't on your PATH: publishing PRs and the GitHub sync need it", fix: 'install the GitHub CLI (https://cli.github.com), then `gh auth login`' });

  // ---- a newer version (SPEC §1): the only check that asks the network, and --offline skips it
  if (i.offline) add({ id: 'update', status: 'skip', message: 'not asking the registry for a newer version (--offline)' });
  else {
    try {
      const target = await resolveTarget({ packageName: 'local-review', registry: i.registry ?? resolveRegistry(ctx.env, (k) => npmConfigGet(k, { env: ctx.env })), ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
      const cmp = compareVersions(target.version, i.version);
      const available = cmp > 0 && !isPrerelease(target.version);
      const cmd = info.canUpdate ? { command: 'local-review update' } : updateCommand(info, { packageName: 'local-review', target: target.version, checkoutCommand: 'git pull && npm install && npm run build' });
      writeUpdateCheck(home, {
        name: 'local-review',
        current: i.version,
        target: target.version,
        tag: target.tag,
        updateAvailable: available,
        installMethod: info.method,
        canUpdate: info.canUpdate,
        command: available ? cmd.command : null,
        engines: target.engines,
        nodeOk: satisfiesEngines(nodeVersion, target.engines !== null ? { node: target.engines } : undefined).ok !== false,
        changelog: changelogUrl(target.version),
        checkedAt: new Date().toISOString(),
      });
      if (available) {
        notice = updateNotice({ name: 'Local Review', current: i.version, target: target.version, command: cmd.command, ...(cmd.note ? { note: cmd.note } : {}), changelog: changelogUrl(target.version) });
        add({ id: 'update', status: 'warn', message: `Local Review ${target.version} is available (you have ${i.version})`, fix: cmd.command });
      } else add({ id: 'update', status: 'pass', message: cmp < 0 ? `${i.version} is newer than the registry's latest (${target.version})` : `${i.version} is the latest` });
    } catch (e) {
      add({ id: 'update', status: 'warn', message: `couldn't ask the registry for a newer version: ${e instanceof RegistryError ? `${e.message} (${e.url})` : (e as Error).message}`, fix: 'check your network, or skip this check with --offline' });
    }
  }
  return { checks, ...(notice ? { notice } : {}) };
}

/** The checklist, for a person. */
export function renderChecks(checks: Check[]): string {
  return checks.map((c) => `${MARK[c.status]} ${c.message}${c.fix && c.status !== 'pass' && c.status !== 'skip' ? `\n    fix: ${c.fix}` : ''}`).join('\n') + '\n';
}

export const doctorCode = (checks: Check[]) => (checks.some((c) => c.status === 'fail') ? 1 : 0);

/** True if `dir` is writable; 'creatable' if it doesn't exist but its nearest existing parent is; else why not. */
function writableOrCreatable(dir: string): true | 'creatable' | string {
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return 'no part of it exists';
    probe = parent;
  }
  try {
    if (!fs.statSync(probe).isDirectory()) return `${probe} isn't a directory`;
    fs.accessSync(probe, fs.constants.W_OK);
    return probe === dir ? true : 'creatable';
  } catch (e) {
    return (e as Error).message;
  }
}

const defaultIsListening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(1000);
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('timeout', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(false));
  });
