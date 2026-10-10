#!/usr/bin/env node
// `local-review [command] …`: the command-line entry point (the package's bin; `npm run lr -- …` from a checkout).
// With no command it serves the UI. `plan` and `guide` are read-only: they never write a file and never run gh (or
// anything but read-only git, via server/git.ts). `init` only ever creates a new project.yaml, never replaces one.
// `asset add` only ever creates a new, content-named image file; `asset url` writes only the asset's own <name>.yaml.
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_GUIDE, DEFAULT_PORT, EXAMPLE_PROJECT, PROJECTS_DIR, ROOT, SAFE_NAME, parsePort } from './config.js';
import { loadProject } from './projects.js';
import { buildPlan, planMarkdown, planYaml } from './plan.js';
import { ExistsError, atomicWrite } from './safefs.js';
import { AssetError, addAsset, setPublishedUrl } from './assets.js';
import { MAX_ASSET_BYTES, typeOfName } from '../shared/assets.js';

const USAGE = `Usage: local-review [serve] [--port <n>]
       local-review plan <project> [--repo <name>] [--stack <n>] [--include-follow-on] [--format md|json|yaml]
       local-review init <project>
       local-review asset add <project> <file> [--alt <text>]
       local-review asset url <project> <name> <url>
       local-review guide
       local-review --version | --help

  serve   (the default) Serve the review UI and API on http://localhost:<port> (127.0.0.1 only).
          --port <n>       the port (default ${DEFAULT_PORT}, or $PORT)
  plan    For each PR in scope, in order: commit, status (draft / ready / published), branch (with its
          status), base, title and the exact full body (project intro, stack note, ---, PR description), plus
          any recorded github: info. Warns about stacks with draft PRs, GitHub bases that differ from the
          plan's, and published PRs that landed upstream without being frozen. Landed (merged) PRs are
          never planned. Read-only.
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
  guide   Print the guide for agents using Local Review to get their work reviewed (AGENT-GUIDE.md).

Data: $LOCAL_REVIEW_HOME/projects (default ~/.local-review/projects). Agents: run \`local-review guide\`.`;

/** Bad usage: exit 2, with the usage. Anything else thrown exits 1. */
class UsageError extends Error {}

const VALUE_FLAGS = ['repo', 'stack', 'format', 'port', 'alt'];

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = '1';
    else if (a === '-v' || a === '--version') flags.version = '1';
    else if (a === '--include-follow-on') flags['include-follow-on'] = '1';
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

async function serve(flags: Record<string, string>) {
  const given = flags.port ?? process.env.PORT;
  // `npm run dev`: the API sits next to Vite's UI port (see vite.config.ts)
  const port = given === undefined || given === '' ? DEFAULT_PORT + (process.env.LOCAL_REVIEW_DEV ? 1 : 0) : parsePort(given);
  if (port === null) throw new UsageError(`${flags.port !== undefined ? '--port' : 'PORT'} must be a port number (0-65535), not '${given}'`);
  const { startServer } = await import('./index.js');
  try {
    await startServer(port);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') throw new Error(`port ${port} is already in use; pick another with --port <n>`);
    if (code === 'EACCES') throw new Error(`not allowed to listen on port ${port}; pick another with --port <n>`);
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
      check(cmd, flags, ['port'], args, 0);
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
