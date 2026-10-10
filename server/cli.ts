// `npm run --silent lr -- <command> …`: command-line access to Local Review's data, for agents.
// Read-only: it never writes a file and never runs gh (or anything but read-only git, via server/git.ts).
import { SAFE_NAME } from './config.js';
import { loadProject } from './projects.js';
import { PlanError, buildPlan, planMarkdown, planYaml } from './plan.js';

const USAGE = `Usage: npm run --silent lr -- plan <project> [--repo <name>] [--stack <n>] [--include-follow-on]
                              [--format md|json|yaml]

  plan    For each PR in scope, in order: commit, status (draft / ready / published), branch (with its
          status), base, title and the exact full body (project intro, stack note, ---, PR description), plus
          any recorded github: info. Warns about stacks with draft PRs. Read-only.
          --repo <name>    one repo of the project
          --stack <n>      one declared stack (1-based, as in project.yaml); needs --repo if several repos have it.
                           Naming a follow-on stack plans it (with a note).
          --include-follow-on
                           also plan follow-on stacks (follow_on: true, parked work); left out by default
          --format <f>     md (default), json or yaml

Data: $LOCAL_REVIEW_HOME/projects (default ~/.local-review/projects). See AGENTS.md.`;

class UsageError extends Error {}

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = '1';
    else if (a === '--include-follow-on') flags['include-follow-on'] = '1';
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const [k, v] = eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), argv[++i]];
      if (!['repo', 'stack', 'format'].includes(k)) throw new UsageError(`unknown option --${k}`);
      if (v === undefined) throw new UsageError(`--${k} needs a value`);
      flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function main(argv: string[]): Promise<number> {
  const { pos, flags } = parseArgs(argv);
  if (flags.help || !pos.length) {
    process.stdout.write(USAGE + '\n');
    return flags.help ? 0 : 2;
  }
  const [cmd, slug, ...extra] = pos;
  if (cmd !== 'plan') throw new UsageError(`unknown command '${cmd}'`);
  if (!slug) throw new UsageError('plan needs a project');
  if (extra.length) throw new UsageError(`unexpected argument '${extra[0]}'`);
  if (!SAFE_NAME.test(slug)) throw new UsageError(`bad project name '${slug}'`);
  const format = flags.format ?? 'md';
  if (!['md', 'json', 'yaml'].includes(format)) throw new UsageError(`--format must be md, json or yaml`);
  let stack: number | undefined;
  if (flags.stack !== undefined) {
    if (!/^[1-9][0-9]{0,3}$/.test(flags.stack)) throw new UsageError(`--stack must be a stack number (1, 2, …)`);
    stack = Number(flags.stack);
  }
  const project = await loadProject(slug);
  if (!project) throw new PlanError(`no project '${slug}' (looked for ${slug}/project.yaml in the projects directory; see AGENTS.md)`);
  const plan = await buildPlan(project, { repo: flags.repo, stack, includeFollowOn: !!flags['include-follow-on'] });
  const out = format === 'json' ? JSON.stringify(plan, null, 2) + '\n' : format === 'yaml' ? planYaml(plan) : planMarkdown(plan);
  process.stdout.write(out);
  return 0;
}

// exitCode, not exit(): exiting could cut off output still being written to a pipe
main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    process.stderr.write(`lr: ${(e as Error).message}\n`);
    if (e instanceof UsageError) process.stderr.write(`\n${USAGE}\n`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  },
);
