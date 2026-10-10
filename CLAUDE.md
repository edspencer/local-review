# Local Review: working conventions

These are for agents (and people) developing Local Review itself. Agents using Local Review to get work on other
repos reviewed should read [AGENTS.md](AGENTS.md) instead.

- **Reviewed repos are read-only.** Local Review reads other repos (for example `~/code/my-service`) and must never
  commit to, rebase, push, check out or otherwise modify them or their branches. All git access goes through
  `server/git.ts` and its read-only allow-list (README "Read-only guarantee"); keep it that way.
- **It must look clearly *not GitHub* at a glance**, through at least one deliberate visual difference (README "The
  deliberate 'not GitHub' difference"), even though it otherwise mirrors GitHub's PR view.
- **User data never lives in this repo.** Review comments live in plain YAML files that an agent can read and reply
  to by writing into them. They live in `~/.local-review/projects/<slug>/` (or `$LOCAL_REVIEW_HOME`): see "Where your
  data lives" and "Comment files" in the README for the layout, schema and never-delete guarantees. Keep those
  sections up to date when you change any of it.
- Run `npm test` and `npm run typecheck` before committing.
- Personal, machine-specific rules go in a git-ignored `CLAUDE.local.md` next to this file.
