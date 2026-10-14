// llms.txt and llms-full.txt (https://llmstxt.org): the entry point for a coding agent that's been asked to set up a
// Local Review project. One generator for both copies, so they can't drift:
// - the running server's (GET /llms.txt, /llms-full.txt: server/index.ts), with live facts (the data directory, the
//   existing projects) and URLs for the port it's on;
// - the docs site's (website/public/llms.txt, llms-full.txt), committed and kept in sync by scripts/sync-llms.ts.
// Both are built from AGENT-GUIDE.md (its "Setting up a project" section, and the whole guide for llms-full.txt) and
// examples/project.example.yaml, the files `local-review guide` and `init` use.
//
// The format: an H1, a blockquote summary, then sections without headings (the spec reserves H2s for link lists),
// then the H2 link lists. Docs site links point at the pages' Markdown copies (`/reference/project-yaml.md`).

export const SITE_URL = 'https://local-review.edspencer.net';

/** What the running server knows that the docs site can't. All of it is what the UI shows already (/api/projects, /api/me). */
export interface LiveFacts {
  version: string;
  home: string;
  projectsDir: string;
  reviewer: string;
  projects: { slug: string; title: string; hidden?: boolean; repos: { name: string; path: string; branch: string | null }[] }[];
}

export interface LlmsInput {
  /** AGENT-GUIDE.md */
  guide: string;
  /** examples/project.example.yaml */
  example: string;
  /** Where Local Review is (or will be) served, e.g. http://localhost:5622: the site's copy uses the default. */
  url: string;
  /** The default URL, as AGENT-GUIDE.md and the example write it: replaced by `url` throughout. */
  defaultUrl: string;
  /** Only the running server's copy has these. */
  live?: LiveFacts;
}

export const SETUP_SECTION = 'Setting up a project';

/** Split markdown into `## ` sections (outside code fences): heading → body. */
function sections(md: string): Map<string, string> {
  const out = new Map<string, string[]>();
  let current: string[] = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^## (.+)$/.exec(line);
    if (m) out.set(m[1].trim(), (current = []));
    else current.push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join('\n').trim()]));
}

/** One `## ` section of the guide, without its heading. Throws if it's missing or has headings of its own. */
export function guideSection(guide: string, heading: string): string {
  const body = sections(guide).get(heading);
  if (body === undefined) throw new Error(`AGENT-GUIDE.md: no "## ${heading}" section (shared/llms.ts)`);
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    // llms.txt keeps headings for its title and link lists, so the section goes in as plain paragraphs and lists
    if (!fence && /^#{1,6} /.test(line)) throw new Error(`AGENT-GUIDE.md: "## ${heading}" can't have subheadings (llms.txt embeds it)`);
  }
  return body;
}

/** The default URL becomes this server's, and docs site page links their Markdown copies. */
function localize(md: string, i: LlmsInput): string {
  return md
    .replaceAll(i.defaultUrl, i.url)
    .replace(new RegExp(`\\]\\(${SITE_URL.replace(/[.]/g, '\\.')}((?:/[a-z0-9-]+)+)/(#[^)]*)?\\)`, 'g'), (_, p) => `](${SITE_URL}${p}.md)`);
}

const site = (page: string) => `${SITE_URL}/${page}.md`;
const code = (s: string) => '`' + s + '`';

function liveFacts(i: LlmsInput, f: LiveFacts): string {
  const projects = f.projects.length
    ? f.projects
        .map((p) => {
          const repos = p.repos.map((r) => `${code(r.name)} (${code(r.path)}${r.branch ? `, ${code(r.branch)}` : ''})`).join(', ');
          // a hidden project's slug is taken all the same, and its URL opens it
          return `  - ${code(p.slug)}: ${p.title}${p.hidden ? ' (hidden: `hidden: true`, so not on the root page)' : ''}, ${i.url}/${p.slug}${repos ? `; repos ${repos}` : ''}`;
        })
        .join('\n')
    : '  - none yet';
  return [
    `**This Local Review, right now** (the same facts its UI shows):`,
    '',
    `- Served at ${i.url}, version ${f.version}. It only listens on 127.0.0.1: fetch its URLs with \`curl\` (a web-fetch tool may refuse localhost, or rewrite http to https).`,
    `- Data directory: ${code(f.home)}`,
    `- Projects directory: ${code(f.projectsDir)}. A new project is ${code(`${f.projectsDir}/<slug>/project.yaml`)}.`,
    `- The reviewer's id: ${code(f.reviewer)} (the ${code('author')} of their comments)`,
    `- Existing projects (pick a slug that isn't taken; one for the same repo and branch may already exist):`,
    projects,
  ].join('\n');
}

