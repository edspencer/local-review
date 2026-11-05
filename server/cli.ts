#!/usr/bin/env node
// `local-review [command] …`: the command-line entry point (the package's bin; `npm run lr -- …` from a checkout).
// With no command it serves the UI. `plan` and `guide` are read-only: they never write a file and never run gh (or
// anything but read-only git, via server/git.ts). `init` only ever creates a new project.yaml, never replaces one.
// `examples` only ever creates (the example projects and their repos); `examples remove` renames, never deletes.
// `asset add` only ever creates a new, content-named image file; `asset url` writes only the asset's own <name>.yaml.
// `move` copies prs / reviews files into another project (create-only) and renames the originals to .bak.
// `github refresh` reads GitHub (gh api graphql queries only, server/gh.ts) and writes only its own cache, <data>/github/;
// `github status` reads that cache and config.yaml, nothing else.
// `service` writes only its own LaunchAgent / systemd user unit (and makes the data home's logs/), never user data;
// `service logs` only reads its log. `busy` only asks the running instance's /api/busy.
// `update` asks the npm registry, then installs local-review with npm and refreshes the service (server/update.ts);
// it writes <data>/update.lock and update-check.json, never user data. `doctor` only reads, apart from
// update-check.json (server/doctor.ts). They're the only commands that ask the registry, and only when run.
// `serve` writes <data>/runtime.json (its pid, port, URL and version, for `busy`), and removes it when it exits; it
// rotates the service's own log, <data>/logs/service.log (contract/rotate.ts), and touches no other log.
// First: `--data-dir` sets LOCAL_REVIEW_HOME before config.ts reads it.
import './datadir.js';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_GUIDE, DEFAULT_PORT, EXAMPLE_PROJECT, HOME, PROJECTS_DIR, ROOT, SAFE_NAME, parsePort } from './config.js';
import { loadProject } from './projects.js';
import { buildPlan, planMarkdown, planYaml } from './plan.js';
import { ExistsError, atomicWrite } from './safefs.js';
import { AssetError, addAsset, setPublishedUrl } from './assets.js';
import { MAX_ASSET_BYTES, typeOfName } from '../shared/assets.js';

