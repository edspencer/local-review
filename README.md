<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/edspencer/local-review/main/brand/lockup-dark.svg">
    <img alt="Local Review" src="https://raw.githubusercontent.com/edspencer/local-review/main/brand/lockup-light.svg" width="380">
  </picture>
</p>

<p align="center"><strong>Review your PR stacks before you create them.</strong></p>

<p align="center">
  <a href="https://github.com/edspencer/local-review/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/edspencer/local-review/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://www.npmjs.com/package/local-review"><img alt="npm" src="https://img.shields.io/npm/v/local-review?color=4a1942"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://local-review.edspencer.net"><img alt="Docs" src="https://img.shields.io/badge/docs-local--review.edspencer.net-4a1942"></a>
  <img alt="Node.js 22 or later" src="https://img.shields.io/badge/node-%E2%89%A522-339933">
</p>

<p align="center">
  <img alt="Local Review showing a PR: the plum &quot;not on GitHub&quot; header, a sidebar of colour-coded PR stacks with readiness badges, and the PR's title, readiness toggle and Conversation tab" src="https://raw.githubusercontent.com/edspencer/local-review/main/docs/media/readme-hero.png" width="800">
</p>

Local Review is a GitHub-style pull-request UI for the **stack of commits on your machine**, before any of it is
pushed. Every commit is shown as its own PR, grouped into the stacks you mean to open. You review them like PRs, your
coding agent reads your comments and replies in the same place, and when a stack is right, the agent publishes it as
GitHub stacked PRs.

- **Every commit is a PR**, with a Conversation tab, a Files changed tab, a Stack tab and a readiness badge, grouped
  into colour-coded [PR stacks](https://local-review.edspencer.net/concepts/pr-stacks/), across one repo or several.
- **Every effort in view.** The root page shows each project as a card with a thumbnail of its stacks, and work that
  builds on other work is [linked](https://local-review.edspencer.net/concepts/linked-projects/) to it, in order.
- **Your agent answers in the review.** Comments are plain YAML files that any coding agent can read and reply to; the
  replies show up in your browser live, and threads follow their code through amends and rebases.
- **Publish when it's ready.** `local-review plan` prints each PR's branch, base, title and body, and your agent opens
  the stack as [GitHub native stacked PRs](https://local-review.edspencer.net/agents/publishing-stacked-prs/). It
  works in front of any [stacking tool](https://local-review.edspencer.net/concepts/stacking-tools/).
- **Safe to point at your work.** It never modifies your repos, never talks to GitHub, never deletes your review, and
  only listens on localhost.

<p align="center">
  <img alt="A review round trip: the reviewer comments on a range of lines, the agent's reply appears in the thread live, the reviewer resolves the thread and marks the PR ready, and the sidebar's stack tally goes from 1/3 to 2/3 ready" src="https://raw.githubusercontent.com/edspencer/local-review/main/docs/media/demo.gif" width="800">
  <br><sub>One review round trip, on the fictional demo project the docs use.</sub>
</p>

## Quickstart

Needs Node.js 22 or later and git, on macOS or Linux. To look around first, run `npx local-review` and click **Add
the example projects**: a made-up app reviewed across four repos.

```sh
npx local-review init my-feature   # create ~/.local-review/projects/my-feature/project.yaml
npx local-review                   # serve the UI on http://localhost:5622
```

Edit `project.yaml` to point at your repo, branch and stacks:

```yaml
title: My feature
repos:
  - path: ~/code/my-service
    branch: me/my-feature        # the range ends at this branch's head
    base: origin/main            # and starts at its merge-base with this
    stacks:
      - title: Groundwork
      - title: The feature itself
        starts_at: "Add the feature flag"   # the subject of the commit the stack starts at
```

Then open **http://localhost:5622**. Edits are picked up live. The full walk-through is the
[Quickstart](https://local-review.edspencer.net/getting-started/quickstart/).

> **Upgrading from before 0.2.0?** The default port was 5000; it's now 5622 (macOS uses 5000 for AirPlay). Update
> bookmarks and agent prompts, or run `npx local-review --port 5000`.

## For agents

```sh
npx local-review guide
```

prints the guide for coding agents driving Local Review from the repo they work on: the data model, how to answer
review threads, fix a commit mid-stack, tag branches, publish stacked PRs and record merges. It's
[AGENT-GUIDE.md](AGENT-GUIDE.md) in this repo, and [on the docs site](https://local-review.edspencer.net/agents/agent-guide/).
To hand a reviewed project to your agent, paste the
[hand-off prompt](https://local-review.edspencer.net/agents/hand-off-prompt/).

## Documentation

**https://local-review.edspencer.net**

- **Getting started:** [Quickstart](https://local-review.edspencer.net/getting-started/quickstart/) ·
  [Installation](https://local-review.edspencer.net/getting-started/installation/)
- **Concepts:** [Projects & repos](https://local-review.edspencer.net/concepts/projects-and-repos/) ·
  [PR stacks](https://local-review.edspencer.net/concepts/pr-stacks/) ·
  [Readiness](https://local-review.edspencer.net/concepts/readiness/) ·
  [Landed PRs](https://local-review.edspencer.net/concepts/landed-prs/) ·
  [Follow-on stacks](https://local-review.edspencer.net/concepts/follow-on-stacks/) ·
  [Linked projects](https://local-review.edspencer.net/concepts/linked-projects/) ·
  [Following rebases](https://local-review.edspencer.net/concepts/following-rebases/)
- **Using it:** [A tour of the UI](https://local-review.edspencer.net/using/ui-tour/) ·
  [Reviewing & comments](https://local-review.edspencer.net/using/reviewing-and-comments/) ·
  [Stack pictures](https://local-review.edspencer.net/using/stack-pictures/) ·
  [Keyboard shortcuts](https://local-review.edspencer.net/using/keyboard-shortcuts/)
- **Reference:** [CLI](https://local-review.edspencer.net/reference/cli/) ·
  [project.yaml](https://local-review.edspencer.net/reference/project-yaml/) ·
  [Comment files](https://local-review.edspencer.net/reference/comment-files/) ·
  [HTTP API](https://local-review.edspencer.net/reference/http-api/) ·
  [Where your data lives](https://local-review.edspencer.net/reference/data-directory/)
- **[What's new](https://local-review.edspencer.net/whats-new/)**

## Guarantees

- **Read-only:** it never fetches, checks out, commits or rebases; all git access to your repos goes through one
  read-only allow-list. [Read-only guarantee](https://local-review.edspencer.net/guarantees/read-only/)
- **Never deletes:** your review lives in `~/.local-review`, never in your repos; writes are atomic, nothing is
  unlinked, and it's snapshotted hourly. [Never-delete guarantee](https://local-review.edspencer.net/guarantees/never-delete/)
- **Localhost only:** it binds 127.0.0.1 and rejects non-localhost `Host` and `Origin` headers.
  [Localhost security](https://local-review.edspencer.net/guarantees/localhost-security/)

And so you can't mistake it for github.com, its header is deep plum with an amber underline and a "not on GitHub" pill.

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md) for coding agents
working on this repo. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
How AI was used to build it: [AI-DECLARATION.md](AI-DECLARATION.md).
Releases: [RELEASING.md](RELEASING.md).

## License

MIT, see [LICENSE](LICENSE).

The fonts bundled in `server/fonts/` for the stack picture are [Inter](https://github.com/rsms/inter) and
[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), both under the SIL Open Font License 1.1
(`server/fonts/*-OFL.txt`). npm dependencies keep their own licenses.