function siteNote(i: LlmsInput): string {
  return [
    `**This is the docs site's copy.** If Local Review is running, read ${i.url}/llms.txt instead (or the port the user gave):`,
    `the same file for the version they run, plus the actual data directory, the existing projects and URLs for that port.`,
    `${code('npx local-review')} starts it; ${code('npx local-review guide')} prints the full agent guide without it.`,
    `By default the data directory is ${code('~/.local-review')} (or ${code('$LOCAL_REVIEW_HOME')}), and projects are ${code('~/.local-review/projects/<slug>/project.yaml')}.`,
  ].join('\n');
}

/** /llms.txt: everything an agent needs to create a project, in one fetch, then links to the rest. */
export function llmsTxt(i: LlmsInput): string {
  const guideUrl = i.live ? `${i.url}/agent-guide.md` : site('agents/agent-guide');
  return [
    '# Local Review',
    '',
    `> Local Review (npm: \`local-review\`) is a local, GitHub-PR-style review UI for a stack of git commits, run with \`npx local-review\` and served at ${i.url}. Each commit is a candidate PR, reviewed before anything is pushed. Projects, PR text and review comments are plain YAML files that a coding agent reads and writes. This file tells an agent how to create a Local Review project (a project definition, \`project.yaml\`) for the user.`,
    '',
    i.live ? liveFacts(i, i.live) : siteNote(i),
    '',
    '**The rules:**',
    '',
    '- **Reviewed repos are read-only.** Local Review never commits to, checks out, rebases, fetches or pushes the repos it shows; setting up a project needs only read-only git (`log`, `merge-base`, `rev-parse`).',
    "- **Comments are never imported from GitHub.** Local Review's review threads are between the reviewer and the agent, locally. Don't copy GitHub review comments, threads or PR descriptions into it, and don't send its threads to GitHub.",
    '- **Never delete or replace user data.** Create new files under the projects directory; never overwrite an existing `project.yaml` or remove anything there. `local-review init` only ever creates.',
    "- **Don't push, open PRs or touch GitHub** while setting up. That comes later, and only when the reviewer says so (the agent guide).",
    '',
    `**How to set up a project** (the "${SETUP_SECTION}" section of the agent guide):`,
    '',
    localize(guideSection(i.guide, SETUP_SECTION), i),
    '',
    `**The commented example project** (what ${code('npx local-review init <slug>')} writes${i.live ? `, in ${i.live.version}` : ''}):`,
    '',
    '```yaml',
    localize(i.example.trimEnd(), i),
    '```',
    '',
    '## Docs',
    '',
    `- [Agent guide](${guideUrl}): the whole guide for agents (the data model, the HTTP API, review threads, fixups, branches, publishing as GitHub stacked PRs, merges). Also \`npx local-review guide\`.`,
    `- [project.yaml](${site('reference/project-yaml')}): the full schema, stack selectors, errors and warnings`,
    `- [Data directory](${site('reference/data-directory')}): where data lives, \`$LOCAL_REVIEW_HOME\`, snapshots`,
    `- [prs files](${site('reference/pr-files')}): PR titles, descriptions, status, branches, GitHub links`,
    `- [Comment files](${site('reference/comment-files')}): the review threads' schema`,
    `- [HTTP API](${site('reference/http-api')}): the server's endpoints`,
    `- [CLI](${site('reference/cli')}): every \`local-review\` command`,
    `- [llms-full.txt](${i.live ? i.url : SITE_URL}/llms-full.txt): this file followed by the whole agent guide`,
    '',
    '## Optional',
    '',
    `- [PR stacks](${site('concepts/pr-stacks')}): how commits group into stacks`,
    `- [Linked projects](${site('concepts/linked-projects')}): a project that builds on another`,
    `- [Read-only guarantee](${site('guarantees/read-only')})`,
    `- [Never-delete guarantee](${site('guarantees/never-delete')})`,
    '',
  ].join('\n');
}

/** AGENT-GUIDE.md, with this server's URL and links to the docs pages' Markdown copies (GET /agent-guide.md). */
export function agentGuide(i: LlmsInput): string {
  return `${localize(i.guide.trimEnd(), i)}\n`;
}

/** /llms-full.txt: llms.txt, then the whole agent guide. */
export function llmsFullTxt(i: LlmsInput): string {
  return `${llmsTxt(i)}\n---\n\n${agentGuide(i)}`;
}
