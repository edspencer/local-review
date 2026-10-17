# local-review

## 0.11.2

### Patch Changes

- [#64](https://github.com/edspencer/local-review/pull/64) [`031d186`](https://github.com/edspencer/local-review/commit/031d1862fb66bfd364c1e3bd441a6fe129c66886) Thanks [@edspencer](https://github.com/edspencer)! - Docs: the README (shown on npm) now mentions the Comments tab, comments marked for the GitHub PR, drafts and
  `local-review service`, and links the service, editing and agent pages. `AGENT-GUIDE.md` (`local-review guide`, and
  `/llms-full.txt`) no longer says `/` lists every project: hidden ones (`hidden: true`) aren't listed.

## 0.11.1

### Patch Changes

- [#62](https://github.com/edspencer/local-review/pull/62) [`0beb234`](https://github.com/edspencer/local-review/commit/0beb234f8b307befb64edffb20e92156dcbffe2b) Thanks [@edspencer](https://github.com/edspencer)! - Dependency updates: `@hono/node-server` 2.1.5 (the server), and DOMPurify 3.4.17 and marked 18.1.1, which are bundled
  into the UI and render and sanitise PR descriptions and comments.

## 0.11.0

### Minor Changes

- [#60](https://github.com/edspencer/local-review/pull/60) [`c99ebde`](https://github.com/edspencer/local-review/commit/c99ebdeb10884d2a501dc01b120f0839b634bb34) Thanks [@edspencer](https://github.com/edspencer)! - `local-review service install | uninstall | status | restart` runs Local Review in the background, started at login
  and restarted if it exits: a launchd LaunchAgent on macOS (`~/Library/LaunchAgents/local-review.server.plist`), a
  systemd user unit on Linux (`~/.config/systemd/user/local-review-server.service`). The service runs the installed
  `local-review` and the Node that installed it, by absolute path, with a `PATH` that must find git, on 127.0.0.1 only,
  with an optional `--port`, your `HOME`, and the `LOCAL_REVIEW_HOME` / `LOCAL_REVIEW_USER` set at install. Its output goes to
  `logs/` in the data home. Running `install` again rewrites it and keeps its port and environment unless given new
  ones; `--dry-run` prints the file and does nothing. It refuses to run from npx's cache (and pnpm dlx's, bunx's, yarn
  dlx's) or from a source checkout (unless `--from-checkout`), saying what to do instead. `uninstall` removes the
  service's file and nothing else. Windows isn't supported: it says so and does nothing.

## 0.10.3

### Patch Changes

- [#56](https://github.com/edspencer/local-review/pull/56) [`2452c81`](https://github.com/edspencer/local-review/commit/2452c819263089b14630569fcf9d229314fec000) Thanks [@edspencer](https://github.com/edspencer)! - The first page load after a restart is much faster. What git says about each commit (subject, author, changed files, merge-bases, ancestry, patch-ids) is now kept in `~/.local-review/cache/`, so a restart needs a couple of dozen git processes rather than several per commit: 403 down to 27 on a 13-range setup. The cache is disposable: delete it any time.

## 0.10.2

### Patch Changes

- [#52](https://github.com/edspencer/local-review/pull/52) [`fdfdb59`](https://github.com/edspencer/local-review/commit/fdfdb59f8b2498c760cfb5f7ce40e30030fc51d2) Thanks [@edspencer](https://github.com/edspencer)! - A git call that never finishes no longer hangs the server. Each one now times out after 60 seconds, so a git process stuck in the system (seen with endpoint-security agents on macOS) costs one failed read and the next poll recovers, instead of every project page hanging until restart.

- [#54](https://github.com/edspencer/local-review/pull/54) [`49a7d80`](https://github.com/edspencer/local-review/commit/49a7d806cc848d397db302c110ef09e575df58c8) Thanks [@edspencer](https://github.com/edspencer)! - The branch poll is now nearly free. It used to run two git processes per repo range every 2 seconds, tens of thousands an hour with a dozen ranges, which an endpoint-security agent checking every program launch turns into constant CPU use. It now checks the files git keeps refs in and runs git only when a ref may have moved (an editor's background fetch that moves nothing doesn't count), plus once every 10 minutes as a safety net. It also shares each repo's branch list between its ranges, and doesn't run at all while no browser has a page open.

## 0.10.1

### Patch Changes

- [#50](https://github.com/edspencer/local-review/pull/50) [`7554fa7`](https://github.com/edspencer/local-review/commit/7554fa70a6c98e2124d939bd71f8e6bea0f60b3c) Thanks [@edspencer](https://github.com/edspencer)! - The root page's linked projects no longer label each card `1 · FIRST`, `2 · BUILDS ON …`: the arrows already show the order.

## 0.10.0

### Minor Changes

- [#48](https://github.com/edspencer/local-review/pull/48) [`4d47087`](https://github.com/edspencer/local-review/commit/4d4708792d454160f2e7f80de3e8963e3bfd3e8b) Thanks [@edspencer](https://github.com/edspencer)! - A project can be hidden: `hidden: true` in its `project.yaml` leaves it off the root page (its cards and the section
  counts) and out of the project switcher, without deleting or moving anything. Its URL still opens it, and the switcher
  lists it while it's the open one. `after:` links to and from it still hold, so no range changes. In a chain of linked
  projects, the card closes over a hidden one: the next project shown is labelled as building on the nearest one shown,
  and a predecessor's "Next" links leave it out. `/api/projects` has a `hidden` field, and `/llms.txt` marks hidden
  projects in its list (their slugs are still taken).

## 0.9.0

### Minor Changes

- [#44](https://github.com/edspencer/local-review/pull/44) [`6a69842`](https://github.com/edspencer/local-review/commit/6a6984207e9e51778501a3e6a03cec4a6bb4af14) Thanks [@edspencer](https://github.com/edspencer)! - Every text box now keeps a draft as you type, the way GitHub's do: PR titles and descriptions, the project intro, stack
  notes, new comments, replies, inline comments (on their line or range) and edits of your comments. Drafts are kept in
  the browser's localStorage, so they survive a reload, a closed tab or a crash; the editor reopens with "Restored an
  unsaved draft from 10:42" and a Discard button. A draft is cleared when it's saved, cancelled or discarded, or when the
  saved text comes to say the same, and never when a save fails. If the saved text changed meanwhile (an agent edited the
  prs file or `project.yaml`), the editor offers "Load it" or "Keep mine" instead of overwriting either. A small amber dot
  marks the PRs, tabs and stacks with drafts waiting. Drafts follow a rebase like review files do (patch-id, else a
  unique subject), expire after 30 days, and are capped in size. Two tabs on the same page share them.
  
  Drafts never leave the browser until you save them. The "Leave site?" prompt is gone, since drafts come back anyway;
  it only appears if the browser couldn't keep one (its storage is full or turned off).

- [#43](https://github.com/edspencer/local-review/pull/43) [`21d5d1c`](https://github.com/edspencer/local-review/commit/21d5d1c54cdca95287ca3c0dd5b86ba7b83136a9) Thanks [@edspencer](https://github.com/edspencer)! - The project and stack pages have a **Comments** tab: every comment thread on every PR there (in all repos and stacks
  on the project page, and published or not), general and inline alike. Open threads come first, then the most recently
  updated. Each thread says which PR it's on and, if it's inline, its `file:line`, which opens Files changed scrolled to
  that thread. Resolved and outdated threads start folded, as in Files changed. You can reply, resolve, edit and delete
  there, and the list and the tab's counter of open threads update live. A PR page now takes `?thread=<id>` to jump to a
  thread and open it. New, read-only: `GET /api/projects/:p/threads` (`?repo=<name>&stack=<ref>` for one stack).

- [#45](https://github.com/edspencer/local-review/pull/45) [`b2e9a60`](https://github.com/edspencer/local-review/commit/b2e9a60a3efb1174ab5ad3db2daa04923209dc5c) Thanks [@edspencer](https://github.com/edspencer)! - Review threads can be marked **for the GitHub PR**: a **For the GitHub PR** box in the composer for new general and
  inline comments, and on every existing thread (Conversation, Files changed and the Comments tab). A marked thread has
  a teal **For GitHub** label (**On GitHub ↗**, a link, once the agent has posted it), isn't counted as an open thread
  or in review progress, and is left for the agent to post as a GitHub review when it publishes the stack. The Comments
  tab gets **All / Open / For GitHub** filters with counts. In the review file it's `publish: true` on the thread, and
  the agent records `published: {url, id, at}`; `POST …/threads` takes `publish`, and `PATCH …/threads/:tid` takes
  `publish` and `published`. `local-review plan` lists each PR's marked threads with file and line (`publish_threads`
  in JSON) and warns about outdated ones and published PRs with comments not posted yet. Local Review still never talks
  to GitHub, and reads nothing back from it.

## 0.8.0

### Minor Changes

- [#41](https://github.com/edspencer/local-review/pull/41) [`7fbe26f`](https://github.com/edspencer/local-review/commit/7fbe26ff0dbd421c3cf6b0968f1070bbbc429d3a) Thanks [@edspencer](https://github.com/edspencer)! - For coding agents: the server now serves `/llms.txt`, with what an agent needs to create a project for you (the rules,
  the steps, the commented `project.yaml` example, and this machine's data directory and existing projects), plus
  `/llms-full.txt` (the same, then the whole agent guide) and `/agent-guide.md`. Tell your agent "Read
  http://localhost:5622/llms.txt and create a local-review project for my feature-xyz branch on ~/code/my-git-project".
  The docs site has copies, and serves every page as Markdown too (`/reference/project-yaml.md`). The agent guide has a
  new "Setting up a project" section.
  
  On start, `npx local-review` prints a LOCAL REVIEW banner in plum and amber, then the "Local Review on …" line, then
  that hint with the port it's actually on. The banner is only shown on a terminal (not when piped, logged or in CI,
  unless `FORCE_COLOR` is set), honours `NO_COLOR`, and becomes a one-line title on terminals narrower than 80 columns.
  `--quiet` (`-q`) prints only the "Local Review on …" line.

## 0.7.0

### Minor Changes

- [#40](https://github.com/edspencer/local-review/pull/40) [`4fda380`](https://github.com/edspencer/local-review/commit/4fda3809727914867622e04d41dd2726d44d8da2) Thanks [@edspencer](https://github.com/edspencer)! - Drag the sidebar's right edge to resize it (200px up to half the window, at most 600px): the width is remembered for
  every project and page, double-click the edge to reset it, and Tab to it to resize with ← / →. In Files changed,
  every thread now folds to one row (status, `file:line`, author, the start of the first comment, the comment count):
  resolved and outdated threads start folded, resolving a thread folds it and unresolving opens it. The Conversation
  tab is unchanged.

### Patch Changes

- [#39](https://github.com/edspencer/local-review/pull/39) [`068e6c9`](https://github.com/edspencer/local-review/commit/068e6c9ac24f35d3a32d6ccc11ee2b43ab0ecb47) Thanks [@edspencer](https://github.com/edspencer)! - Fixes from the docs audit:
  
  - **Rebased reviews say so.** When a PR's review came over from an earlier commit after a rebase, its Conversation tab now shows "Review carried over from <sha> after a rebase (matched by patch-id / Change-Id / subject)".
  - **`local-review move` after a rebase** now moves a commit's data that's still in its old sha's file (before anything was written under the new sha), instead of reporting "nothing recorded" and leaving the threads behind.
  - **A `repos:` entry without a `path`** (or that isn't a mapping) is now a project warning, on the project page, in the sidebar and in `local-review plan`, instead of being dropped silently. `plan` now prints the other project warnings too (e.g. a bad `after:`).
  - **A ref Local Review won't pass to git** (say a `branch` with a space) is reported as such, instead of "not found".
  - **The example projects:** running `local-review examples` while the UI's Add is building them no longer makes a second set of repos (`orchard-<id>-2`). The welcome page counts them right: four, not three.
  - **The root page:** a card's readiness tally wraps instead of hiding its merged count at some widths, and thumbnails are drawn at the card's width, so their repo labels are the same size on every card.
  - **The header** shows only the keyboard shortcuts the page you're on has, and the Archived section's tooltip says what makes a project archived (some repo has landed PRs and none has a live commit).

- [#36](https://github.com/edspencer/local-review/pull/36) [`47794e6`](https://github.com/edspencer/local-review/commit/47794e6471c2ef5de75f7d4ef7d999059b55bb47) Thanks [@edspencer](https://github.com/edspencer)! - The stack picture's SVG (`stack.svg`) now names a generic fallback after its fonts (`Inter, sans-serif` and
  `'JetBrains Mono', monospace`), so opened directly in a browser without Inter it no longer falls back to a serif
  font. The PNG is unchanged.

## 0.6.0

### Minor Changes

- [#33](https://github.com/edspencer/local-review/pull/33) [`9c35c9d`](https://github.com/edspencer/local-review/commit/9c35c9d5017741b183b9fd70c6249ff66625d882) Thanks [@edspencer](https://github.com/edspencer)! - Linked projects: a project can say it builds on another with `after: <slug>` in its `project.yaml`. In a repo both
  review, its range then starts where the other one's ends (while that's still an ancestor of its branch, and at its
  `base` again once the first has merged and it's been rebased), and `local-review plan` bases its first PR there on the
  other project's top PR. Local Review warns when the link doesn't hold, e.g. a squash-merged predecessor whose commits
  are still in the range. Linked projects are shown together on the root page, linked from each other's project pages,
  the sidebar, breadcrumbs and the project switcher, and the stack picture can draw the predecessor's stacks too,
  greyed out (**Show …**, or `?context=1`).
  
  New: `local-review move <from> <to> <repo> (<sha>… | --stack <n>)` moves PRs' review data (prs and reviews files)
  from one project to another, for splitting a project: it copies, never over an existing file, and renames the
  originals to `.bak`, after a snapshot.
  
  The example projects gain **Calendar reminders**, which builds on **Calendar feed**. If you already have the
  examples, **Add the new example project** (on the root page's Examples heading or in the project switcher, or
  `local-review examples`) adds just that one.

- [#32](https://github.com/edspencer/local-review/pull/32) [`fce46ae`](https://github.com/edspencer/local-review/commit/fce46ae5a10e980ec784f3c51b381056498692de) Thanks [@edspencer](https://github.com/edspencer)! - A root page at `/`: every project as a card, most recently active first. Each card has a small thumbnail of the
  project's stacks (a lane per repo, a bar per PR, filled by readiness), its repo / stack / PR counts and +/− lines, a
  readiness bar with counts, the open threads and when it last saw activity (a comment, a commit, a merge or an edit).
  Filter by title, repo or branch (press `/`), sort by activity, title, size or open threads; archived projects and the
  example projects have their own sections. The LOCAL REVIEW wordmark and a new **All projects** item at the top of the
  project switcher go there. `/` used to open the most recently modified project's first commit; that project is now
  the first card.

## 0.5.0

### Minor Changes

- [#29](https://github.com/edspencer/local-review/pull/29) [`967d0ea`](https://github.com/edspencer/local-review/commit/967d0ea3337cdde8fe6d1f92e25483f5e9079ff3) Thanks [@edspencer](https://github.com/edspencer)! - Moving between PRs is instant. A PR you've opened before, the PRs either side of the one you're on, and a sidebar
  row you rest the pointer on are loaded in the background and open at once; anything else keeps the PR you were on in
  view, with a thin amber bar along the top of the window, instead of a blank "Loading…" page. The server is much faster
  too: it now works out a project's stacks, branches and comments only when something changed (a file, a branch, a
  rebase), so a page that took 150–500 ms takes a few. Branches are polled every 2 seconds (was 3), and a moved base or a
  new branch now shows up live as well.

- [#30](https://github.com/edspencer/local-review/pull/30) [`04423c8`](https://github.com/edspencer/local-review/commit/04423c8750316d4ce43ff1cac640d273dada2343) Thanks [@edspencer](https://github.com/edspencer)! - Stack pages, and a project page laid out like a PR page.
  
  - **Stack pages** (`/<project>/<repo>/stacks/<n>-<title>`): one stack with its header (STACK n in its colour, readiness tally or Merged, repo and branches, PRs and +/−), a Conversation tab with the project context and the stack note (editable in place, with images) and a Stack tab with the picture of just that stack. Open one from a stack's title in the sidebar, its name in a PR's stepper, or the breadcrumbs. The URL follows a stack that was reordered or renamed in `project.yaml`.
  - **The project page** (`/<project>`) now has Conversation (the project intro) and Stack (the whole picture) tabs. The list of repos, stacks and PRs beside the picture is gone: the sidebar shows the same, and stack notes are now edited on stack pages (or from a PR page).
  - **Easier to reach:** a link to the project page at the top of the sidebar, and breadcrumbs (Project › repo · Stack n › PR #m) on stack and PR pages.
  - **Context on PR pages** is two separate, collapsible boxes, **Project context** and **Stack context**, each linking to its page and editable in place. Images in them show as thumbnails and open in the lightbox.
  - New endpoint: `GET /api/projects/:p/repos/:r/stacks/:ref/stack.svg|png`.

## 0.4.0

### Minor Changes

- [#26](https://github.com/edspencer/local-review/pull/26) [`853927f`](https://github.com/edspencer/local-review/commit/853927f12a52024dc6a05a047951c3a5103d9226) Thanks [@edspencer](https://github.com/edspencer)! - Click an image in a PR description, stack note, the project intro, a comment or an editor's preview to see it in a
  viewer over the page, fitted to the window. Click it again to see it at full size and scroll or drag around it;
  ← / → step through the other images in the same block, and Esc closes it. An image inside a link still opens its
  link, unless the link is to the image itself.

## 0.3.0

### Minor Changes

- [#23](https://github.com/edspencer/local-review/pull/23) [`6af921a`](https://github.com/edspencer/local-review/commit/6af921a47a32e7d30324e2149730e007a4200d4e) Thanks [@edspencer](https://github.com/edspencer)! - A first-run welcome page, and one-click example projects:
  
  - With no projects, the UI now shows a welcome page instead of a bare "No projects yet": what Local Review is, how to
    create your first project (or a prompt to hand that to your coding agent), and links to the docs.
  - **Add the example projects** (on that page, at the bottom of the project switcher, or `local-review examples`)
    creates "Orchard", a made-up app reviewed across four repos, in about a second and with no network: stacked PRs,
    review threads with an agent's replies, and a fully merged stack to click around. They're marked **Example**.
  - **Remove examples** hides them again and deletes nothing: each example's `project.yaml` is renamed to a `.bak`, and
    adding them again brings them back as you left them. A project of your own is never touched.

## 0.2.0

### Minor Changes

- [#20](https://github.com/edspencer/local-review/pull/20) [`205a9a4`](https://github.com/edspencer/local-review/commit/205a9a4573831fdb866c5a7086356c0a410609d5) Thanks [@edspencer](https://github.com/edspencer)! - Images in PR descriptions, stack notes and the project intro. Paste, drop or attach an image in any of their editors,
  or add one with `local-review asset add <project> <file>`, which prints the markdown (`![alt](assets/<hash>.png)`).
  Images live in the project's `assets/` folder, named by their content, and are never replaced or deleted; snapshots
  hard-link them instead of copying them. PNG, JPEG, GIF, WebP and SVG up to 5 MB, checked by their contents, and served
  with `nosniff` and a Content Security Policy that stops an SVG running script. GitHub can't show a local image, so
  `local-review plan` warns about each one, and puts its URL in the body instead once you record where it's published
  with `local-review asset url <project> <name> <url>`.

- [#10](https://github.com/edspencer/local-review/pull/10) [`89ddc0b`](https://github.com/edspencer/local-review/commit/89ddc0be153ffb5675545bdcb945a45cbb4a7544) Thanks [@edspencer](https://github.com/edspencer)! - **Breaking: the default port is now 5622, not 5000.** macOS uses port 5000 for AirPlay, so Local Review now serves on
  http://localhost:5622. If you have bookmarks, scripts or agent prompts that say `localhost:5000`, update them, or keep
  the old port with `local-review --port 5000` (or `PORT=5000`).
  
  Local Review is now an installable npm package. Run it with `npx local-review`, or install it once with
  `npm i -g local-review` and run `local-review`. It has four commands:
  
  - `local-review [serve] [--port <n>]` serves the UI (the default command).
  - `local-review init <project>` creates a project from a commented example.
  - `local-review plan <project>` prints the read-only materialization plan.
  - `local-review guide` prints the guide for coding agents.
  
  The package ships compiled JavaScript and a prebuilt UI, so it no longer needs `tsx` or a build step at run time, and
  it installs only its runtime dependencies. It needs Node.js 22 or later.
  
  The guide for agents using Local Review on your repos moved from `AGENTS.md` to `AGENT-GUIDE.md`, and
  `local-review guide` prints it, so an agent can read it without a checkout. `AGENTS.md` now holds the conventions
  for contributing to Local Review itself.
  
  There's a new logo and favicon.

### Patch Changes

- [#18](https://github.com/edspencer/local-review/pull/18) [`eab708f`](https://github.com/edspencer/local-review/commit/eab708f7808b1a49313de9b5b5fc0d4c3eea64d4) Thanks [@edspencer](https://github.com/edspencer)! - Display fixes:
  
  - A PR title or description written into a prs file that matches the commit message (ignoring whitespace) no longer
    shows as "edited", and `local-review plan` no longer says "(edited)" for it. The file itself isn't changed.
  - Tabs in code in the Conversation tab (code blocks in comments and descriptions, and the code under inline
    threads) are now as wide as in the Files changed diff, instead of 8 columns.
  - A repo whose PRs have all merged is labelled **merged** on the project homepage and in the stack picture, as it
    already was in the sidebar, instead of with its base branch (for example `origin/main`).
  - Paths under your home directory are shown as `~/…`, for example `~/.local-review/projects/…`. The API still returns
    absolute paths, and now always does: they used to be relative to Local Review's own directory when your data was
    inside it. `GET /api/projects` also returns `home`, the home directory the UI shortens paths against.

- [#19](https://github.com/edspencer/local-review/pull/19) [`45e5b6f`](https://github.com/edspencer/local-review/commit/45e5b6f214f5f917e17ea44a9f3563d563bdd969) Thanks [@edspencer](https://github.com/edspencer)! - The documentation now lives at https://local-review.edspencer.net, and the README is a short introduction that links
  to it. The "No projects yet" page links to the docs' Quickstart and `project.yaml` reference, and the example
  `project.yaml` and `local-review guide` point at the docs too. The agent guide's "Importing a historical stack" section
  now covers how stacks merged with ghstack, Sapling, Graphite and GitHub's own stacks look on GitHub.
