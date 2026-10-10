# Local Review: working conventions

These are for agents (and people) developing Local Review itself. Agents *using* Local Review to get work on other
repos reviewed should read [AGENT-GUIDE.md](AGENT-GUIDE.md) instead (`npx local-review guide` prints it).
The human-facing version, with setup, CI and pull request expectations, is [CONTRIBUTING.md](CONTRIBUTING.md).

- **Reviewed repos are read-only.** Local Review reads other repos (for example `~/code/my-service`) and must never
  commit to, rebase, push, check out or otherwise modify them or their branches. All git access goes through
  `server/git.ts` and its read-only allow-list (docs: `website/src/content/docs/guarantees/read-only.md`); keep it
  that way.
- **It must look clearly *not GitHub* at a glance**, through at least one deliberate visual difference (docs: "The
  header: deliberately not GitHub" in `website/src/content/docs/using/ui-tour.md`), even though it otherwise mirrors
  GitHub's PR view.
- **User data never lives in this repo.** Review comments live in plain YAML files that an agent can read and reply
  to by writing into them. They live in `~/.local-review/projects/<slug>/` (or `$LOCAL_REVIEW_HOME`). The layout, the file
  schemas and the never-delete guarantees are documented on the docs site, under `website/src/content/docs/`:
  `reference/data-directory.md` (where data lives, snapshots), `reference/project-yaml.md`, `reference/pr-files.md`,
  `reference/comment-files.md` and `agents/comment-files.md` (the schemas and the agent recipe),
  `concepts/following-rebases.md` (re-matching, line anchoring) and `guarantees/never-delete.md`. Keep those pages
  up to date in the same PR when you change any of it. The README only links to them.
- **The server only binds 127.0.0.1** and rejects non-localhost `Host`/`Origin` headers (`server/security.ts`).
  Don't add a way around that (no `--host` flag).
- **The default port is one constant**, `DEFAULT_PORT` in `server/port.ts`; the CLI help, the startup line and
  `npm run dev` derive from it. The docs site keeps a copy in `website/src/site.mjs`; `test/docs.test.ts` checks the
  two match, and that every `localhost:<port>` in the docs and README is the default (or deliberately another).
- **The docs site** (`website/`, Astro + Starlight, see `website/CLAUDE.md`) holds the reference docs; the README is
  a short landing page that links to them. Its agent-guide pages are generated from `AGENT-GUIDE.md`: after editing
  that file, run `node scripts/sync-agent-guide.mjs` in `website/` and commit the result (`npm test` fails until you
  do).
- Personal, machine-specific rules go in a git-ignored `CLAUDE.local.md` next to this file.

## Commands

```sh
npm install           # from a checkout
npm run dev           # Vite with hot reload + the API (tsx watch), from source
npm start             # build if stale, then run the compiled CLI (`npm start -- --port 5050`, …)
npm run lr -- plan <project>   # the CLI from source (tsx): any `local-review` command
npm test              # node:test, from source via tsx
npm run typecheck     # server + frontend
npm run build         # dist/web (Vite) + dist/server, dist/shared (tsc)
npm run smoke:pack    # npm pack, install the tarball into a temp prefix, run it, check it serves
```

Run `npm test` and `npm run typecheck` before committing, and `npm run smoke:pack` when you change the build,
`package.json` (`files`, `bin`, dependencies) or anything the CLI reads at run time (`server/config.ts` paths).

## Packaging

The npm package is the compiled CLI (`bin: local-review` → `dist/server/cli.js`), the built UI (`dist/web`), the
fonts the stack picture renders with (`server/fonts/`), `examples/project.example.yaml` (for `init`) and
`AGENT-GUIDE.md` (for `guide`). `server/config.ts` finds them from the package root, so they work both from source
and installed. Only what the server needs at run time is a `dependency`; the frontend's libraries (React,
@pierre/diffs, marked, DOMPurify) are bundled into `dist/web` at build time, so they're `devDependencies`.
