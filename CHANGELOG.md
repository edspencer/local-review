# local-review

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
