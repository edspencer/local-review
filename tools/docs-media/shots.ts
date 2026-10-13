import fs from 'node:fs';
// The shots the docs site, README and launch posts are made from, all of the demo test bed (npm run demo:seed).
// capture.ts runs them; each one says what it's for, so a stale image can be traced back to the page using it.
//
// route:     a URL path; `{orchard-api:f6}` is replaced by that commit's sha (keys: demo/shas.json)
// actions:   what to do after the page has loaded, in order (selectors are Playwright selectors: CSS, :has-text(), …)
// capture:   'viewport' (default), 'page' (the whole scrollable page) or a crop: the box around one or more
//            elements, with `pad` CSS px around it and `zoom` (device pixels per CSS px, on top of the 2x default)
// storage:   localStorage entries set before the app loads (UI preferences, e.g. the diff style)
// compose:   instead of a route, a page built from earlier shots and the seed's own files or CLI output (see
//            ComposeContext), for the landing page's two-part pictures; capture crops it like any other page
// rig:       serve something other than the demo seed (RIGS below): an empty data home, the example projects, or a
//            copy of the seed with a staged change. Each is a throwaway copy in the temp dir, never demo/out

export type Action =
  | { click: string }
  | { hover: string }
  | { scrollTo: string; block?: 'start' | 'center' | 'end'; offset?: number }
  | { press: string }
  | { waitFor: string }
  | { wait: number };

export interface Crop {
  selector: string | string[]; // several: the box around all of them (each one's first match)
  pad?: number | { top?: number; right?: number; bottom?: number; left?: number }; // CSS px, default 16 all round
  zoom?: number; // default 1: the shot's own 2x
}

/** What a composed shot can draw on. Everything in it is real: captured shots, seed files, CLI output. */
export interface ComposeContext {
  shot(name: string): string; // a data: URL of out/<name>.png (the shot must come earlier in SHOTS)
  seedFile(rel: string): string; // a file under the seed's home (e.g. '.local-review/projects/waitlists/project.yaml')
  cli(args: string[]): string; // what `local-review <args>` prints against the seed
}

/** What a rig's `prepare` can do to its throwaway data home before the server starts. */
export interface RigContext {
  file(rel: string): string; // the absolute path of a file under the rig's home (e.g. '.local-review/projects/…')
  cli(args: string[]): string; // run `local-review <args>` against the rig's home; returns stdout
}

export interface Rig {
  name: string;
  doc: string; // what it is, and what in it (if anything) is staged
  from: 'demo' | 'empty'; // a copy of the demo seed, or a data home with nothing in it
  prepare?: (ctx: RigContext) => void;
}

export interface Shot {
  name: string; // the file: out/<name>.png
  doc: string;
  rig?: Rig; // default: the demo seed itself
  route?: string; // required unless compose is set
  compose?: (ctx: ComposeContext) => string; // the page's HTML
  viewport?: { width: number; height: number };
  storage?: Record<string, string>;
  actions?: Action[];
  capture?: 'viewport' | 'page' | Crop;
}

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const PROMOTE = '/waitlists/orchard-api/{orchard-api:f6}';

