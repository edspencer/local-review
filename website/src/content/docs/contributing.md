---
title: Contributing
description: How to build, test and change Local Review itself.
---

Local Review is MIT licensed and open to contributions. The repo's
[CONTRIBUTING.md](https://github.com/edspencer/local-review/blob/main/CONTRIBUTING.md) is the full guide; coding
agents working on it read [AGENTS.md](https://github.com/edspencer/local-review/blob/main/AGENTS.md). This page is the
short version.

## Setup

You need Node.js 22 or later (`.nvmrc` says 22) and git, on macOS or Linux.

```sh
git clone https://github.com/edspencer/local-review.git
cd local-review
npm ci
```

```sh
npm run dev           # Vite with hot reload on :5622, proxying /api to the API (tsx watch) on :5623
npm start             # build what's stale, then run the compiled CLI (`npm start -- --port 5050`, …)
npm run lr -- <cmd>   # any `local-review` command, from source (e.g. `npm run lr -- plan my-feature`)
```

**Keep your real reviews out of it.** Point a development instance at a throwaway data directory, e.g.
`LOCAL_REVIEW_HOME=$(mktemp -d) npm start -- --port 5050`. `LOCAL_REVIEW_WEB_PORT` / `LOCAL_REVIEW_API_PORT` move
`npm run dev`'s two ports, so it can run next to a live instance.

If your shell exports `NODE_ENV=production`, `npm ci` skips the dev dependencies (TypeScript, Vite, tsx): unset it.

## Checks

CI runs all of these on Node 22 and 24, on Linux and macOS:

```sh
npm run typecheck     # server + frontend
npm test              # node:test, from source via tsx; builds throwaway git repos in the OS temp dir
npm run build         # dist/web (Vite) + dist/server, dist/shared (tsc)
npm run smoke:pack    # npm pack, install the tarball into a temp prefix, run it as a user would
```

`smoke:pack` matters whenever you touch the build, `package.json` (`files`, `bin`, dependencies) or anything the CLI
reads at run time (`server/config.ts` paths).

## The rules

These are what make Local Review safe to point at your work. A PR that weakens one won't be merged.

- **Reviewed repos are read-only.** All git access goes through `server/git.ts` and its allow-list. See the
  [read-only guarantee](/guarantees/read-only/).
- **User data is never deleted.** Writes go through `server/safefs.ts`, and `test/fsguard.test.ts` enforces it. See
  the [never-delete guarantee](/guarantees/never-delete/).
- **Localhost only.** No `--host` flag, no way around `server/security.ts`. See
  [Localhost security](/guarantees/localhost-security/).
- **It must not look like GitHub.** The layout mirrors GitHub's PR page, but at least one deliberate difference stays
  obvious at a glance: today the plum top bar, its amber underline and the "not on GitHub" pill (see
  [the header](/using/ui-tour/#the-header-deliberately-not-github)).
- **User data never lives in the repo.** If you change where data lives or a file's schema, update
  [Where your data lives](/reference/data-directory/) and the schema pages
  ([project.yaml](/reference/project-yaml/), [PR files](/reference/pr-files/),
  [comment files](/reference/comment-files/)) in the same PR.
- **The default port is one constant**, `DEFAULT_PORT` in `server/port.ts`. The docs site has a copy in
  `website/src/site.mjs`, and a test keeps the two (and every `localhost:<port>` in the docs) in step.

## Pull requests

- Branch off `main` and open the PR against it. Keep it focused; a stack of small PRs beats one big one.
- Say what changed and how you checked it. CI has to be green.
- **UI changes need screenshots:** before and after, plus a nearby view that *shouldn't* have changed.
- **User-facing changes need a changeset:** `npm run changeset`. Releases are cut from them; see
  [RELEASING.md](https://github.com/edspencer/local-review/blob/main/RELEASING.md).

Security issues: please report them privately, as described in
[SECURITY.md](https://github.com/edspencer/local-review/blob/main/SECURITY.md). Everyone taking part follows the
[Code of Conduct](https://github.com/edspencer/local-review/blob/main/CODE_OF_CONDUCT.md).

## Where things are

```text
server/   git.ts (read-only git), config.ts (data home, package paths), port.ts (the default port),
          safefs.ts (atomic writes, no-clobber renames), backups.ts (snapshots + pruning),
          commits.ts (ranges/diffs/patch-id), projects.ts (project.yaml, stack partitioning),
          reviews.ts (YAML store, rebase re-matching), prs.ts (PR title/description/branch/github/landed),
          landed.ts (landed PRs from project.yaml `landed:`), branches.ts (branch discovery + reconciliation),
          plan.ts, cli.ts (the `local-review` CLI: serve, plan, init, guide), anchors.ts (line anchors +
          relocation), context.ts, events.ts (watch + SSE), index.ts (Hono), security.ts (localhost Host/Origin
          guard), stackviz.ts (stack picture: SVG + PNG), fonts/ (bundled OFL fonts for it)
test/     npm test: projects/stacks/PR overrides, review store, anchors, git wrapper and HTTP API tests against
          throwaway git repos, plus the PR editors' text helpers, the stack picture (aggregation, SVG, PNG
          endpoints), snapshots/pruning (backups.test.ts), branch tagging + the plan command (branches.test.ts),
          the CLI's other commands (cli.test.ts), landed PRs (landed.test.ts), the static never-delete guard
          (fsguard.test.ts) and the docs site's sync checks (docs.test.ts)
src/      React UI: App (header, sidebar, SSE, j/k), CommitPage (PR header, Conversation), FilesChanged (tree,
          cards, @pierre/diffs), Comments (threads, Markdown editor), PrEdit (PR title/description editing + copy),
          prText (their pure text helpers), StackTab (the Stack tab, copy/download), ProjectHome (/<project>)
shared/   prText.ts: the full PR body composition, used by both the UI and the plan; totals.ts: aggregate stats
          over stacks (follow-on stacks and merged PRs left out), used by the stack picture and the UI;
          readiness.ts: draft / ready / published / merged
scripts/  start.mjs (npm start: build what's stale, run the compiled CLI), smoke-pack.mjs (npm run smoke:pack)
website/  this docs site (Astro + Starlight), a separate package; see website/CLAUDE.md
dist/     npm run build: web/ (the UI), server/ + shared/ (compiled); what the npm package runs
AGENT-GUIDE.md   the guide for agents driving Local Review from other repos (`local-review guide`)
AGENTS.md        conventions for agents (and people) developing Local Review; CLAUDE.md imports it
examples/        project.example.yaml, the commented starting point `init` copies
```

## Notes

- **`@pierre/diffs` is pinned to an exact version.** The unified view's second line-number column patches one of its
  private methods (see the comment at the top of `src/FilesChanged.tsx`). If that method changes, the patch falls back
  to the stock single column and warns once in the browser console. Check it when upgrading.
- **The packaged files.** The npm package is the compiled CLI (`dist/server`), the built UI (`dist/web`), the stack
  picture's fonts (`server/fonts/`), `examples/project.example.yaml` (for `init`) and `AGENT-GUIDE.md` (for `guide`).
- **The agent guide pages on this site are generated** from `AGENT-GUIDE.md`. Edit that file, then run
  `node scripts/sync-agent-guide.mjs` in `website/` and commit the result; `npm test` fails if you forget.

## License

MIT. The fonts bundled in `server/fonts/` for the stack picture are [Inter](https://github.com/rsms/inter) and
[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), both under the SIL Open Font License 1.1
(`server/fonts/*-OFL.txt`). npm dependencies keep their own licenses.