const USAGE = `Usage: local-review [--data-dir <path>] [serve] [--port <n>] [--quiet]
       local-review plan <project> [--repo <name>] [--stack <n>] [--include-follow-on] [--format md|json|yaml]
       local-review init <project>
       local-review asset add <project> <file> [--alt <text>]
       local-review asset url <project> <name> <url>
       local-review move <from> <to> <repo> (<sha>… | --stack <n>) [--to-repo <name>] [--dry-run]
       local-review examples [remove]
       local-review github refresh [<project>] | status [<project>]
       local-review service install [--port <n>] [--dry-run] [--from-checkout] [--refresh] [--json]
       local-review service uninstall | start | status [--json]
       local-review service stop | restart [--force] [--json]
       local-review service logs [-f] [-n <lines>]
       local-review busy [--json]
       local-review update [--check] [--to <version|tag>] [--yes] [--force] [--json]
       local-review doctor [--json] [--offline]
       local-review guide
       local-review --version | --help

  serve   (the default) Serve the review UI and API on http://localhost:<port> (127.0.0.1 only).
          --port <n>       the port (default ${DEFAULT_PORT}, or $PORT)
          It prints \`Local Review <version>: <url>\` first, then the projects directory and a hint for agents.
          --quiet, -q      print just that first line: no banner, no hint for agents
                           (the banner is only shown on a terminal anyway, on stderr)
  plan    For each PR in scope, in order: commit, status (draft / ready / published), branch (with its
          status), base, title and the exact full body (project intro, stack note, ---, PR description), plus
          any recorded github: info and the comments the reviewer marked for the GitHub PR (with file and
          line). Warns about stacks with draft PRs, GitHub bases that differ from the plan's, published PRs
          that landed upstream without being frozen, and comments for GitHub not posted yet. Landed
          (merged) PRs are never planned. Read-only.
          --repo <name>    one repo of the project
          --stack <n>      one declared stack (1-based, as in project.yaml); needs --repo if several repos have it.
                           Naming a follow-on stack plans it (with a note).
          --include-follow-on
                           also plan follow-on stacks (follow_on: true, parked work); left out by default
          --format <f>     md (default), json or yaml
  init    Create a project to review: <projects>/<project>/project.yaml, a commented example to edit.
          Never replaces an existing one.
  asset add
          Copy an image (PNG, JPEG, GIF, WebP or SVG, up to 5 MB) into the project's assets folder, named by its
          content, and print the markdown that shows it, e.g. ![alt](assets/3f2a9c1e0b7d4a65.png), for a PR
          description, stack note or project intro. Adding the same image again is a no-op.
          --alt <text>     the alt text (default: the file name)
  asset url
          Record where an asset is published (a URL GitHub's readers can reach), so \`plan\` puts that URL in
          the bodies instead of the local assets/<name> reference.
  move    Move PRs' review data (prs/ and reviews/ files: titles, descriptions, readiness, branches, comments,
          Viewed marks) from project <from> to project <to>, e.g. after splitting a project into linked projects.
          Each file is copied into <to> (never over an existing one: then nothing is moved) and the original is
          renamed to <sha>.moved-to-<to>.yaml.bak; images the descriptions show are copied too. A snapshot is
          taken first. project.yaml files aren't edited: what's left to change there is printed.
          <sha>…           commit shas or unique prefixes (7+ hex), in <from>'s range or with a file there
          --stack <n>      instead: every commit of declared stack <n> of <repo> in <from>
          --to-repo <name> the repo's name in <to>, if it differs
          --dry-run        print what it would do; write nothing
  examples
          Add the example projects: "Orchard", a made-up app in four repos, to click around before reviewing your
          own work. Makes the repos in <data>/examples/ and the projects as projects/example-*. Running it again
          restores removed ones and leaves existing ones alone.
  examples remove
          Hide the example projects again. Nothing is deleted: each one's project.yaml is renamed to a .bak.
  github refresh
          Fetch what GitHub says about the published PRs (those with a github: url in their prs file) of
          <project>, or of every project that hasn't opted out (github: {sync: off}): approvals, checks, review
          threads (resolved, answered or open) and comments. Asks now, whatever their age: one query per GitHub
          repo, through the gh CLI. Writes only its cache, <data>/github/; a running server picks it up.
  github status
          The GitHub sync's settings (<data>/config.yaml) and, from the cache, each repo's last fetch; with
          <project>, each of its PRs: approvals, checks and threads. No network.
  service install
          Run Local Review in the background, started at login and restarted if it exits: a LaunchAgent on
          macOS, a systemd user unit on Linux. The service runs this installed local-review with this shell's
          Node, and a PATH that must find git, still on 127.0.0.1 only. Running it again rewrites it, keeping
          the port, LOCAL_REVIEW_HOME and LOCAL_REVIEW_USER it was installed with unless you give new ones.
          Refuses to run from npx's cache (\`npm i -g local-review\` first) or a source checkout.
          --port <n>       the port (default ${DEFAULT_PORT}; $PORT isn't used here)
          --dry-run        print the service file it would write; write nothing, start nothing
          --from-checkout  run a source checkout's build (dist/) as the service, on purpose
          --refresh        rewrite the installed service for this version, from what it was installed with (its
                           port, data home and environment, not this shell's), and restart it. Exits 4 if
                           nothing is installed. \`update\` runs it.
          --json           one JSON document on stdout, { ok, action, error?, … } with \`service status --json\`'s
                           fields; the messages go to stderr
  service uninstall
          Stop the service and remove its file. Your data (and its logs/) stays where it is.
          --json           as \`service install\`
  service start
          Start the installed service, and wait until it answers.
          --json           as \`service install\`
  service stop
          Stop it until \`service start\` or your next login. It stays installed: \`service uninstall\` removes it.
          Refuses (exit 75) while it's busy saving, snapshotting or syncing with GitHub (see \`busy\`).
          --force          stop it anyway
          --json           as \`service install\`
  service restart
          Restart it, e.g. after \`npm i -g local-review@latest\`. A service file an older version wrote, or one
          whose Node or local-review has gone, is rewritten first, keeping its port and environment. Refuses
          (exit 75) while it's busy, as \`stop\` does.
          --force          restart it anyway
          --json           as \`service install\`
  service status
          Whether it's installed, loaded, running and answering, on which port, which version, and what it runs.
          Exits 0 if it's running and answering, 3 if it's installed but not, 4 if it isn't installed.
          --json           as JSON
  service logs
          The end of the service's log, <data>/logs/service.log.
          -f, --follow     then keep printing what it writes, until interrupted
          -n, --lines <n>  how many lines (default 50)
  busy    Ask the running Local Review whether it's busy: saving a comment or a description, taking a backup
          snapshot, or syncing with GitHub. Exits 0 if it isn't, 75 if it is, 3 if nothing is running. It finds
          the instance through <data>/runtime.json, which \`serve\` writes.
          --json           as JSON: { running, busy, url, version, counts }
  update  Update this local-review to the latest version on npm, and restart the service onto it. It asks first
          (\`--yes\` answers; without a terminal, --yes is needed), refuses while Local Review is busy, and if the
          new version doesn't come up it puts the old one back. A copy it can't update itself (npx, a source
          checkout, a project's dependency) prints the command to run instead, and exits 5.
          --check          only say whether there's a newer version; change nothing
          --to <v>         a version or a dist-tag (next); the only way to go to a lower version
          --yes            don't ask
          --force          update even while it's busy (the health check and the rollback still run)
          --json           one JSON document on stdout
  doctor  Check this install: Node against what Local Review needs, how it was installed, the service (whether
          what it runs is still there), that the running version is the installed one, the port, linger (Linux),
          the data home, git and gh, and whether there's a newer version. A fix is printed under each problem.
          Exits 1 if a check failed (warnings don't count).
          --offline        don't ask the npm registry for a newer version
          --json           as JSON: { ok, version, checks: [{ id, status, message, fix }] }
  guide   Print the guide for agents using Local Review to get their work reviewed (AGENT-GUIDE.md).

  --data-dir <path>
          The data home for this command, as LOCAL_REVIEW_HOME sets it (default ~/.local-review).

Data: $LOCAL_REVIEW_HOME/projects (default ~/.local-review/projects). Agents: run \`local-review guide\`.
Exit codes: 0 done, 1 failed, 2 bad usage, 3 not running, 4 not installed (\`service\`), 5 can't update itself,
6 the update failed and the old version is running again, 7 the update failed and couldn't be undone, 75 busy
(\`busy\`, \`update\`, \`service stop\` and \`restart\`: try again later, or use --force).`;