/** A small diagram for the lightbox shot: what happens to an offered spot (the "Automatic promotion" stack's story). */
const OFFER_FLOW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="400" viewBox="0 0 960 400" font-family="Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">
  <rect width="960" height="400" fill="#ffffff"/>
  <text x="40" y="52" font-size="22" font-weight="700" fill="#1f2328">What happens to an offered spot</text>
  <text x="40" y="80" font-size="14" fill="#59636e">One class, one spot: a member cancels and the first person on the waitlist gets two hours to take it.</text>
  <g font-size="15" fill="#1f2328">
    <rect x="40" y="150" width="170" height="64" rx="10" fill="#f6f8fa" stroke="#d1d9e0"/>
    <text x="125" y="178" text-anchor="middle" font-weight="600">Booking cancelled</text>
    <text x="125" y="199" text-anchor="middle" font-size="13" fill="#59636e">a spot opens</text>
    <rect x="290" y="150" width="190" height="64" rx="10" fill="#fbefff" stroke="#8250df"/>
    <text x="385" y="178" text-anchor="middle" font-weight="600">Offer to #1 in line</text>
    <text x="385" y="199" text-anchor="middle" font-size="13" fill="#59636e">held for 2 hours, by email</text>
    <rect x="590" y="100" width="170" height="64" rx="10" fill="#dafbe1" stroke="#1a7f37"/>
    <text x="675" y="128" text-anchor="middle" font-weight="600">Accepted</text>
    <text x="675" y="149" text-anchor="middle" font-size="13" fill="#59636e">booked; leaves the list</text>
    <rect x="590" y="220" width="170" height="64" rx="10" fill="#fff8c5" stroke="#9a6700"/>
    <text x="675" y="248" text-anchor="middle" font-weight="600">Expired</text>
    <text x="675" y="269" text-anchor="middle" font-size="13" fill="#59636e">the sweep, every minute</text>
  </g>
  <g stroke="#59636e" stroke-width="2" fill="none">
    <path d="M210 182 H282"/><path d="M276 176 L284 182 L276 188"/>
    <path d="M480 172 C530 172 540 132 582 132"/><path d="M575 126 L584 132 L576 139"/>
    <path d="M480 192 C530 192 540 252 582 252"/><path d="M575 246 L584 252 L576 259"/>
    <path d="M675 284 V340 H385 V222" stroke-dasharray="6 5"/><path d="M379 230 L385 220 L391 230"/>
  </g>
  <text x="530" y="362" text-anchor="middle" font-size="13" fill="#59636e">the next person in line gets the offer</text>
