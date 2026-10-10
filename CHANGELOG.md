# local-review

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