/** Bad usage: exit 2, with the usage. Anything else thrown exits 1. */
class UsageError extends Error {}

const VALUE_FLAGS = ['repo', 'stack', 'format', 'port', 'alt', 'to-repo', 'lines', 'data-dir', 'to'];

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = '1';
    else if (a === '-v' || a === '--version') flags.version = '1';
    else if (a === '--include-follow-on') flags['include-follow-on'] = '1';
    else if (a === '--dry-run') flags['dry-run'] = '1';
    else if (a === '--from-checkout') flags['from-checkout'] = '1';
    else if (a === '--json') flags.json = '1';
    else if (a === '--force') flags.force = '1';
    else if (a === '--check') flags.check = '1';
    else if (a === '--yes') flags.yes = '1';
    else if (a === '--refresh') flags.refresh = '1';
    else if (a === '--offline') flags.offline = '1';
    else if (a === '-q' || a === '--quiet') flags.quiet = '1';
    else if (a === '-f' || a === '--follow') flags.follow = '1';
    else if (a === '-n') {
      if (argv[i + 1] === undefined) throw new UsageError('-n needs a value');
      flags.lines = argv[++i];
    }
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const [k, v] = eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), argv[++i]];
      if (!VALUE_FLAGS.includes(k)) throw new UsageError(`unknown option --${k}`);
      if (v === undefined) throw new UsageError(`--${k} needs a value`);
      flags[k] = v;
    } else if (a.startsWith('-') && a.length > 1) throw new UsageError(`unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, flags };
}

/** Each command takes its own options and at most `max` arguments. */
function check(cmd: string, flags: Record<string, string>, allowed: string[], args: string[], max: number) {
  const bad = Object.keys(flags).find((k) => !allowed.includes(k));
  if (bad) throw new UsageError(`${cmd} doesn't take --${bad}`);
  if (args.length > max) throw new UsageError(`unexpected argument '${args[max]}'`);
}

