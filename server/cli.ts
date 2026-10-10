#!/usr/bin/env node
// `local-review [command] …`: the command-line entry point (the package's bin; `npm run lr -- …` from a checkout).
// With no command it serves the UI. `plan` and `guide` are read-only: they never write a file and never run gh (or
// anything but read-only git, via server/git.ts). `init` only ever creates a new project.yaml, never replaces one.
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_GUIDE, DEFAULT_PORT, EXAMPLE_PROJECT, PROJECTS_DIR, ROOT, SAFE_NAME, parsePort } from './config.js';
import { loadProject } from './projects.js';
import { buildPlan, planMarkdown, planYaml } from './plan.js';
import { ExistsError, atomicWrite } from './safefs.js';

const USAGE = `Usage: local-review [serve] [--port <n>]
       local-review plan <project> [--repo <name>] [--stack <n>] [--include-follow-on] [--format md|json|yaml]
       local-review init <project>
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
  guide   Print the guide for agents using Local Review to get their work reviewed (AGENT-GUIDE.md).

Data: $LOCAL_REVIEW_HOME/projects (default ~/.local-review/projects). Agents: run \`local-review guide\`.`;

/** Bad usage: exit 2, with the usage. Anything else thrown exits 1. */
class UsageError extends Error {}

const VALUE_FLAGS = ['repo', 'stack', 'format', 'port'];

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