</svg>
`;

/** The rigs besides the demo seed. */
export const RIGS = {
  empty: {
    name: 'empty',
    doc: 'A brand-new install: a data home with no projects, so / is the first-run welcome page. Nothing staged.',
    from: 'empty',
  },
  examples: {
    name: 'examples',
    doc: 'A new user who ran `local-review examples` and nothing else: only the example projects. Nothing staged.',
    from: 'empty',
    prepare: (ctx) => {
      ctx.cli(['examples']);
    },
  },
  image: {
    name: 'image',
    doc: 'STAGED: the demo seed with a diagram (OFFER_FLOW_SVG) added by `local-review asset add` and put in the "Automatic promotion" stack note, which in the seed has no image.',
    from: 'demo',
    prepare: (ctx) => {
      const svg = ctx.file('offer-flow.svg');
      fs.writeFileSync(svg, OFFER_FLOW_SVG);
      const snippet = ctx.cli(['asset', 'add', 'waitlists', svg, '--alt', 'What happens to an offered spot']).trim();
      const yamlFile = ctx.file('.local-review/projects/waitlists/project.yaml');
      const yaml = fs.readFileSync(yamlFile, 'utf8');
      const anchor = 'expires offers nobody took and passes the spot on; the offer goes out by email.\n';
      if (!yaml.includes(anchor)) throw new Error('rig image: the "Automatic promotion" stack note changed; update the anchor');
      fs.writeFileSync(yamlFile, yaml.replace(anchor, `${anchor}\n          ${snippet}\n`));
    },
  },
} satisfies Record<string, Rig>;

export const SHOTS: Shot[] = [
  // ------------------------------------------------------------------------------------------- full pages
  {
    name: 'root-page',
    doc: 'Docs "Using the UI", the root page: every project as a card (thumbnail, totals, readiness, last activity).',
    route: '/',
    viewport: { width: 1440, height: 1500 },
    storage: { 'lr.rootArchivedOpen': 'true' },
  },
  {
    name: 'crop-linked-chain',
    doc: 'Docs "Linked projects": the root page\'s card for a chain of linked projects (Calendar feed → Calendar reminders).',
    route: '/',
    viewport: { width: 1440, height: 1500 },
    capture: { selector: '.project-chain', pad: 12 },
  },
  {
    name: 'crop-linked-stack-picture',
    doc: 'Docs "Linked projects": a successor\'s stack picture with Show <predecessor> on (the feed\'s stack greyed first).',
    route: '/calendar-reminders?tab=stack',
    storage: { 'lr.stackContext': '1', 'lr.stackTitle': '0' },
    actions: [{ waitFor: '.stack-tab-canvas img' }, { wait: 500 }],
    capture: { selector: '.stack-tab-canvas img', pad: 0 },
  },
  {
    name: 'project-home',
    doc: 'Landing hero, "Projects": the project page of a four-repo project, on its Stack tab (every repo and stack).',
    route: '/waitlists?tab=stack',
  },
  {
    name: 'project-home-full',
    doc: 'Docs "Using the UI", the project page: its header, tabs and the project intro (Conversation).',
    route: '/waitlists',
  },
  {
    name: 'stack-page',
    doc: 'Docs "Using the UI", the stack page: a stack\'s header, the project context and the stack note.',
    route: '/waitlists/orchard-api/stacks/3-automatic-promotion',
  },
  {
    name: 'stack-comments',
    doc: 'Docs "Using the UI", the Comments tab: every thread on a stack\'s PRs, open ones first, with their PR and line.',
    route: '/waitlists/orchard-api/stacks/3-automatic-promotion?tab=comments',
    actions: [{ waitFor: '.comments-tab-item' }],
  },
  {
    name: 'stack-comments-publish',
    doc: 'Docs "Using the UI", the Comments tab filtered to For GitHub: the threads marked for the real GitHub PR.',
    route: '/waitlists/orchard-api/stacks/3-automatic-promotion?tab=comments',
    actions: [{ waitFor: '.comments-tab-item' }, { click: '.comments-filter .is-publish' }, { waitFor: '.comments-tab-item.is-publish' }],
  },
  {
    name: 'welcome',
    doc: 'Docs "Quickstart" / "Using the UI": the first-run welcome page (no projects yet), with Add the example projects.',
    rig: RIGS.empty,
    route: '/',
    viewport: { width: 1440, height: 740 }, // the page ends at its footer links
  },
  {
    name: 'root-examples',
    doc: 'Docs "Quickstart": the root page right after adding the example projects (and nothing else).',
    rig: RIGS.examples,
    route: '/',
    viewport: { width: 1440, height: 1100 },
  },
  {
    name: 'crop-examples-strip',
    doc: 'Docs "Using the UI": an example project\'s sidebar, with the Example strip and its remove link.',
    rig: RIGS.examples,
    route: '/example-waitlists',
    capture: { selector: ['.sidebar .examples-strip', '.sidebar .sidebar-project'], pad: 8, zoom: 1.25 },
  },
  {
    name: 'lightbox',
    doc: 'Docs "Editing PR text", images: an image in a stack note, open in the lightbox (the image is staged, see RIGS.image).',
    rig: RIGS.image,
    route: '/waitlists/orchard-api/stacks/3-automatic-promotion',
    actions: [{ waitFor: '.markdown-body img' }, { click: '.markdown-body img' }, { waitFor: '.lightbox img' }, { wait: 300 }],
  },
  {
    name: 'crop-project-tabs',
    doc: 'Docs "Using the UI", the project page: its header and the Conversation | Comments | Stack tabs.',
    route: '/waitlists',
    viewport: { width: 1100, height: 900 }, // the crop spans the main column: narrow enough to sit at ~1:1 on a docs page
    capture: { selector: ['.project-home .pr-header', '.project-home .tabnav'], pad: 12 },
  },
  {
    name: 'crop-linked-bar',
    doc: 'Docs "Linked projects": a successor\'s project page, with the bar linking it to the project it builds on.',
    route: '/calendar-reminders',
    viewport: { width: 1100, height: 900 }, // the crop spans the main column: narrow enough to sit at ~1:1 on a docs page
    capture: { selector: ['.project-home .linked-bar', '.project-home .tabnav'], pad: 12 },
  },
  {
    name: 'crop-sidebar-links',
    doc: 'Docs "Linked projects": the sidebar of a linked project: Project page, then Builds on <predecessor>.',
    route: '/calendar-reminders',
    capture: { selector: ['.sidebar .sidebar-project', '.sidebar .repo:nth-of-type(1) .repo-heading'], pad: 8, zoom: 1.25 },
  },
  {
    name: 'crop-breadcrumbs',
    doc: 'Docs "Commits as PRs": a linked project\'s PR: the breadcrumbs (predecessor → project › repo · stack) above its header.',
    route: '/calendar-reminders/orchard-api/{orchard-api:Remind members an hour before each class}',
    viewport: { width: 1100, height: 900 }, // the crop spans the main column: narrow enough to sit at ~1:1 on a docs page
    capture: { selector: ['.crumbs', '.pr-header .pr-title-row'], pad: { top: 12, right: 12, bottom: 0, left: 12 } },
  },
  {
    name: 'pr-conversation',
    doc: 'Landing hero, README: a PR mid-review, the sidebar of colour-coded stacks on the left.',
    route: PROMOTE,
  },
  {
    name: 'pr-threads',
    doc: 'Docs "Review threads": an outdated thread after an amend, with the agent\'s reply, and an open range thread.',
    route: PROMOTE,
    actions: [{ scrollTo: '.timeline-item:has(.thread.outdated)', block: 'start', offset: -70 }],
  },
  {
    name: 'files-changed',
    doc: 'Docs "Files changed": the diff with an inline range thread, the file tree and Viewed checkboxes.',
    route: `${PROMOTE}?tab=files&file=internal/booking/promote.go`,
    storage: { 'lr.diffStyle': '"unified"' },
    viewport: { width: 1440, height: 1000 },
    actions: [{ waitFor: '.file-card .thread' }],
  },
  {
    name: 'stack-tab',
    doc: 'Docs "The stack picture": the Stack tab at "This repo", this PR highlighted, with its toolbar.',
    route: `${PROMOTE}?tab=stack`,
    viewport: { width: 1100, height: 1400 }, // narrow enough that the toolbar ends near the picture's edge
    storage: { 'lr.stackScope': 'repo' },
    actions: [{ waitFor: '.stack-tab-canvas img' }],
    capture: { selector: ['.stack-tab-toolbar', '.stack-tab-canvas'], pad: 12 },
  },
  {
    name: 'landed-pr',
    doc: 'Docs "Landed PRs": a merged PR keeps its number, its stack and its review, with GitHub\'s diff.',
    route: '/waitlists/orchard-api/{orchard-api:f1}',
  },
  {
    name: 'archived-project',
    doc: 'Docs "Landed PRs", archived projects: everything merged.',
    route: '/webhook-retries',
  },
  {
    name: 'single-repo-project',
    doc: 'Docs "Projects": a one-repo project with no stacks: one stack named after the branch.',
    route: '/calendar-feed/orchard-api/{orchard-api:Serve a private calendar feed per member}',
  },
  // ------------------------------------------------------------------------------------------- feature thumbnails
  {
    name: 'crop-sidebar-stacks',
    doc: 'Feature: stacks per repo, colour-coded, with readiness badges, branches and the merged / ready tallies.',
    route: PROMOTE,
    viewport: { width: 1440, height: 1100 },
    capture: { selector: ['.sidebar .repo:nth-of-type(1) .pr-stack:nth-of-type(1)', '.sidebar .follow-on-divider'], pad: 10 },
  },
  {
    name: 'crop-sidebar-repos',
    doc: 'Docs "Projects and repos": the sidebar\'s sections for three repos, each with its branch and its own stacks.',
    route: PROMOTE,
    viewport: { width: 1440, height: 1800 },
    capture: { selector: ['.sidebar .repo:nth-of-type(2)', '.sidebar .repo:nth-of-type(4)'], pad: { top: 10, right: 4, bottom: 10, left: 10 } },
  },
  {
    name: 'crop-sidebar-two-stacks',
    doc: 'Landing "Describe the work" (composed into landing-project-yaml): a repo\'s heading and its first two stacks.',
    route: PROMOTE,
    capture: { selector: ['.sidebar .repo:nth-of-type(1) .repo-heading', '.sidebar .repo:nth-of-type(1) .pr-stack >> nth=1'], pad: { top: 8, right: 0, bottom: 10, left: 10 } },
  },
  {
    name: 'crop-sidebar-lifecycle',
    doc: 'Docs "Readiness": one repo\'s three stacks, with every badge: merged, published, ready and draft.',
    route: PROMOTE,
    viewport: { width: 1440, height: 1100 },
    capture: { selector: ['.sidebar .repo:nth-of-type(1) .pr-stack:nth-of-type(1)', '.sidebar .repo:nth-of-type(1) .pr-stack >> nth=2'], pad: { top: 10, right: 4, bottom: 10, left: 10 } },
  },
  {
    name: 'crop-follow-on',
    doc: 'Feature: follow-on stacks, held back (yellow, faded, out of the totals).',
    route: PROMOTE,
    viewport: { width: 1440, height: 1100 },
    capture: { selector: ['.sidebar .follow-on-divider', '.sidebar .pr-stack.follow-on'], pad: 10, zoom: 1.25 },
  },
  {
    name: 'crop-branch-moved',
    doc: 'Feature: branch tagging: a recorded branch left behind by a rebase shows a warning.',
    route: PROMOTE,
    capture: { selector: '.sidebar .commit-item:has-text("Expire unconfirmed")', pad: 8, zoom: 1.5 },
  },
  {
    name: 'crop-stack-picture',
    doc: 'Feature: the stack picture, as copied or downloaded (drawn on the server).',
    route: `${PROMOTE}?tab=stack`,
    viewport: { width: 1440, height: 1700 },
    storage: { 'lr.stackScope': 'project' },
    actions: [{ waitFor: '.stack-tab-canvas img' }],
    capture: { selector: '.stack-tab-canvas', pad: 0 },
  },
  {
    name: 'crop-readiness-ready',
    doc: 'Landing "Mark it ready" (composed into landing-plan): the Draft | Ready toggle on a PR marked ready.',
    route: '/waitlists/orchard-sdk/{orchard-sdk:s2}',
    capture: { selector: ['.readiness-control', '.readiness-progress'], pad: 10, zoom: 1.5 },
  },
  {
    name: 'crop-pr-header',
    doc: 'Feature: the PR header: Draft | Ready, review progress, branch and the stack stepper.',
    route: PROMOTE,
    capture: { selector: '.pr-header', pad: 12 },
  },
  {
    name: 'crop-readiness',
    doc: 'Feature: readiness, the reviewer\'s call (Draft | Ready toggle and progress).',
    route: PROMOTE,
    capture: { selector: ['.readiness-control', '.readiness-progress'], pad: 10, zoom: 1.5 },
  },
  {
    name: 'crop-merged-pill',
    doc: 'Feature: a landed PR\'s Merged pill and "merged … (squash)".',
    route: '/waitlists/orchard-api/{orchard-api:f1}',
    capture: { selector: '.pr-header', pad: 12, zoom: 1.25 },
  },
  {
    name: 'crop-outdated-thread',
    doc: 'Feature: threads follow the code through rebases; this one became outdated after an amend.',
    route: PROMOTE,
    capture: { selector: '.timeline-item:has(.thread.outdated) .thread', pad: 12 },
  },
  {
    name: 'crop-carried-over',
    doc: 'Docs "Following rebases": the timeline note that a review was carried over from an earlier commit after a rebase.',
    route: PROMOTE,
    actions: [{ scrollTo: '.carried-over', block: 'center' }],
    capture: { selector: ['.timeline-event:has(.sha)', '.carried-over'], pad: { top: 10, bottom: 10, left: 12, right: 24 }, zoom: 1.25 },
  },
  {
    name: 'crop-agent-reply',
    doc: 'Feature: the agent replies in the YAML file; it shows up in the thread live.',
    route: PROMOTE,
    capture: { selector: '.timeline-item:has-text("only counts confirmed bookings") .thread', pad: 12 },
  },
  {
    name: 'crop-inline-thread',
    doc: 'Feature: an inline thread on a range of lines in the diff.',
    route: '/waitlists/orchard-web/{orchard-web:w1}?tab=files&file=src/components/ClassCard.tsx',
    viewport: { width: 1440, height: 1300 },
    storage: { 'lr.diffStyle': '"unified"' },
    actions: [{ waitFor: '.file-card .thread' }, { scrollTo: '.file-card .thread', block: 'center' }],
    // the commented lines are in the diff just above the thread
    capture: { selector: '.file-card .thread', pad: { top: 150, right: 12, bottom: 12, left: 12 } },
  },
  {
    name: 'crop-publish-thread',
    doc: 'Docs "Reviewing", comments for the GitHub PR: an inline thread marked For GitHub in Files changed, its box ticked.',
    route: `${PROMOTE}?tab=files&file=internal/booking/promote.go`,
    viewport: { width: 1440, height: 1300 },
    storage: { 'lr.diffStyle': '"unified"' },
    actions: [{ waitFor: '.file-card .thread.is-publish' }, { scrollTo: '.file-card .thread.is-publish', block: 'center' }],
    capture: { selector: '.file-card .thread.is-publish', pad: { top: 60, right: 12, bottom: 12, left: 12 } },
  },
  {
    name: 'crop-folded-threads',
    doc: 'Docs "Comments in the diff": in Files changed, the outdated thread (above the diff) and the resolved one (in it) folded to one row each.',
    route: `${PROMOTE}?tab=files&file=internal/booking/promote.go`,
    viewport: { width: 1440, height: 1000 },
    storage: { 'lr.diffStyle': '"unified"' },
    actions: [{ waitFor: '.file-card .thread.resolved.is-folded' }],
    capture: { selector: ['.file-card .thread.outdated.is-folded', '.file-card .thread.resolved.is-folded'], pad: 12 },
  },
  {
    name: 'crop-project-context',
    doc: 'Feature: the Project context and Stack context boxes above a PR description (they start every full PR body).',
    route: PROMOTE,
    capture: { selector: '.context-boxes', pad: 10 },
  },
  {
    name: 'crop-pr-description-edited',
    doc: 'Feature: a PR description rewritten locally (never in the commit), with the "edited" marker.',
    route: PROMOTE,
    capture: { selector: '.pr-description', pad: 10 },
  },
  {
    name: 'crop-pr-edit',
    doc: 'Feature: editing a PR description: the Write / Preview editor with its toolbar.',
    route: PROMOTE,
    viewport: { width: 1440, height: 1300 },
    actions: [{ click: '.pr-description button[aria-label="Edit description"]' }, { waitFor: '.pr-description.is-editing textarea' }],
    capture: { selector: '.pr-description', pad: 10 },
  },
  {
    name: 'crop-project-switcher',
    doc: 'Feature: the project switcher, with archived (all-landed) projects in their own section.',
    route: PROMOTE,
    storage: { 'lr.archivedOpen': 'true' },
    actions: [{ click: '.project-switcher button' }, { waitFor: '.project-menu' }],
    capture: { selector: '.project-menu', pad: 0, zoom: 1.25 },
  },
  // ------------------------------------------------------------------------------------------- landing page
  // The media column there is ~700 CSS px wide, so these are framed to sit at about 1:1 in it.
  {
    name: 'landing-root',
    doc: 'Landing "Keep every effort in view": two linked projects\' cards on the root page, framed for the ~700px media column.',
    route: '/',
    viewport: { width: 780, height: 1500 },
    capture: { selector: '.project-chain', pad: 12 },
  },
  {
    name: 'landing-project-yaml',
    doc: 'Landing "Describe the work": a repo and its first two stacks in project.yaml (from the seed), beside the sidebar they make.',
    compose: (ctx) => composeCard(
      'Two parts',
      `<div class="pair">
        <figure class="code"><figcaption>project.yaml <span>repos: › orchard-api (excerpt)</span></figcaption><pre>${tintYaml(yamlExcerpt(ctx.seedFile('.local-review/projects/waitlists/project.yaml'), 2))}</pre></figure>
        <img class="ui" src="${ctx.shot('crop-sidebar-two-stacks')}" width="${CROP_W.sidebar}">
      </div>`,
    ),
    capture: { selector: '.compose', pad: 0 },
  },
  {
    name: 'landing-plan',
    doc: 'Landing "Mark it ready, then publish": the Ready toggle, then what `local-review plan` prints for that PR (from the seed).',
    compose: (ctx) => composeCard(
      'Mark ready, then plan',
      `<div class="stack">
        <img class="ui toggle" src="${ctx.shot('crop-readiness-ready')}">
        <figure class="term"><figcaption><b>$</b> npx local-review plan waitlists --repo orchard-sdk --stack 1</figcaption><pre>${planExcerpt(ctx.cli(['plan', 'waitlists', '--repo', 'orchard-sdk', '--stack', '1']), 'PR #2 ')}</pre></figure>
      </div>`,
    ),
    capture: { selector: '.compose', pad: 0 },
  },
];

// ------------------------------------------------------------------------------------------------ composing

/** CSS px widths of the crops a composed page lays out (their PNGs are 2x). */
const CROP_W = { sidebar: 299 };

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The first repo of a project.yaml and its first `stacks` stacks, without descriptions or comments, de-indented to the
 * repo: what the sidebar crop beside it is made from.
 */
function yamlExcerpt(yaml: string, stacks: number): string {
  const lines = yaml.split('\n');
  const from = lines.findIndex((l) => l.startsWith('repos:'));
  const to = lines.findIndex((l, i) => i > from + 1 && l.startsWith('  - path:'));
  const out: string[] = [];
  let skipIndent = -1;
  for (const l of lines.slice(from, to)) {
    const indent = l.search(/\S/);
    if (skipIndent >= 0 && (indent > skipIndent || l.trim() === '')) continue;
    skipIndent = -1;
    if (/^\s*(description|landed|github_stack):/.test(l)) {
      if (/:\s*\|\s*$/.test(l)) skipIndent = indent;
      continue;
    }
    if (/^\s*#/.test(l)) continue;
    if (/^ {6}- title:/.test(l) && --stacks < 0) break;
    out.push(l);
  }
  // `repos:` and the list dash cost four columns on every line: show the repo's own keys, flush left
  return out.slice(1).map((l) => l.replace(/^ {4}|^ {2}- /, '')).join('\n') + '\n…';
}

function tintYaml(yaml: string): string {
  // strings first: the key markup has quotes of its own
  return esc(yaml)
    .replace(/"([^"\n]*)"/g, '<i class="s">&quot;$1&quot;</i>')
    .replace(/^(\s*-?\s*)([a-z_]+):/gm, '$1<i class="k">$2</i>:');
}

/** One PR's block from `plan` (markdown): its heading and fields, up to its body. */
function planExcerpt(md: string, pr: string): string {
  const lines = md.split('\n');
  const from = lines.findIndex((l) => l.startsWith(`### ${pr}`));
  if (from < 0) throw new Error(`plan: no "### ${pr}" heading`);
  const to = lines.findIndex((l, i) => i > from && (l.startsWith('Body:') || l.startsWith('### ')));
  return lines
    .slice(from, to)
    .filter((l) => l.trim())
    .map((l) => esc(l).replace(/^(- )([A-Za-z ]+):/, '$1<i class="k">$2</i>:').replace(/(Status<\/i>: )ready/, '$1<i class="ok">ready</i>'))
    .join('\n');
}

