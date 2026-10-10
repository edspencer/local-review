// The shots the docs site, README and launch posts are made from, all of the demo test bed (npm run demo:seed).
// capture.ts runs them; each one says what it's for, so a stale image can be traced back to the page using it.
//
// route:     a URL path; `{orchard-api:f6}` is replaced by that commit's sha (keys: demo/shas.json)
// actions:   what to do after the page has loaded, in order (selectors are Playwright selectors: CSS, :has-text(), …)
// capture:   'viewport' (default), 'page' (the whole scrollable page) or a crop: the box around one or more
//            elements, with `pad` CSS px around it and `zoom` (device pixels per CSS px, on top of the 2x default)
// storage:   localStorage entries set before the app loads (UI preferences, e.g. the diff style)

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

export interface Shot {
  name: string; // the file: out/<name>.png
  doc: string;
  route: string;
  viewport?: { width: number; height: number };
  storage?: Record<string, string>;
  actions?: Action[];
  capture?: 'viewport' | 'page' | Crop;
}

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const PROMOTE = '/waitlists/orchard-api/{orchard-api:f6}';

export const SHOTS: Shot[] = [
  // ------------------------------------------------------------------------------------------- full pages
  {
    name: 'project-home',
    doc: 'Landing hero, "Projects": the homepage of a four-repo project, with the stack picture and the stack list.',
    route: '/waitlists',
  },
  {
    name: 'project-home-full',
    doc: 'Docs "Using the UI", the homepage: the whole page, top to bottom.',
    route: '/waitlists',
    capture: 'page',
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
    doc: 'Docs "The stack picture": the Stack tab, this PR highlighted.',
    route: `${PROMOTE}?tab=stack`,
    actions: [{ waitFor: '.stack-tab-canvas img' }],
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
    capture: { selector: ['.sidebar .repo:first-child .pr-stack:nth-of-type(1)', '.sidebar .follow-on-divider'], pad: 10 },
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
    name: 'crop-project-context',
    doc: 'Feature: the project intro and stack note, which start every full PR body.',
    route: PROMOTE,
    capture: { selector: '.project-context', pad: 10 },
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
];