async function plan(slug: string | undefined, flags: Record<string, string>) {
  if (!slug) throw new UsageError('plan needs a project');
  if (!SAFE_NAME.test(slug)) throw new UsageError(`bad project name '${slug}'`);
  const format = flags.format ?? 'md';
  if (!['md', 'json', 'yaml'].includes(format)) throw new UsageError(`--format must be md, json or yaml`);
  let stack: number | undefined;
  if (flags.stack !== undefined) {
    if (!/^[1-9][0-9]{0,3}$/.test(flags.stack)) throw new UsageError(`--stack must be a stack number (1, 2, …)`);
    stack = Number(flags.stack);
  }
  const project = await loadProject(slug);
  if (!project) throw new Error(`no project '${slug}' (looked for ${path.join(PROJECTS_DIR, slug, 'project.yaml')}; \`local-review init ${slug}\` creates one)`);
  const p = await buildPlan(project, { repo: flags.repo, stack, includeFollowOn: !!flags['include-follow-on'] });
  process.stdout.write(format === 'json' ? JSON.stringify(p, null, 2) + '\n' : format === 'yaml' ? planYaml(p) : planMarkdown(p));
}

function init(slug: string | undefined) {
  if (!slug) throw new UsageError('init needs a project name, e.g. `local-review init my-feature`');
  if (!SAFE_NAME.test(slug)) throw new UsageError(`bad project name '${slug}': use letters, digits, '.', '_' and '-', not starting with '.'`);
  const file = path.join(PROJECTS_DIR, slug, 'project.yaml');
  const text = fs.readFileSync(EXAMPLE_PROJECT, 'utf8').replace(/^title: .*$/m, `title: ${slug}`);
  try {
    atomicWrite(file, text, { createOnly: true });
  } catch (e) {
    if (e instanceof ExistsError) throw new Error(`${file} already exists; not replacing it`);
    throw e;
  }
  const port = (process.env.PORT && parsePort(process.env.PORT)) || DEFAULT_PORT;
  process.stdout.write(
    `Created ${file}\n\n` +
      `Next: edit it (each repo's path and branch), then run \`local-review\` and open http://localhost:${port}/${slug}\n` +
      `Edits to project.yaml are picked up live.\n`,
  );
}

function projectDirFor(cmd: string, slug: string | undefined) {
  if (!slug) throw new UsageError(`${cmd} needs a project`);
  if (!SAFE_NAME.test(slug)) throw new UsageError(`bad project name '${slug}'`);
  const dir = path.join(PROJECTS_DIR, slug);
  if (!fs.existsSync(path.join(dir, 'project.yaml'))) throw new Error(`no project '${slug}' (looked for ${path.join(dir, 'project.yaml')}; \`local-review init ${slug}\` creates one)`);
  return dir;
}

