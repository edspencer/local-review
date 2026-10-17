---
title: Projects & repos
description: A project groups the repos and commit ranges that make up one piece of work.
---

A **project** is one piece of work, like "My feature": a directory under `~/.local-review/projects/<slug>/` with a
`project.yaml` in it. It spans one or more **repos**, and for each one names a **commit range**: from the merge-base
with a `base` up to a `branch` head. Those commits are split into [PR stacks](/concepts/pr-stacks/), and each commit
is reviewed [as a PR](/concepts/commits-as-prs/).

```yaml title="~/.local-review/projects/my-feature/project.yaml"
title: My feature
repos:
  - path: ~/code/my-service
    branch: me/my-feature     # the range ends at this branch's head
    base: origin/main         # and starts (exclusive) at its merge-base with this
  - path: ~/code/my-client    # a second repo, with its own range and stacks
    branch: me/my-feature
```

`local-review init my-feature` creates the file from a commented example. Every field is on
[project.yaml](/reference/project-yaml/).

## Projects

- The directory name is the project's **slug**, used in URLs: `/<slug>` is the [project page](/using/ui-tour/#the-project-page),
  `/<slug>/<repo>/stacks/<ref>` a [stack page](/using/ui-tour/#the-stack-page), and `/<slug>/<repo>/<sha>` one of its PRs.
- The header shows the project's title, with a **project switcher** (its first item, **All projects**, is the root
  page). A project whose PRs have all [landed](/concepts/landed-prs/) is archived automatically, into a collapsed
  **Archived** section at the bottom of the switcher and of the root page.
- An optional `after: <slug>` makes it a [linked project](/concepts/linked-projects/): it builds on that one, and a
  repo they share starts where that project's range ends.
- An optional `description:` is the **project intro**: one or two paragraphs of context that go at the top of every
  full PR body. See [Editing PR titles & descriptions](/using/editing-pr-text/#project-and-stack-context).
- `/` is the [root page](/using/ui-tour/#the-root-page): every project as a card, most recently active first.

## Repos and ranges

Each repo is a local clone, which Local Review only ever reads ([read-only guarantee](/guarantees/read-only/)).

- **The end** is `branch:` (its head) or `to:` (a sha or ref, inclusive).
- **The start** is `merge-base(base, end)`, exclusive, with `base:` defaulting to `origin/HEAD`, else `main`, else
  `master`; or `from:`, the first commit included.
- **The name** (`name:`, default the directory name) is used in URLs and as the directory name for the repo's
  [prs](/reference/pr-files/) and [comment](/reference/comment-files/) files.

Each commit is diffed against its first parent with rename detection (`-M`), so a base that has moved on doesn't
matter: you see each commit's own change. ([Landed PRs](/concepts/landed-prs/#how-landed-prs-behave) are diffed
differently.)

## Live updates

Nothing needs a restart:

- each repo's branches (its range end, its base and every other branch) are polled every 2 seconds, so a new commit, an
  amend, a rebase, the base moving or a new branch shows up on its own. The poll is cheap: it looks at the files git
  keeps refs in (`HEAD`, `packed-refs`, `refs/`, and `reftable/` if the repo uses it) and only runs git when one of them has changed (and every 10 minutes
  regardless, as a safety net), so an idle repo costs no git processes at all. It only runs while a browser has a page
  open; with none, a request checks for itself;
- every file under `~/.local-review/projects/` is watched, and edits push a refresh to the browser. What the server
  works out from them is kept only while the files are unchanged, so the next request always reads an edit.

A missing repo or branch shows as an error in the sidebar (a missing branch isn't one in a repo with landed PRs), and
stack problems as a warning. See [Errors and warnings](/reference/project-yaml/#errors-and-warnings).

## Several repos, one piece of work

A change that touches an API, its client and the infra is one piece of work, reviewed in one place: list each repo in
the project, each with its own branch and stacks. The sidebar has a collapsible section per repo, `j`/`k` walk every
PR across all of them, and the [stack picture](/using/stack-pictures/) can draw the whole project.

![The sidebar sections for three repos (orchard-sdk, orchard-web and orchard-infra), each headed by its branch, each with its own coloured stacks](../../../assets/shots/crop-sidebar-repos.png "One project, several repos: each has its own section in the sidebar, its own branch and its own stacks. (The repos are from the fictional demo project.)")
