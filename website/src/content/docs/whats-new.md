---
title: What's new
description: Release notes for Local Review.
---

The highlights of each release. The full list is in
[CHANGELOG.md](https://github.com/edspencer/local-review/blob/main/CHANGELOG.md), and each version's notes are on
[GitHub Releases](https://github.com/edspencer/local-review/releases).

## 0.11.0: run it as a service

- **`local-review service install` keeps it running.** After `npm i -g local-review`, it installs Local Review as a
  launchd LaunchAgent on macOS or a systemd user unit on Linux, so the UI is on `http://localhost:5622` from login
  onwards and comes back if it exits. `service status`, `service restart` and `service uninstall` do what they say;
  uninstall removes the service's file and nothing in `~/.local-review`. It runs the installed `local-review` with
  absolute paths and a `PATH` that finds git, still on 127.0.0.1 only, and refuses to run from npx's cache, which npm
  can delete at any time. Upgrading is `npm i -g local-review@latest`, then `local-review service restart`. Not on
  Windows. See [Run it as a service](/getting-started/service/).

## 0.10.0: hidden projects, and a lighter server

- **`hidden: true` keeps a project off the root page.** Add it to a `project.yaml` and the project is left off the
  root page (and its counts) and out of the project switcher, without deleting or moving anything: for a parked
  experiment, or a demo of linked projects that leaves the last one out. Its URL still opens it, and `after:` links
  to and from it still hold, so no range changes. In a chain, the other projects stay together and the card closes
  over the hidden one. See [Hidden projects](/concepts/linked-projects/#hidden-projects).
- **A lighter server** (0.10.2, 0.10.3). The branch poll checks the files git keeps its refs in and runs git only
  when one may have moved (and once every 10 minutes), where it used to run two git processes per repo every 2
  seconds; it doesn't run at all while no page is open. What git says about each commit is kept in
  `~/.local-review/cache/`, so the first page after a restart loads in a few dozen git calls instead of hundreds. A
  git call that never finishes times out after 60 seconds instead of hanging every page. See
  [Where your data lives](/reference/data-directory/).
- **Linked projects' cards** on the root page lose their `1 · FIRST`, `2 · BUILDS ON …` labels (0.10.1): the arrows
  already show the order.

## 0.9.0: every thread in one place, comments for GitHub, and drafts that survive a reload

- **A Comments tab on the project and stack pages.** Every comment thread on every PR there, including PRs that aren't
  published yet, in one list: open ones first, then the most recently updated. Each one shows which PR it's on, and
  an inline comment's `file:line` opens Files changed scrolled to it. Resolved and outdated threads start folded, as in
  Files changed, and you can reply and resolve from the list. The tab's counter is the number of open threads, and it
  all updates live. See [The Comments tab](/using/ui-tour/#the-comments-tab).
- **Comments for the GitHub PR.** Tick **For the GitHub PR** on a comment, as you write it or later on any thread
  (Conversation, Files changed or the Comments tab), and it's meant for the real PR rather than your agent: a teal
  **For GitHub** label, left out of the open-thread counts, and posted by your agent as a GitHub review when it
  publishes the stack. The Comments tab's **For GitHub** button lists them, and `local-review plan` gives each PR's,
  with file and line (`publish_threads` in JSON). Local Review still never talks to GitHub: the mark is
  `publish: true` in the review file, and the agent records where each one went. See
  [Comments for the GitHub PR](/using/reviewing-and-comments/#comments-for-the-github-pr).
- **Every text box keeps a draft, like GitHub's.** PR titles and descriptions, the project intro, stack notes, new
  comments, replies, inline comments and comment edits are kept in the browser as you type, so a reload or a closed tab
  doesn't lose them: the editor comes back with "Restored an unsaved draft from 10:42" and **Discard**, an inline one on
  its line. If the saved text changed meanwhile, you choose between theirs and yours. An amber dot marks PRs and stacks
  with drafts waiting. Drafts never leave the browser until you save them, and there's no "Leave site?" prompt any
  more unless one couldn't be kept. See [Drafts](/using/editing-pr-text/#drafts).

## 0.8.0: llms.txt for agents, and a startup banner

- **`/llms.txt`, for coding agents.** Tell your agent "Read http://localhost:5622/llms.txt and create a local-review
  project for my feature-xyz branch on ~/code/my-git-project" and it has what it needs: the rules, the recipe, the
  commented example and this machine's data directory and existing projects. The docs site has a copy, and every
  docs page is also served as Markdown (`/reference/project-yaml.md`). See [llms.txt](/agents/llms-txt/).
- **A banner on start.** `npx local-review` prints LOCAL REVIEW in the header's plum and amber, then the URL, then the
  hint above with the port it's on. Only on a terminal; `NO_COLOR` and `FORCE_COLOR` are honoured, and `--quiet`
  leaves out everything but the URL line. See [`local-review serve`](/reference/cli/#local-review-serve).

## 0.7.0: a resizable sidebar, and folding threads

- **A resizable sidebar.** Drag its right edge (from 200px to half the window, 600px at most); double-click it for
  the default, or Tab to it and use ← / →. The width is remembered, one for every project and page. See
  [the sidebar](/using/ui-tour/#the-sidebar).
- **Folding threads in Files changed.** Every thread there has a chevron to fold it to one row; resolved and outdated
  threads start folded, so they no longer take up the diff. Resolving a thread folds it, unresolving opens it. See
  [Inline comments](/using/reviewing-and-comments/#inline-comments).
- **The stack picture's SVG names generic fallback fonts** (`Inter, sans-serif` and `'JetBrains Mono', monospace`), so
  `stack.svg` opened in a browser without Inter no longer falls back to a serif font. The PNG is unchanged.
- **Fixes from the docs audit.** A PR whose review came over from an earlier commit after a rebase says so on its
  Conversation tab; `local-review move` after a rebase moves the data still in the old sha's file; a `repos:` entry
  without a `path` is a project warning instead of being dropped silently, and `plan` prints project warnings; a ref
  Local Review won't pass to git is reported as such, not as "not found". The full list is in the changelog.

## 0.6.0: the root page and linked projects

- **A root page at `/`.** Every project as a card, most recently active first: a small thumbnail of its stacks (a lane
  per repo, a bar per PR, filled by readiness), its repo / stack / PR counts and +/− lines, a readiness bar, the open
  threads and when it last saw activity. Filter by title, repo or branch (press `/`), and sort by activity, title, size
  or open threads. Archived projects and the example projects have their own sections. The **LOCAL REVIEW** wordmark
  and a new **All projects** item at the top of the project switcher go there. `/` used to open the most recently
  modified project's first commit. See [the root page](/using/ui-tour/#the-root-page).
- **Linked projects.** A project can say it builds on another with `after: <slug>` in its `project.yaml`. In a repo
  both review, its range then starts where the other one's ends, and `local-review plan` bases its first PR on the
  other project's top PR. Linked projects are shown together on the root page, and linked from each other's project
  pages, the sidebar, the breadcrumbs and the project switcher. The stack picture can draw the predecessor's stacks
  too, greyed out. See [Linked projects](/concepts/linked-projects/).
- **`local-review move`** moves PRs' review data (prs and reviews files) from one project to another, for splitting a
  project. It copies, never over an existing file, and renames the originals to `.bak`, after a snapshot. See
  [CLI](/reference/cli/#local-review-move).
- **A new example project**, *Calendar reminders*, builds on *Calendar feed*. If you already have the examples,
  **Add the new example project** (on the root page or in the project switcher, or `local-review examples`) adds just
  that one.

## 0.5.0: stack pages, and instant navigation

- **Stack pages** (`/<project>/<repo>/stacks/<n>-<title>`): one stack, with its header (readiness, repo, branches,
  PRs and +/−), a Conversation tab with the project context and the stack note (editable in place, with images), and a
  Stack tab with the picture of just that stack. Open one from a stack's title in the sidebar, its name in a PR's
  stepper, or the breadcrumbs. See [the stack page](/using/ui-tour/#the-stack-page).
- **The project page** has Conversation (the project intro) and Stack (the whole picture) tabs, like a PR page. The
  list of repos, stacks and PRs beside the picture is gone: the sidebar shows the same.
- **Easier to find your way:** a link to the project page at the top of the sidebar, and breadcrumbs
  (`Project › repo · Stack n › PR #m`) on stack and PR pages.
- **Project context and Stack context** on PR pages are two separate, collapsible boxes, each linking to its page and
  editable in place. See [Project and stack context](/using/editing-pr-text/#project-and-stack-context).
- **Moving between PRs is instant.** PRs you've opened, the ones either side and a sidebar row you rest the pointer on
  are loaded in the background; anything else keeps the PR you were on in view, with a thin amber bar along the top,
  instead of a blank page. The server works out a project's stacks, branches and comments only when something
  changed, so a page that took 150–500 ms takes a few. Branches are polled every 2 seconds (was 3).
- New endpoint: `GET /api/projects/:p/repos/:r/stacks/:ref/stack.svg|png`
  ([HTTP API](/reference/http-api/)).

## 0.4.0: the image viewer

- **Click an image** in a PR description, stack note, the project intro, a comment or an editor's preview to see it
  over the page, fitted to the window. Click again for full size, and scroll or drag around it; ← / → step through the
  other images in the same block, and Esc closes it. See [Images](/using/editing-pr-text/#images).

## 0.3.0: a welcome page, and example projects

- **A first-run welcome page.** With no projects, `/` says what Local Review is, how to create your first project (or
  a prompt to hand that to your coding agent), and links to these docs.
- **One-click example projects.** **Add the example projects** (on the welcome page, in the project switcher, or
  `local-review examples`) creates "Orchard", a made-up app reviewed across four repos, in about a second and with no
  network. **Remove examples** hides them again and deletes nothing. See
  [CLI](/reference/cli/#local-review-examples-remove).

## 0.2.0: the first npm release

:::caution[Breaking: the default port is now 5622, not 5000]
macOS uses port 5000 for AirPlay, so Local Review now serves on `http://localhost:5622`. If you have bookmarks, scripts
or agent prompts that say `localhost:5000`, update them, or keep the old port with `local-review --port 5000` (or
`PORT=5000`).
:::

- **`npx local-review`.** Local Review is now an installable npm package. Run it with `npx local-review`, or install it
  once with `npm i -g local-review`. See [Installation](/getting-started/installation/).
- **Five commands** at the time ([CLI](/reference/cli/) has today's):
  - `local-review [serve] [--port <n>]` serves the UI (the default command);
  - `local-review init <project>` creates a project from a commented example;
  - `local-review plan <project>` prints the read-only [materialization plan](/agents/plan-command/);
  - `local-review asset add|url` adds an image to a project, or records where one is published;
  - `local-review guide` prints the guide for coding agents.
- **No build step at run time.** The package ships compiled JavaScript and a prebuilt UI, so it no longer needs `tsx`,
  and it installs only its runtime dependencies. It needs Node.js 22 or later.
- **The agent guide moved** from `AGENTS.md` to `AGENT-GUIDE.md`, and `local-review guide` prints it, so an agent can
  read it without a checkout. It's also [on this site](/agents/agent-guide/). `AGENTS.md` now holds the conventions
  for contributing to Local Review itself.
- **Images in PR descriptions, stack notes and the project intro.** Paste, drop or attach one in the editor, or add
  it with `local-review asset add`. GitHub can't show a local image, so `plan` warns about each one until you record
  where it's published. See [Images](/using/editing-pr-text/#images).
- **A new logo and favicon**, and this documentation site.