function asset(args: string[], flags: Record<string, string>) {
  const [sub, slug, a, b] = args;
  if (sub === 'add') {
    if (args.length > 3) throw new UsageError(`unexpected argument '${args[3]}'`);
    const dir = projectDirFor('asset add', slug);
    if (!a) throw new UsageError('asset add needs an image file');
    let st: fs.Stats;
    try {
      st = fs.statSync(a);
    } catch {
      throw new Error(`can't read ${a}`);
    }
    if (!st.isFile()) throw new Error(`${a} isn't a file`);
    if (st.size > MAX_ASSET_BYTES) throw new Error(`${a} is ${(st.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
    const alt = flags.alt ?? path.basename(a).replace(/\.[^.]*$/, '');
    try {
      const r = addAsset(dir, fs.readFileSync(a), typeOfName(a), alt);
      process.stderr.write(`${r.created ? 'Added' : 'Already there:'} ${r.file}\n`);
      process.stdout.write(r.markdown + '\n');
    } catch (e) {
      if (e instanceof AssetError) throw new Error(`${a}: ${e.message}`);
      throw e;
    }
    return;
  }
  if (sub === 'url') {
    if (flags.alt !== undefined) throw new UsageError("asset url doesn't take --alt");
    if (args.length > 4) throw new UsageError(`unexpected argument '${args[4]}'`);
    const dir = projectDirFor('asset url', slug);
    if (!a || !b) throw new UsageError('asset url needs an asset name and a URL, e.g. `local-review asset url my-feature 3f2a9c1e0b7d4a65.png https://…`');
    const name = a.replace(/^(?:\.\/)?assets\//, ''); // accept the reference as written in markdown
    try {
      process.stderr.write(`Recorded in ${setPublishedUrl(dir, name, b)}\n`);
    } catch (e) {
      if (e instanceof AssetError) throw e.status === 400 ? new UsageError(e.message) : new Error(e.message);
      throw e;
    }
    return;
  }
  throw new UsageError(sub ? `unknown asset command '${sub}' (add or url)` : 'asset needs a command: add or url');
}

async function move(args: string[], flags: Record<string, string>) {
  const [from, to, repo, ...shas] = args;
  if (!from || !to || !repo) throw new UsageError('move needs <from> <to> <repo>, then commit shas or --stack <n>');
  for (const s of [from, to]) if (!SAFE_NAME.test(s)) throw new UsageError(`bad project name '${s}'`);
  let stack: number | undefined;
  if (flags.stack !== undefined) {
    if (!/^[1-9][0-9]{0,3}$/.test(flags.stack)) throw new UsageError(`--stack must be a stack number (1, 2, …)`);
    if (shas.length) throw new UsageError('give commit shas or --stack, not both');
    stack = Number(flags.stack);
  } else if (!shas.length) throw new UsageError('move needs commit shas or --stack <n>');
  const { MoveError, movePrs, moveReport } = await import('./move.js');
  const o = { from, to, repo, toRepo: flags['to-repo'], shas, stack, dryRun: !!flags['dry-run'] };
  try {
    process.stdout.write(moveReport(await movePrs(o), o) + '\n');
  } catch (e) {
    if (e instanceof MoveError) throw new Error(e.message);
    throw e;
  }
}

async function examples(sub: string | undefined) {
  const { addExamples, removeExamples } = await import('./examples.js');
  if (sub === undefined || sub === 'add') {
    const r = await addExamples();
    const all = [...r.created, ...r.restored, ...r.existing];
    process.stdout.write(
      `${r.created.length ? `Created ${r.created.join(', ')}\n` : ''}${r.restored.length ? `Restored ${r.restored.join(', ')}\n` : ''}${r.existing.length ? `Already there: ${r.existing.join(', ')}\n` : ''}` +
        `\nThe example projects are in ${PROJECTS_DIR} (${all.length}). \`local-review examples remove\` hides them again.\n`,
    );
    return;
  }
  if (sub === 'remove') {
    const r = await removeExamples();
    process.stdout.write(r.removed.length ? `Removed ${r.removed.join(', ')} (renamed to project.example-removed.yaml.bak; nothing deleted)\n` : 'No example projects to remove.\n');
    return;
  }
  throw new UsageError(`unknown examples command '${sub}' (add or remove)`);
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}

async function github(args: string[]): Promise<number> {
  const [sub, slug] = args;
  if (sub !== 'refresh' && sub !== 'status') throw new UsageError(sub ? `unknown github command '${sub}' (refresh or status)` : 'github needs a command: refresh or status');
  if (slug !== undefined) projectDirFor(`github ${sub}`, slug);
  const G = await import('./github.js');
  const { loadSettings } = await import('./settings.js');
  const { GITHUB_DIR } = await import('./config.js');
  const { summaryTooltip } = await import('../shared/github.js');
  const settings = loadSettings();
  for (const w of settings.warnings) process.stderr.write(`warning: ${w}\n`);
  if (!GITHUB_DIR) throw new Error('no data home for the GitHub cache (set LOCAL_REVIEW_HOME)');
  if (sub === 'refresh') {
    if (slug && G.projectGithub(slug)?.optedOut) throw new Error(`${slug} has opted out of the GitHub sync (github: {sync: off} in its project.yaml)`);
    const results = await G.refresh({ project: slug, all: !slug, force: true });
    if (!results.length) process.stdout.write(`No published PRs to fetch${slug ? ` in ${slug}` : ''} (a PR is published once its prs file records github: {url}).\n`);
    for (const r of results)
      process.stdout.write(`${r.host === 'github.com' ? '' : `${r.host}/`}${r.key}: ${r.error ? `error: ${r.error}` : `${r.fetched} PR${r.fetched === 1 ? '' : 's'} fetched`}${r.missing?.length ? ` (not found: ${r.missing.map((n) => `#${n}`).join(', ')})` : ''}\n`);
    return results.some((r) => r.error) ? 1 : 0;
  }
  const g = settings.github;
  process.stdout.write(`GitHub sync: ${g.sync ? 'on' : 'off'} (source ${g.source}, max_age ${Math.round(g.maxAgeMs / 1000)}s${g.me ? `, me ${g.me}` : ''}) · ${settings.file}${fs.existsSync(settings.file) ? '' : ' (not there: the defaults)'}\n`);
  process.stdout.write(`Cache: ${GITHUB_DIR}\n`);
  for (const s of slug ? [slug] : (await import('./projects.js')).listProjectSlugs()) {
    const p = G.projectGithub(s);
    if (!p || (!slug && !p.repos.length)) continue;
    process.stdout.write(`\n${s}${p.optedOut ? ' (opted out)' : p.enabled ? '' : ' (not synced automatically: the sync is off)'}\n`);
    for (const r of p.repos) process.stdout.write(`  ${r.key}: ${r.prs} PR${r.prs === 1 ? '' : 's'}, fetched ${ago(r.fetched_at)}${r.error ? ` · last attempt failed: ${r.error}` : ''}\n`);
    if (slug) for (const sum of Object.values(p.prs).sort((a, b) => a.number - b.number)) process.stdout.write(`\n${summaryTooltip(sum).replace(/^/gm, '  ')}\n  ${sum.url}\n`);
  }
  return 0;
}

async function serve(flags: Record<string, string>) {
  const given = flags.port ?? process.env.PORT;
  // `npm run dev`: the API sits next to Vite's UI port (see vite.config.ts)
  const port = given === undefined || given === '' ? DEFAULT_PORT + (process.env.LOCAL_REVIEW_DEV ? 1 : 0) : parsePort(given);
  if (port === null) throw new UsageError(`${flags.port !== undefined ? '--port' : 'PORT'} must be a port number (0-65535), not '${given}'`);
  const { startServer } = await import('./index.js');
  try {
    const bound = await startServer(port);
    const dev = !!process.env.LOCAL_REVIEW_DEV;
    // `npm run dev` is a development server: it leaves runtime.json to the real instance
    if (!dev) await announceRuntime(bound);
    // the service's log, <data>/logs/service.log, which launchd or systemd appends to: rotated by copy and truncate
    // past 8 MB, keeping 3 (cli-contract SPEC §7). A foreground run has no such file, so this does nothing
    if (!dev) await rotateServiceLog();
    const { startupMessage } = await import('./banner.js');
    const s = startupMessage(
      { url: `http://localhost:${bound}`, version: version(), projectsDir: PROJECTS_DIR, quiet: !!flags.quiet, dev },
      { isTTY: process.stdout.isTTY, columns: process.stdout.columns, env: process.env },
      { isTTY: process.stderr.isTTY, columns: process.stderr.columns, env: process.env },
    );
    if (s.err) process.stderr.write(s.err);
    process.stdout.write(s.out);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') throw new Error(`port ${port} is already in use; pick another with --port <n>`);
    if (code === 'EACCES') throw new Error(`not allowed to listen on port ${port}; pick another with --port <n>`);
    throw e;
  }
}

const version = (): string => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/**
 * Write <data>/runtime.json, so `local-review busy` can find this instance (cli-contract SPEC §4), and remove it when
 * the process exits. On SIGTERM (a service stop) or SIGINT, let the saves and syncs under way finish first, for up
 * to 5 seconds; a second signal exits at once.
 */
async function announceRuntime(port: number) {
  const { writeRuntimeFile, removeRuntimeFile } = await import('./contract/runtime-file.js');
  const { whenIdle } = await import('./busy.js');
  try {
    writeRuntimeFile(HOME, { pid: process.pid, port, url: `http://127.0.0.1:${port}`, version: version() });
  } catch (e) {
    process.stderr.write(`local-review: couldn't write ${path.join(HOME, 'runtime.json')} (\`local-review busy\` won't find this instance): ${(e as Error).message}\n`);
    return;
  }
  process.on('exit', () => {
    try {
      removeRuntimeFile(HOME);
    } catch {
      /* leave it: its pid is dead, so busy ignores it */
    }
  });
  let stopping = false;
  const onSignal = (code: number) => async () => {
    if (stopping) process.exit(code);
    stopping = true;
    if (!(await whenIdle(5000))) process.stderr.write('local-review: stopping with work still under way\n');
    process.exit(code);
  };
  process.on('SIGTERM', onSignal(0));
  process.on('SIGINT', onSignal(130));
}

async function rotateServiceLog() {
  const { startLogRotation } = await import('./contract/rotate.js');
  const { LOG_FILE } = await import('./service/spec.js');
  startLogRotation(path.join(HOME, 'logs', LOG_FILE), { warn: (m) => process.stderr.write(`local-review: ${m}\n`) });
}

async function busy(flags: Record<string, string>): Promise<number> {
  const { runBusyCommand } = await import('./contract/busy-client.js');
  const { createOutput } = await import('./contract/output.js');
  const { BUSY_NOUNS } = await import('./busy.js');
  return runBusyCommand({ home: HOME, name: 'Local Review', out: createOutput({ tool: 'local-review', json: !!flags.json }), nouns: BUSY_NOUNS });
}

async function update(flags: Record<string, string>): Promise<number> {
  if (flags.to === '') throw new UsageError('--to needs a version or a dist-tag');
  const { updateCommand } = await import('./update.js');
  return updateCommand(
    { root: ROOT, home: HOME, version: version() },
    { check: !!flags.check, yes: !!flags.yes, force: !!flags.force, json: !!flags.json, ...(flags.to !== undefined ? { to: flags.to } : {}) },
  );
}

async function doctor(flags: Record<string, string>): Promise<number> {
  const { diagnose, doctorCode, renderChecks } = await import('./doctor.js');
  const { realContext } = await import('./service/index.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { checks, notice } = await diagnose({
    ctx: realContext(ROOT, { dataHome: HOME, version: pkg.version }),
    version: pkg.version,
    engines: pkg.engines?.node,
    home: HOME,
    entry: process.argv[1] ?? '',
    offline: !!flags.offline,
  });
  const code = doctorCode(checks);
  if (flags.json) process.stdout.write(JSON.stringify({ ok: code === 0, version: pkg.version, checks }, null, 2) + '\n');
  else process.stdout.write(renderChecks(checks));
  // SPEC §3: the update notice goes to stderr
  if (notice) process.stderr.write(`\n${notice}\n`);
  return code;
}

async function service(args: string[], flags: Record<string, string>): Promise<number> {
  const [sub, ...rest] = args;
  const svc = await import('./service/index.js');
  const ctx = svc.realContext(ROOT, { dataHome: HOME, version: version() });
  // --json: one document on stdout, the prose on stderr (cli-contract SPEC §1); `logs` doesn't take it
  const json = (action: import('./service/index.js').ServiceAction, run: (c: typeof ctx) => Promise<number>) => (flags.json ? svc.withJson(ctx, action, run) : run(ctx));
  try {
    switch (sub) {
      case 'install': {
        check('service install', flags, ['port', 'dry-run', 'from-checkout', 'refresh', 'json'], rest, 0);
        const port = flags.port === undefined ? undefined : parsePort(flags.port);
        if (port === null || port === 0) throw new UsageError(`--port must be a port number (1-65535), not '${flags.port}'`);
        return await json('install', (c) => svc.install(c, { port, dryRun: !!flags['dry-run'], fromCheckout: !!flags['from-checkout'], refresh: !!flags.refresh }));
      }
      case 'uninstall':
        check('service uninstall', flags, ['json'], rest, 0);
        return await json('uninstall', (c) => svc.uninstall(c));
      case 'start':
        check('service start', flags, ['json'], rest, 0);
        return await json('start', (c) => svc.start(c));
      case 'stop':
        check('service stop', flags, ['force', 'json'], rest, 0);
        return await json('stop', (c) => svc.stop(c, { force: !!flags.force }));
      case 'status':
        check('service status', flags, ['json'], rest, 0);
        return await svc.status(ctx, { json: !!flags.json });
      case 'restart':
        check('service restart', flags, ['force', 'json'], rest, 0);
        return await json('restart', (c) => svc.restart(c, { force: !!flags.force }));
      case 'logs': {
        check('service logs', flags, ['follow', 'lines'], rest, 0);
        if (flags.lines !== undefined && !/^[0-9]{1,7}$/.test(flags.lines)) throw new UsageError(`-n must be a number of lines, not '${flags.lines}'`);
        return await svc.logs(ctx, { follow: !!flags.follow, lines: flags.lines === undefined ? undefined : Number(flags.lines) });
      }
      default:
        throw new UsageError(sub ? `unknown service command '${sub}'; ${svc.SERVICE_USAGE}` : svc.SERVICE_USAGE);
    }
  } catch (e) {
    // a refusal or a service manager's failure is a plain error (exit 1), not a usage error
    if (e instanceof svc.RefusalError || e instanceof svc.ServiceManagerError) throw new Error(e.message);
    throw e;
  }
}

/** Resolves with the exit code, or undefined while the server runs. */
async function main(argv: string[]): Promise<number | undefined> {
  const { pos, flags } = parseArgs(argv);
  // every command takes it, and datadir.ts has already acted on it
  if (flags['data-dir'] !== undefined) {
    if (!flags['data-dir']) throw new UsageError('--data-dir needs a path');
    delete flags['data-dir'];
  }
  if (flags.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (flags.version) {
    process.stdout.write(version() + '\n');
    return 0;
  }
  const [cmd = 'serve', ...args] = pos;
  switch (cmd) {
    case 'serve':
      check(cmd, flags, ['port', 'quiet'], args, 0);
      await serve(flags);
      return undefined;
    case 'plan':
      check(cmd, flags, ['repo', 'stack', 'format', 'include-follow-on'], args, 1);
      await plan(args[0], flags);
      return 0;
    case 'init':
      check(cmd, flags, [], args, 1);
      init(args[0]);
      return 0;
    case 'asset':
      check(cmd, flags, ['alt'], args, 4);
      asset(args, flags);
      return 0;
    case 'move':
      check(cmd, flags, ['stack', 'to-repo', 'dry-run'], args, 1000);
      await move(args, flags);
      return 0;
    case 'examples':
      check(cmd, flags, [], args, 1);
      await examples(args[0]);
      return 0;
    case 'github':
      check(cmd, flags, [], args, 2);
      return github(args);
    case 'service':
      return service(args, flags);
    case 'busy':
      check(cmd, flags, ['json'], args, 0);
      return busy(flags);
    case 'update':
    case 'upgrade': // a hidden alias (cli-contract SPEC §1)
      check(cmd, flags, ['check', 'to', 'yes', 'force', 'json'], args, 0);
      return update(flags);
    case 'doctor':
      check(cmd, flags, ['json', 'offline'], args, 0);
      return doctor(flags);
    case 'guide':
      check(cmd, flags, [], args, 0);
      process.stdout.write(fs.readFileSync(AGENT_GUIDE, 'utf8'));
      return 0;
    default:
      throw new UsageError(`unknown command '${cmd}'`);
  }
}

// exitCode, not exit(): exiting could cut off output still being written to a pipe
main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`local-review: ${(e as Error).message}\n`);
    if (e instanceof UsageError) process.stderr.write(`\n${USAGE}\n`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  },
);
