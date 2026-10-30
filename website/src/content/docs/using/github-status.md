---
title: GitHub status
description: Approvals, checks and review threads from GitHub, beside each published PR, from a read-only sync you turn on.
---

Once a PR is published (its [prs file](/reference/pr-files/) records `github: {url}`), Local Review can show what GitHub
says about it: whether it's approved, whether its checks pass, and which of the reviewers' comments are waiting for
you. It's off until you turn it on, because it's the one thing in Local Review that talks to the network, and then it
only reads.

## What it shows

**The PR link** (`#9466 ↗` in the sidebar) changes colour:

| Colour | When |
| --- | --- |
| green | someone approved it, and nothing below applies. Approvals count whichever push they were on: force-pushing a rebase doesn't undo them, as it doesn't on GitHub unless the repo dismisses stale approvals. |
| red | its checks are failing, or a reviewer asked for changes (red wins over green) |
| as before | no approval yet, or the PR is merged or closed |

Its tooltip says all of it in words: who approved, the checks, and the threads. It still opens the PR on GitHub.

**The speech bubble** beside it counts the PR's review threads (the comments on lines of the diff). Each is in one of
three states:

- **Resolved**: someone pressed Resolve on GitHub.
- **Answered**: not resolved, and the last comment is yours. You replied (saying what you did, or why not), and it's
  the reviewer's turn: by convention they resolve their own threads.
- **Open**: not resolved, and the last comment is someone else's. It's your turn.

An outdated thread (its lines have changed since) keeps its state, as on GitHub. "Yours" means the account `gh` is
logged in as (or [`github.me`](/reference/config-yaml/)). A thread someone else answered on your behalf still counts as
open: that's rare, and it's never wrong to look.

The bubble is amber with the number of open threads when there are any, and grey with the total when every thread is
answered or resolved; a PR with no threads has none. It opens the first open thread on GitHub (else the first answered
one).

**The stack's tally** (`6/6 READY` on its bottom border) adds `· 4/6 APPROVED` and, if any threads are open,
`· 4 TO ANSWER`, counting the stack's open PRs on GitHub.

**The PR page** gets an **On GitHub** card in its Conversation, after the description: who approved, the checks, the
threads that need you (each with its file and line, who started it and the last comment, linking to it on GitHub),
and, folded, the answered and resolved threads, the reviews' summaries and the PR's own comments.

**The sidebar** says how fresh it all is, above the repos: **GitHub synced 2m ago · Refresh**. Its tooltip lists each
GitHub repo's last fetch, and an error (gh not logged in, say) shows beside it in red; what was fetched before stays
shown meanwhile.

## Turning it on

You need the [GitHub CLI](https://cli.github.com), logged in (`gh auth login`). Then add this to
`~/.local-review/config.yaml` (create it; [all the settings](/reference/config-yaml/)):

```yaml
github:
  sync: on
```

No restart needed. To leave one project out (something confidential, say), put this in its `project.yaml`:

```yaml
github: {sync: off}
```

## How fresh it is

What GitHub said is a cache, kept in `~/.local-review/github/`, and `max_age` (5 minutes unless you set it) is how
old it may get while you're looking:

- **While a Local Review page is open** (in any tab, in the background or not), the server fetches whatever has got
  older than `max_age`. With no page open it doesn't fetch at all.
- **Coming back to the page** (switching to its tab or window) fetches what's more than a minute old.
- **Refresh**, in the sidebar or on the card, always fetches, and so does
  [`local-review github refresh`](/reference/cli/#local-review-github), which works with no server running (a running
  server picks up what it fetched).

Any fetch counts, whoever made it: if you press Refresh a minute before the next fetch was due, that one waits another
`max_age`. A PR recorded since the last fetch is fetched on the next check (within about 15 seconds), and merged and
closed PRs are fetched once more and then left alone. When a fetch fails, the server tries again after 1 minute, then
2, 4 and so on, up to `max_age`; Refresh doesn't wait.

## What it asks GitHub

One GraphQL query per GitHub repo per fetch, however many projects record that repo's PRs, for those PRs by number:
their state, approvals, checks, review threads, reviews and comments, with the comments' text (up to 50 comments per
thread and 100 threads per PR, and the PR's last 100 comments). A fetch of a 10-PR stack takes a couple of seconds and
a few points of GitHub's 5,000-an-hour allowance.

It runs `gh api graphql` with the query on its stdin. `gh` holds your token; Local Review never sees it. The query is
fixed text with only PR numbers in it, and Local Review refuses to send anything but a query: never a mutation, so it
can't comment, approve, resolve or change anything on GitHub, whatever your token would allow. See the
[read-only guarantee](/guarantees/read-only/#github).

## For agents

The cache is plain JSON, one file per PR: `~/.local-review/github/<owner>/<repo>/<number>.json`, with each thread's
`state` (`resolved`, `answered` or `open`), its file and line, and its comments' text. An agent can read it to find
the threads waiting for an answer, after a `local-review github refresh` (or `local-review github status <project>`
for a summary). The layout is in [Where your data lives](/reference/data-directory/#github).
