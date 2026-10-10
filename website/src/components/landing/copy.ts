/**
 * Landing-page copy, in one place.
 *
 * Every string the landing page renders lives here rather than being scattered
 * through the components, so the words can be worked on without touching markup.
 * (Same arrangement as Paddock's site.)
 *
 * Every claim here should be checkable against the docs pages it links to (the
 * edit pass checked them against the code). The media are captures of the
 * demo test bed: see FEATURES.
 */

import { REPO_URL, TAGLINE } from '../../site.mjs';

export { REPO_URL };

export const hero = {
	/** Small line above the H1. */
	eyebrow: 'Open source · MIT · runs on your machine',
	/** The H1. */
	title: `${TAGLINE}.`,
	lede: 'Local Review shows every commit on your branch as its own pull request, grouped into the stacks you mean to open, in a GitHub-style review UI that runs on your machine.',
	body: 'Comment, get your agent to fix things, and mark PRs ready while it is still just you and your agent. Nothing goes to GitHub until the stack is right.',
};

/** The one command worth pasting. */
export const QUICKSTART = {
	id: 'quickstart',
	label: 'Quick start',
	blurb: 'Needs Node 22+ and git. Reads your repos, never writes to them.',
	command: 'npx local-review',
	link: { text: 'Set up your first project', href: '/getting-started/quickstart/' },
} as const;

/** The second item in the strip: a link, not a tab (see CommandTabs.astro). */
export const SECONDARY_LINK = {
	label: 'Other ways to install',
	href: '/getting-started/installation/',
	title: 'Installation: npx, a global install, or from source',
} as const;

/** The hero buttons, repeated in the closing section. */
export const HERO_LINKS = [
	{ text: 'Get started', href: '/getting-started/quickstart/', icon: 'arrow', primary: true },
	{ text: 'Read the docs', href: '/introduction/', icon: 'docs', primary: false },
	{ text: 'View on GitHub', href: REPO_URL, icon: 'github', primary: false },
] as const;

/** The value-prop grid under the fold. */
export const VALUE_PROPS = [
	{
		icon: 'stack',
		title: 'Every commit is a PR',
		body: 'Each commit gets a Conversation tab and a Files changed tab, numbered and grouped into colour-coded stacks: one PR per commit, the way the stack will go up on GitHub.',
	},
	{
		icon: 'repos',
		title: 'Stacks across repos',
		body: 'One project can span several repos, each with its own branch and stacks, so a change that touches the API, the client and the infra is reviewed as one piece of work.',
	},
	{
		icon: 'chat',
		title: 'Your agent answers in the review',
		body: 'Comments are plain YAML files. Your agent reads them, fixes the commits and replies in the same files, and its replies appear in your browser as it works.',
	},
	{
		icon: 'lock',
		title: 'Read-only by construction',
		body: 'Local Review never fetches, checks out, commits or rebases. All git access goes through one read-only allow-list, so it cannot touch the repos it shows you.',
	},
	{
		icon: 'shield',
		title: 'Local, and careful with your work',
		body: 'Local Review never talks to GitHub and only answers on localhost. It never deletes your review, and snapshots it every hour that something changes.',
	},
	{
		icon: 'rocket',
		title: 'Publish when it is right',
		body: 'When a stack is ready, your agent opens it as GitHub stacked PRs with the titles and descriptions you approved, one stack at a time, then records what it created.',
	},
] as const;

/**
 * The scroll-swap "how it works" section: each entry is one step and the media
 * that goes with it.
 *
 * Media rule (Paddock's, learned the hard way there): tight CROPS of one feature
 * at close to 1:1, never full-window screenshots, because the media column is
 * only ~700px wide. Every image comes from the demo test bed's capture rig
 * (tools/docs-media: `src` is a shot in shots.ts, copied into
 * src/assets/landing/ by `npm run docs:media:sync`); two of them are composed
 * there from a crop and the seed's own project.yaml or `plan` output. The demo
 * project ("Orchard", class waitlists) is fictional: say so in any caption.
 * Each is drawn at half its pixel size (the PNGs are 2x), with width and height
 * set from the file, so the stage reserves the space and nothing shifts.
 */
export const FEATURES = [
	{
		title: '1. Describe the work',
		body: 'A project is one YAML file: the repos involved, the branch to review in each, and where each stack starts. Pick stacks by commit subject and they survive every rebase.',
		media: {
			src: 'landing-project-yaml',
			alt: 'A project.yaml excerpt naming a repo, its branch and three stacks by the commit subject each starts at, beside the sidebar it produces: the same three stacks, colour-coded, with their PRs and readiness badges',
		},
	},
	{
		title: '2. Review each commit as a PR',
		body: 'Read the diff with split or unified views, comment on a line or a range, resolve threads and tick files as viewed. Readiness badges show where every PR in every stack stands.',
		media: {
			src: 'crop-inline-thread',
			alt: 'A comment thread on a range of lines in a diff: the commented lines are tinted, and the reviewer’s comment and a reply sit under them',
		},
	},
	{
		title: '3. Your agent replies',
		body: 'Hand the project to your coding agent. It reads your threads, fixes each commit where it stands and answers in the review files. Threads follow their code through the rebase.',
		media: {
			src: 'crop-agent-reply',
			alt: 'A thread on five lines of Go: the reviewer points out that a spot on offer still looks free, and Claude, marked as an agent, replies with two ways to fix it and asks which to do',
		},
	},
	{
		title: '4. Mark it ready, then publish',
		body: 'Mark each PR ready. The plan command prints every branch, base, title and body, and on your go-ahead your agent opens the stack on GitHub and records each PR back in Local Review.',
		media: {
			src: 'landing-plan',
			alt: 'The Draft | Ready toggle set to Ready, and below it the output of local-review plan for that PR: its commit, branch, base, status ready, title, and GitHub: not created',
		},
	},
] as const;

/** The "works with your agent" section. */
export const AGENTS = {
	eyebrow: 'Works with your agent',
	title: 'Plain files in, plain files out.',
	body: 'There is no plugin and no API key. Local Review keeps your review in YAML files under ~/.local-review, so any coding agent that can read and write files can take part: Claude Code, Codex, or the next one.',
	points: [
		{
			title: 'A guide written for agents',
			body: '`local-review guide` prints the agent guide: the data model, how to answer threads, how to fix a commit mid-stack, how to publish, and what to do after merges.',
		},
		{
			title: 'A plan, not guesswork',
			body: '`local-review plan` prints exactly what each PR should be on GitHub, as Markdown, JSON or YAML, so publishing is mechanical.',
		},
		{
			title: 'One prompt to hand off',
			body: 'Paste the hand-off prompt into your agent and it works through your open threads the way the guide says: fix, reply, resolve only what it should.',
		},
	],
	link: { text: 'Read the agent guide', href: '/agents/agent-guide/' },
	/** The review file shown in the code card. Illustrative, not real data. */
	file: 'reviews/my-service/3f9c2e1….yaml',
	sample: `threads:
  - id: t-1a2b3c4d
    path: src/config/loader.ts
    side: right
    line: 42
    resolved: false
    comments:
      - id: c-5e6f7a8b
        author: ada
        body: |
          This swallows the parse error. Can we
          surface the file name and line instead?
      - id: c-9d0e1f2a
        author: claude
        body: |
          Done in the amended commit: the error now
          reads "config.yaml:12: unexpected key".`,
} as const;
