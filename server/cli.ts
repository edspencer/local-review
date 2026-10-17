#!/usr/bin/env node
// `local-review [command] …`: the command-line entry point (the package's bin; `npm run lr -- …` from a checkout).
// With no command it serves the UI. `plan` and `guide` are read-only: they never write a file and never run gh (or
// anything but read-only git, via server/git.ts). `init` only ever creates a new project.yaml, never replaces one.
// `examples` only ever creates (the example projects and their repos); `examples remove` renames, never deletes.
// `asset add` only ever creates a new, content-named image file; `asset url` writes only the asset's own <name>.yaml.
// `move` copies prs / reviews files into another project (create-only) and renames the originals to .bak.
// `service` writes only its own LaunchAgent / systemd user unit (and makes the data home's logs/), never user data.
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_GUIDE, DEFAULT_PORT, EXAMPLE_PROJECT, PROJECTS_DIR, ROOT, SAFE_NAME, parsePort } from './config.js';
import { loadProject } from './projects.js';
import { buildPlan, planMarkdown, planYaml } from './plan.js';
import { ExistsError, atomicWrite } from './safefs.js';
import { AssetError, addAsset, setPublishedUrl } from './assets.js';
import { MAX_ASSET_BYTES, typeOfName } from '../shared/assets.js';

const USAGE = `Usage: local-review [serve] [--port <n>] [--quiet]
       local-review plan <project> [--repo <name>] [--stack <n>] [--include-follow-on] [--format md|json|yaml]
       local-review init <project>
       local-review asset add <project> <file> [--alt <text>]
       local-review asset url <project> <name> <url>
       local-review move <from> <to> <repo> (<sha>… | --stack <n>) [--to-repo <name>] [--dry-run]
       local-review examples [remove]
       local-review service install [--port <n>] [--dry-run] [--from-checkout]
       local-review service uninstall | status [--json] | restart
       local-review guide
       local-review --version | --help

  serve   (the default) Serve the review UI and API on http://localhost:<port> (127.0.0.1 only).
          --port <n>       the port (default ${DEFAULT_PORT}, or $PORT)
          --quiet, -q      print just the "Local Review on <url>" line: no banner, no hint for agents
                           (the banner is only shown on a terminal anyway)
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
  service install
          Run Local Review in the background, started at login and restarted if it exits: a LaunchAgent on
          macOS, a systemd user unit on Linux. The service runs this installed local-review with this shell's
          Node, and a PATH that must find git, still on 127.0.0.1 only. Running it again rewrites it, keeping
          the port, LOCAL_REVIEW_HOME and LOCAL_REVIEW_USER it was installed with unless you give new ones.
          Refuses to run from npx's cache (\`npm i -g local-review\` first) or a source checkout.
          --port <n>       the port (default ${DEFAULT_PORT}; $PORT isn't used here)
          --dry-run        print the service file it would write; write nothing, start nothing
          --from-checkout  run a source checkout's build (dist/) as the service, on purpose
  service uninstall
          Stop the service and remove its file. Your data (and its logs/) stays where it is.
  service status
          Whether it's installed, loaded and running, on which port, and what it runs.
          --json           as JSON
  service restart
          Restart it, e.g. after \`npm i -g local-review@latest\`.
  guide   Print the guide for agents using Local Review to get their work reviewed (AGENT-GUIDE.md).

Data: $LOCAL_REVIEW_HOME/projects (default ~/.local-review/projects). Agents: run \`local-review guide\`.`;

/** Bad usage: exit 2, with the usage. Anything else thrown exits 1. */
class UsageError extends Error {}

const VALUE_FLAGS = ['repo', 'stack', 'format', 'port', 'alt', 'to-repo'];

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
    else if (a === '-q' || a === '--quiet') flags.quiet = '1';
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

async function serve(flags: Record<string, string>) {
  const given = flags.port ?? process.env.PORT;
  // `npm run dev`: the API sits next to Vite's UI port (see vite.config.ts)
  const port = given === undefined || given === '' ? DEFAULT_PORT + (process.env.LOCAL_REVIEW_DEV ? 1 : 0) : parsePort(given);
  if (port === null) throw new UsageError(`${flags.port !== undefined ? '--port' : 'PORT'} must be a port number (0-65535), not '${given}'`);
  const { startServer } = await import('./index.js');
  try {
    const bound = await startServer(port);
    const { startupMessage } = await import('./banner.js');
    process.stdout.write(
      startupMessage(
        { url: `http://localhost:${bound}`, projectsDir: PROJECTS_DIR, quiet: !!flags.quiet, dev: !!process.env.LOCAL_REVIEW_DEV },
        { isTTY: process.stdout.isTTY, columns: process.stdout.columns, env: process.env },
      ),
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') throw new Error(`port ${port} is already in use; pick another with --port <n>`);
    if (code === 'EACCES') throw new Error(`not allowed to listen on port ${port}; pick another with --port <n>`);
    throw e;
  }
}

async function service(args: string[], flags: Record<string, string>): Promise<number> {
  const [sub, ...rest] = args;
  const svc = await import('./service/index.js');
  const ctx = svc.realContext(ROOT);
  try {
    switch (sub) {
      case 'install': {
        check('service install', flags, ['port', 'dry-run', 'from-checkout'], rest, 0);
        const port = flags.port === undefined ? undefined : parsePort(flags.port);
        if (port === null || port === 0) throw new UsageError(`--port must be a port number (1-65535), not '${flags.port}'`);
        return await svc.install(ctx, { port, dryRun: !!flags['dry-run'], fromCheckout: !!flags['from-checkout'] });
      }
      case 'uninstall':
        check('service uninstall', flags, [], rest, 0);
        return await svc.uninstall(ctx);
      case 'status':
        check('service status', flags, ['json'], rest, 0);
        return await svc.status(ctx, { json: !!flags.json });
      case 'restart':
        check('service restart', flags, [], rest, 0);
        return await svc.restart(ctx);
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
  if (flags.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (flags.version) {
    process.stdout.write(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version + '\n');
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
    case 'service':
      return service(args, flags);
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
