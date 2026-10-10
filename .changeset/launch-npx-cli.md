---
"local-review": minor
---

**Breaking: the default port is now 5622, not 5000.** macOS uses port 5000 for AirPlay, so Local Review now serves on
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