/** A light card in the app's own fonts and colours, so a composed picture sits beside the plain crops. */
function composeCard(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>
    body { margin: 0; padding: 24px; background: transparent; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif; color: #1f2328; }
    /* square and borderless: the landing page frames it (rounded, with its own border) */
    .compose { display: inline-block; padding: 18px; background: #f6f8fa; }
    .pair { display: flex; gap: 16px; align-items: flex-start; }
    .stack { display: flex; flex-direction: column; gap: 14px; align-items: flex-start; width: 640px; }
    figure { margin: 0; border: 1px solid #d1d9e0; border-radius: 8px; overflow: hidden; background: #fff; }
    figcaption { font-size: 12px; font-weight: 600; padding: 7px 12px; border-bottom: 1px solid #d1d9e0; background: #f6f8fa; }
    figcaption span { font-weight: 400; color: #59636e; margin-left: 4px; }
    pre { margin: 0; padding: 10px 12px; font: 11.5px/1.6 ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; white-space: pre; }
    .code pre { font-size: 12px; }
    i { font-style: normal; }
    .k { color: #8250df; } .s { color: #0a3069; } .ok { color: #1a7f37; font-weight: 600; }
    .term { width: 100%; border-color: #2a2d31; background: #16181b; color: #e6e6e6; }
    .term figcaption { background: #22252a; border-color: #2a2d31; color: #e6e6e6; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; }
    .term figcaption b { color: #e8a33d; }
    .term pre { white-space: pre-wrap; } .term .k { color: #d2a8ff; } .term .ok { color: #56d364; }
    img.ui { display: block; border: 1px solid #d1d9e0; border-radius: 8px; background: #fff; }
    img.toggle { width: 396px; }
  </style><div class="compose">${body}</div>`;
}
