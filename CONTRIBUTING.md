# Contributing to Local Review

Thanks for working on Local Review. This is the short guide for people: how to get it running, what CI checks and
the few rules that aren't up for negotiation. Coding agents working on this repo should read [AGENTS.md](AGENTS.md),
the agent-facing version of the same conventions (it's what `CLAUDE.md` loads). If you're looking for how to *use*
Local Review from an agent on some other repo, that's [AGENT-GUIDE.md](AGENT-GUIDE.md).

## Setup

You need Node.js 22 or later (`.nvmrc` says 22) and git, on macOS or Linux.

```sh
git clone https://github.com/edspencer/local-review.git
cd local-review
npm ci
```

Then, depending on what you're doing:

```sh
npm run dev           # Vite with hot reload on :5622, proxying /api to the API (tsx watch) on :5623
npm start             # build what's stale, then run the compiled CLI (`npm start -- --port 5050`, …)
npm run lr -- <cmd>   # any `local-review` command, from source (e.g. `npm run lr -- plan my-feature`)
```

**Keep your real reviews out of it.** Point a development instance at a throwaway data directory, e.g.
`LOCAL_REVIEW_HOME=$(mktemp -d) npm start -- --port 5050`. `LOCAL_REVIEW_WEB_PORT` / `LOCAL_REVIEW_API_PORT` move
`npm run dev`'s ports, so it can run next to a live instance ([Environment variables](https://local-review.edspencer.net/reference/environment/)).

If your shell exports `NODE_ENV=production`, `npm ci` skips the dev dependencies (TypeScript, Vite, tsx): unset it
(`env -u NODE_ENV npm ci`).

**Dependencies:** `package-lock.json` is written by npm 11. If you add or upgrade a dependency on Node 22 (which
ships npm 10), use npm 11 for it, e.g. `npx npm@11 install -D some-package`: npm 10 drops fields npm 11 writes, which
churns the lockfile.

## Checks

CI runs all of these on Node 22 and 24, on Linux and macOS. Run them before you open a PR:

```sh
npm run typecheck     # server + frontend
npm test              # node:test, from source via tsx; builds throwaway git repos in the OS temp dir
npm run build         # dist/web (Vite) + dist/server, dist/shared (tsc)
npm run smoke:pack    # npm pack, install the tarball into a temp prefix, run it as a user would
```

`smoke:pack` matters whenever you touch the build, `package.json` (`files`, `bin`, dependencies) or anything the CLI
reads at run time (see "Packaging" in [AGENTS.md](AGENTS.md)).

## The rules

These are what make Local Review safe to point at your work. A PR that weakens one won't be merged, however useful
the rest of it is.

- **Reviewed repos are read-only.** Local Review never commits to, checks out, rebases, fetches or otherwise
  modifies a repo it reviews. All git access to a reviewed repo goes through `server/git.ts` and its read-only allow-list (the
  ["Read-only guarantee"](https://local-review.edspencer.net/guarantees/read-only/)). New git calls go through it too, using only subcommands
  on the list.
- **User data is never deleted.** Writes under `~/.local-review` are atomic and never clobber; nothing is unlinked
  or truncated except snapshot pruning (the ["Never-delete guarantee"](https://local-review.edspencer.net/guarantees/never-delete/)). `test/fsguard.test.ts` enforces it: it scans `server/**/*.ts` and fails if anything
  outside `server/safefs.ts` and `server/backups.ts` calls `unlink`, `rm`, `writeFile`, `rename` and friends, or
  shells out to `rm`/`mv`. If it fails on your change, route the write through `server/safefs.ts`; don't widen the
  test.
- **Localhost only.** The server binds 127.0.0.1 and rejects non-localhost `Host`/`Origin` headers
  (`server/security.ts`). No `--host` flag, no way around it.
- **It must not look like GitHub.** The layout mirrors GitHub's PR page, but at least one deliberate difference has
  to stay obvious at a glance: today the plum top bar with the amber underline and the "not on GitHub" pill
  (["The header: deliberately not GitHub"](https://local-review.edspencer.net/using/ui-tour/#the-header-deliberately-not-github)).
- **User data never lives in this repo.** If you change where data lives or a file schema, update the docs pages
  that document them in the same PR: they're under `website/src/content/docs/` (see "User data" in
  [AGENTS.md](AGENTS.md)).

## Docs

The reference documentation is the docs site, https://local-review.edspencer.net, built from
[`website/`](website/) (Astro + Starlight; `website/CLAUDE.md` has the details). The README is a short landing page
that links to it, so behaviour changes go in the docs pages. The site's agent-guide pages are generated from
[AGENT-GUIDE.md](AGENT-GUIDE.md): edit that, then run `node scripts/sync-agent-guide.mjs` in `website/` and commit
the result. `npm test` checks that, and that the docs' default port matches `server/port.ts`.

## Pull requests

- Branch off `main` and open the PR against it. Keep it focused; a stack of small PRs beats one big one.
- Say what changed and how you checked it. CI has to be green.
- **UI changes need screenshots:** before and after, plus a nearby view that *shouldn't* have changed, so a reviewer
  can tell a fix from something that just disappeared. A GIF if there's motion or a sequence of states.
- **User-facing changes need a changeset** (below). There's no CI check for it; the PR template asks.

## Changesets

Versions and the changelog come from [changesets](https://github.com/changesets/changesets). If your PR changes
something a user of the npm package would notice (a feature, a fix, a changed default, a new CLI flag, a UI change),
add a changeset in the same PR:

```sh
npm run changeset     # pick patch / minor / major, write the summary for the changelog
git add .changeset && git commit -m "Add changeset"
```

That writes a small markdown file in `.changeset/`; you can also write or edit it by hand. Write the summary for
users, not reviewers: what they'll see, and what they need to do if something breaks (say so first, and how to keep
the old behaviour). Before 1.0, a breaking change is a minor bump. Changes nobody using the package would notice
(tests, CI, refactors, contributor docs) don't need one. `npx changeset status --verbose` shows what the next
release would be.

Big enough to be a highlight? Add a bullet to the docs site's [What's new](website/src/content/docs/whats-new.md)
page too, under its `## Coming in <next version>: <title>` section (start one, with a "Not released yet." line, if
there isn't one). The release gives it its heading ([RELEASING.md](RELEASING.md)).

You don't bump `version` or edit `CHANGELOG.md` yourself: the release workflow does both. How changesets become a
release on npm: [RELEASING.md](RELEASING.md).

## Security

Please don't open a public issue for a vulnerability; see [SECURITY.md](SECURITY.md).
