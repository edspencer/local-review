---
title: Read-only guarantee
description: Local Review never modifies the repos it shows you.
---

**Reviewed repos are never modified.** Local Review never fetches, checks out, commits, stashes, rebases or resets. It
reads your repos the way `git log` does, so you can point it at a working checkout mid-task, with uncommitted changes,
and nothing about the repo, its index or its branches changes.

## How it's enforced

All git access to the repos you review goes through one module, `server/git.ts`, which:

- runs `git -C <repo> …` via `execFile` with **no shell**, so paths and refs can't inject commands;
- refuses any subcommand outside a **read-only allow-list**: `log`, `show`, `diff`, `diff-tree`, `rev-list`,
  `rev-parse`, `merge-base`, `patch-id`, `cat-file`, `ls-tree`, `for-each-ref`;
- refuses options that write files or run programs (`--output`, `--no-index`, `--ext-diff`, `--textconv`, `--filters`,
  …);
- only uses **object-level** commands: diffs are always commit-to-commit (`git diff <parent> <sha>`), never against the
  work tree or index, and `git status` is never run;
- passes `--no-optional-locks` and sets `GIT_OPTIONAL_LOCKS=0`, so git never takes index locks or refreshes the index;
  drops any inherited `GIT_*` environment (e.g. `GIT_DIR`); and disables textconv, external diff drivers and signature
  checking;
- only passes refs from `project.yaml` (checked: letters, digits and `. _ / @ { } ^ ~ + -` only, no leading `-`, no
  `..`; after `--end-of-options`, or one per line on the stdin of `git cat-file --batch-check`) and full 40-hex shas that git itself returned. A landed PR's shas from
  its prs file are used only after git has resolved them as commits (`<sha>^{commit}`).

One thing reads a reviewed repo without git: to tell whether any branch has moved, the branch poll
(`server/reffiles.ts`) **stats** the files git keeps refs in (`.git/HEAD`, `packed-refs`, everything under `refs/`, and
`reftable/` if the repo uses it) and reads `.git` / `commondir` to find them in a worktree. It never opens anything
for writing, and runs git (through `server/git.ts`) only when those change.

Two other git calls exist, and neither touches a repo you review:

- **Who you are.** To name the reviewer, the server runs `git config --get user.name` once at start (see
  [`LOCAL_REVIEW_USER`](/reference/environment/#local_review_user-the-reviewer)). It only reads.
- **The example projects.** [`local-review examples`](/reference/cli/#local-review-examples-remove) *creates* four new
  repos under `~/.local-review/examples/` (`git init`, `fast-import`, a checkout of the new repo), and nothing else.
  They're Local Review's own data, never anyone's work, and once made they're only read, through `server/git.ts`
  like any other.

## Paths and names

- Shas in URLs must be hex, and are only used after matching them against the repo's own commit list.
- Project and repo names are restricted to `[A-Za-z0-9._-]` with no leading dot, and must exist in the config.
- Review and PR file names are restricted to `<40-hex>.yaml`.

So no request can name a path outside `~/.local-review/projects/`.

## What does change the repo

Only your agent, in its own work: fixups, rebases, branches, pushes. Local Review shows the result, and never does any
of it itself. It never talks to GitHub either.

Contributors: new git calls go through `server/git.ts` too, using only subcommands on the list. A change that weakens
this won't be merged (see [Contributing](/contributing/#the-rules)).
