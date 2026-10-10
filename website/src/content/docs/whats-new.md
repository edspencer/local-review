---
title: What's new
description: Release notes for Local Review.
---

The highlights of each release. The full list is in
[CHANGELOG.md](https://github.com/edspencer/local-review/blob/main/CHANGELOG.md), and each version's notes are on
[GitHub Releases](https://github.com/edspencer/local-review/releases).

## 0.2.0: the first npm release

:::caution[Breaking: the default port is now 5622, not 5000]
macOS uses port 5000 for AirPlay, so Local Review now serves on `http://localhost:5622`. If you have bookmarks, scripts
or agent prompts that say `localhost:5000`, update them, or keep the old port with `local-review --port 5000` (or
`PORT=5000`).
:::

- **`npx local-review`.** Local Review is now an installable npm package. Run it with `npx local-review`, or install it
  once with `npm i -g local-review`. See [Installation](/getting-started/installation/).
- **Four commands** ([CLI](/reference/cli/)):
  - `local-review [serve] [--port <n>]` serves the UI (the default command);
  - `local-review init <project>` creates a project from a commented example;
  - `local-review plan <project>` prints the read-only [materialization plan](/agents/plan-command/);
  - `local-review guide` prints the guide for coding agents.
- **No build step at run time.** The package ships compiled JavaScript and a prebuilt UI, so it no longer needs `tsx`,
  and it installs only its runtime dependencies. It needs Node.js 22 or later.
- **The agent guide moved** from `AGENTS.md` to `AGENT-GUIDE.md`, and `local-review guide` prints it, so an agent can
  read it without a checkout. It's also [on this site](/agents/agent-guide/). `AGENTS.md` now holds the conventions
  for contributing to Local Review itself.
- **A new logo and favicon**, and this documentation site.
