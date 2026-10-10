---
title: Branches
description: How each PR's branch is recorded, discovered and checked, without Local Review creating any.
---

GitHub needs one head branch per PR, so before a stack goes up, each commit gets a plain git branch pointing at it.
Local Review has **no branch naming scheme** and never creates a branch: the agent that writes the code picks the names
and creates them (`git branch <name> <sha>`), and records each in the PR's prs file as `branch:`. Local Review shows
each PR's branch in the sidebar and checks that it still points where it should.

```sh
git config rebase.updateRefs true            # once per repo: every rebase moves these branches
git branch me/feature-flag 0a1b2c3d          # one per commit, bottom to top
```

How an agent tags a stack: [Branch tagging](/agents/agent-guide/#branch-tagging) in the agent guide.

## How a PR's branch is worked out

The server lists the repo's local and remote-tracking branches with one read-only `git for-each-ref` per range, and
reconciles each commit (`branch` in the API). The **display name** is, in order:

1. the recorded `github.branch` (the head branch of the GitHub PR);
2. else the recorded `branch:`;
3. else a discovered local branch pointing at the commit (one other than the range's own tip branch first);
4. else a discovered remote branch;
5. else none (`null`).

## Status

| Status | Meaning | Fix |
| --- | --- | --- |
| `ok` | The recorded branch points at this commit. | Nothing to do. |
| `moved` | It points elsewhere (`points_at`), e.g. after a rebase without `--update-refs`. | `git branch -f <name> <sha>` |
| `missing` | It's recorded but not in git. | `git branch <name> <sha>`, or record the right name. |
| `discovered` | Nothing is recorded; a branch in git points here. | Record it, if it's the one. |
| `merged` | A [landed PR](/concepts/landed-prs/)'s recorded branch, whatever git says. Never a warning (it may well be deleted). | Nothing to do. |

`discovered` lists every branch pointing at the commit: local first, the tip branch (e.g. `me/my-feature` on the top
commit) last.

## In the sidebar

Each PR row shows its branch name, middle-truncated (or the short sha if there's none), with a warning icon if the
recorded branch moved, and struck through if it's missing. Once the GitHub PR exists, a `#1234 ↗` badge links to it.

`local-review plan` warns about PRs without a branch, and about `missing` and `moved` branches, before anything is
published.
