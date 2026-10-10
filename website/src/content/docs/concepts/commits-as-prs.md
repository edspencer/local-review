---
title: Commits as PRs
description: Every commit in a range is reviewed as if it were its own pull request.
---

In Local Review, **one commit is one PR**. Each commit in a project's range is shown as a candidate pull request, with
a Conversation tab, a Files changed tab and a Stack tab, just like a GitHub PR. That is the shape it will have when it
goes up as a GitHub stacked PR: one PR per commit, each on the branch of the one below.

<!-- SHOT: pr-header — a PR page header: title with #3, the Draft | Ready toggle, `6 of 15 done`, "commit 3 of 10 in my-service" and the stack stepper; crop to the header -->

## What a PR is made of

| | Comes from | Override |
| --- | --- | --- |
| Title | the commit subject | `title:` in its [prs file](/reference/pr-files/), or **Edit** in the UI |
| Description | the commit body | `body:` in its prs file, or the description editor |
| Diff | the commit against its first parent, with rename detection | — |
| Number | its position in the repo, 1..n across all stacks, oldest first ("PR 3", `#3`) | — |
| Readiness | draft until you mark it ready | see [Readiness](/concepts/readiness/) |
| Branch | none until an agent tags one | see [Branches](/concepts/branches/) |

Overrides never touch the commit: they live in Local Review's files, so the reviewed repo stays exactly as it was.

## Why one commit per PR

- **It's how stacks are built.** Every stacking tool, GitHub's own included, works from a series of local commits;
  they differ only in how they map commits to PRs. Reviewing commits means reviewing exactly what will go up. See
  [Works with your stacking tool](/concepts/stacking-tools/).
- **Small PRs get real review.** An agent can write a dozen tidy commits in an afternoon. Reviewed as one branch they
  blur together; reviewed one at a time, each gets its own diff and conversation.
- **Fixes land where they belong.** A comment on PR 3 is fixed in PR 3, with `git commit --fixup` and an autosquash
  rebase, and the thread follows the rewritten commit ([Following rebases](/concepts/following-rebases/)).

## Shaping the commits

Each commit should be reviewable on its own, with a clear and unique subject. Split, squash and reorder with
`git rebase -i` until it is; then group the commits into [stacks](/concepts/pr-stacks/). The agent guide's
[Building the local representation](/agents/agent-guide/#building-the-local-representation-before-anything-goes-to-github)
covers this for agents.

## Numbers

PR numbers are positions across the whole repo, not per stack, and they include [landed PRs](/concepts/landed-prs/)
first, so they don't change when you regroup stacks or when PRs merge. They aren't GitHub PR numbers: once a PR is
published, its GitHub number shows beside it as a `#1234 ↗` badge.
