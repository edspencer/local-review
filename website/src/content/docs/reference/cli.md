---
title: CLI
description: Every local-review command and flag.
---

One command, `local-review`, does everything: with no arguments it serves the UI, and its subcommands create
projects, add images, print a project's publishing plan, move review data between projects, add or hide the example
projects, run it as a service, update and check it, and print the agent guide. Run it with `npx local-review …`, or install it once with
`npm i -g local-review` and run `local-review …`.

```sh
npx local-review                          # serve the UI on http://localhost:5622
npx local-review --port 5050              # …on another port
npx local-review init my-feature          # create ~/.local-review/projects/my-feature/project.yaml
npx local-review asset add my-feature diagram.png   # prints ![diagram](assets/<hash>.png)
npx local-review plan my-feature --stack 1 --format json
npx local-review move my-feature my-follow-up my-service --stack 3   # after splitting a project
npx local-review examples                 # add the example projects (remove: `examples remove`)
npx local-review guide                    # print the guide for agents
local-review service install              # after `npm i -g local-review`: run it at every login
local-review update                       # update it, and restart the service onto the new version
local-review doctor                       # check the install
```

## `local-review --help`

```text
Usage: local-review [--data-dir <path>] [serve] [--port <n>] [--quiet]
       local-review plan <project> [--repo <name>] [--stack <n>] [--include-follow-on] [--format md|json|yaml]
       local-review init <project>
       local-review asset add <project> <file> [--alt <text>]
       local-review asset url <project> <name> <url>
       local-review move <from> <to> <repo> (<sha>… | --stack <n>) [--to-repo <name>] [--dry-run]
       local-review examples [remove]
       local-review github refresh [<project>] | status [<project>]
       local-review service install [--port <n>] [--dry-run] [--from-checkout] [--refresh]
       local-review service uninstall | start | status [--json]
       local-review service stop | restart [--force]
       local-review service logs [-f] [-n <lines>]
       local-review busy [--json]
       local-review update [--check] [--to <version|tag>] [--yes] [--force] [--json]
       local-review doctor [--json] [--offline]
       local-review guide
       local-review --version | --help

  serve   (the default) Serve the review UI and API on http://localhost:<port> (127.0.0.1 only).
          --port <n>       the port (default 5622, or $PORT)
          It prints `Local Review <version>: <url>` first, then the projects directory and a hint for agents.
          --quiet, -q      print just that first line: no banner, no hint for agents
                           (the banner is only shown on a terminal anyway, on stderr)
  plan    For each PR in scope, in order: commit, status (draft / ready / published), branch (with its
          status), base, title and the exact full body (project intro, stack note, ---, PR description), plus
          any recorded github: info and the comments the reviewer marked for the GitHub PR (with file and
          line). Warns about stacks with draft PRs, GitHub bases that differ from the plan's, published PRs
          that landed upstream without being frozen, and comments for GitHub not posted yet. Landed
          (merged) PRs are never planned. Read-only.
          --repo <name>    one repo of the project
          --stack <n>      one declared stack (1-based, as in project.yaml); needs --repo if several repos have it.
                           Naming a follow-on stack plans it (with a note).
          --include-follow-on
                           also plan follow-on stacks (follow_on: true, parked work); left out by default
          --format <f>     md (default), json or yaml
  init    Create a project to review: <projects>/<project>/project.yaml, a commented example to edit.
          Never replaces an existing one.
  asset add
          Copy an image (PNG, JPEG, GIF, WebP or SVG, up to 5 MB) into the project's assets folder, named by its
          content, and print the markdown that shows it, e.g. ![alt](assets/3f2a9c1e0b7d4a65.png), for a PR
          description, stack note or project intro. Adding the same image again is a no-op.
          --alt <text>     the alt text (default: the file name)
  asset url
          Record where an asset is published (a URL GitHub's readers can reach), so `plan` puts that URL in
          the bodies instead of the local assets/<name> reference.
  move    Move PRs' review data (prs/ and reviews/ files: titles, descriptions, readiness, branches, comments,
          Viewed marks) from project <from> to project <to>, e.g. after splitting a project into linked projects.
          Each file is copied into <to> (never over an existing one: then nothing is moved) and the original is
          renamed to <sha>.moved-to-<to>.yaml.bak; images the descriptions show are copied too. A snapshot is
          taken first. project.yaml files aren't edited: what's left to change there is printed.
          <sha>…           commit shas or unique prefixes (7+ hex), in <from>'s range or with a file there
          --stack <n>      instead: every commit of declared stack <n> of <repo> in <from>
          --to-repo <name> the repo's name in <to>, if it differs
          --dry-run        print what it would do; write nothing
  examples
          Add the example projects: "Orchard", a made-up app in four repos, to click around before reviewing your
          own work. Makes the repos in <data>/examples/ and the projects as projects/example-*. Running it again
          restores removed ones and leaves existing ones alone.
  examples remove
          Hide the example projects again. Nothing is deleted: each one's project.yaml is renamed to a .bak.
  github refresh
          Fetch what GitHub says about the published PRs (those with a github: url in their prs file) of
          <project>, or of every project that hasn't opted out (github: {sync: off}): approvals, checks, review
          threads (resolved, answered or open) and comments. Asks now, whatever their age: one query per GitHub
          repo, through the gh CLI. Writes only its cache, <data>/github/; a running server picks it up.
  github status
          The GitHub sync's settings (<data>/config.yaml) and, from the cache, each repo's last fetch; with
          <project>, each of its PRs: approvals, checks and threads. No network.
  service install
          Run Local Review in the background, started at login and restarted if it exits: a LaunchAgent on
          macOS, a systemd user unit on Linux. The service runs this installed local-review with this shell's
          Node, and a PATH that must find git, still on 127.0.0.1 only. Running it again rewrites it, keeping
          the port, LOCAL_REVIEW_HOME and LOCAL_REVIEW_USER it was installed with unless you give new ones.
          Refuses to run from npx's cache (`npm i -g local-review` first) or a source checkout.
          --port <n>       the port (default 5622; $PORT isn't used here)
          --dry-run        print the service file it would write; write nothing, start nothing
          --from-checkout  run a source checkout's build (dist/) as the service, on purpose
          --refresh        rewrite the installed service for this version, from what it was installed with (its
                           port, data home and environment, not this shell's), and restart it. Exits 4 if
                           nothing is installed. `update` runs it.
  service uninstall
          Stop the service and remove its file. Your data (and its logs/) stays where it is.
  service start
          Start the installed service, and wait until it answers.
  service stop
          Stop it until `service start` or your next login. It stays installed: `service uninstall` removes it.
          Refuses (exit 75) while it's busy saving, snapshotting or syncing with GitHub (see `busy`).
          --force          stop it anyway
  service restart
          Restart it, e.g. after `npm i -g local-review@latest`. A service file an older version wrote, or one
          whose Node or local-review has gone, is rewritten first, keeping its port and environment. Refuses
          (exit 75) while it's busy, as `stop` does.
          --force          restart it anyway
  service status
          Whether it's installed, loaded, running and answering, on which port, which version, and what it runs.
          Exits 0 if it's running and answering, 3 if it's installed but not, 4 if it isn't installed.
          --json           as JSON
  service logs
          The end of the service's log, <data>/logs/service.log.
          -f, --follow     then keep printing what it writes, until interrupted
          -n, --lines <n>  how many lines (default 50)
  busy    Ask the running Local Review whether it's busy: saving a comment or a description, taking a backup
          snapshot, or syncing with GitHub. Exits 0 if it isn't, 75 if it is, 3 if nothing is running. It finds
          the instance through <data>/runtime.json, which `serve` writes.
          --json           as JSON: { running, busy, url, version, counts }
  update  Update this local-review to the latest version on npm, and restart the service onto it. It asks first
          (`--yes` answers; without a terminal, --yes is needed), refuses while Local Review is busy, and if the
          new version doesn't come up it puts the old one back. A copy it can't update itself (npx, a source
          checkout, a project's dependency) prints the command to run instead, and exits 5.
          --check          only say whether there's a newer version; change nothing
          --to <v>         a version or a dist-tag (next); the only way to go to a lower version
          --yes            don't ask
          --force          update even while it's busy (the health check and the rollback still run)
          --json           one JSON document on stdout
  doctor  Check this install: Node against what Local Review needs, how it was installed, the service (whether
          what it runs is still there), that the running version is the installed one, the port, linger (Linux),
          the data home, git and gh, and whether there's a newer version. A fix is printed under each problem.
          Exits 1 if a check failed (warnings don't count).
          --offline        don't ask the npm registry for a newer version
          --json           as JSON: { ok, version, checks: [{ id, status, message, fix }] }
  guide   Print the guide for agents using Local Review to get their work reviewed (AGENT-GUIDE.md).

  --data-dir <path>
          The data home for this command, as LOCAL_REVIEW_HOME sets it (default ~/.local-review).

Data: $LOCAL_REVIEW_HOME/projects (default ~/.local-review/projects). Agents: run `local-review guide`.
Exit codes: 0 done, 1 failed, 2 bad usage, 3 not running, 4 not installed (`service`), 5 can't update itself,
6 the update failed and the old version is running again, 7 the update failed and couldn't be undone, 75 busy
(`busy`, `update`, `service stop` and `restart`: try again later, or use --force).
```

## `local-review [serve]`

Serves the review UI and its [HTTP API](/reference/http-api/) on `http://localhost:5622`, bound to 127.0.0.1 only
(see [Localhost security](/guarantees/localhost-security/)). `serve` is the default, so `local-review` on its own
does the same. On start, its first line is `Local Review <version>: <url>`, then the projects directory it reads,
then how to get a coding agent to set up a project (from [its llms.txt](/agents/llms-txt/)). In a terminal, a LOCAL
REVIEW banner comes first:

```text
 ██     ▄████▄ ▄█████ ▄████▄ ██         █████▄ ██████ ██  ██ ██ ██████ ██    ██
 ██     ██  ██ ██     ██  ██ ██         ██  ██ ██     ██  ██ ██ ██     ██    ██
 ██     ██  ██ ██     ██  ██ ██         ██▄▄██ ██▄▄▄  ██  ██ ██ ██▄▄▄  ██    ██
 ██     ██  ██ ██     ██████ ██         ██▀██  ██▀▀▀  ██  ██ ██ ██▀▀▀  ██ ██ ██
 ██     ██  ██ ██     ██  ██ ██         ██  ██ ██      ████  ██ ██     ██ ██ ██
 ██████ ▀████▀ ▀█████ ██  ██ ██████     ██  ██ ██████   ██   ██ ██████ ▀██▀▀██▀

Local Review 0.15.0: http://localhost:5622
Projects: /home/you/.local-review/projects

Point Claude Code/Codex/pi/whatever at http://localhost:5622/llms.txt then ask it to generate a project definition for you. Example:

  Read http://localhost:5622/llms.txt and create a local-review project for my feature-xyz branch on ~/code/my-git-project
```

The URLs are the ones it's actually on, so `--port` or `PORT` changes them. The banner is in the header's plum and
amber, in full colour where the terminal has it, else the nearest of 256 or 16 colours, else none (`NO_COLOR`; see
[Environment variables](/reference/environment/#colour-no_color-and-force_color)). It goes to stderr, and it's left
out when stderr isn't a terminal (written to a log file, in CI) unless `FORCE_COLOR` is set. A terminal narrower than
80 columns gets a one-line title instead.

**For scripts:** the first line on stdout is always `Local Review <version>: <url>`, as the
[CLI contract](https://github.com/edspencer/cli-contract) has it, so a script can wait for it and read the URL from
it. The server's own log lines go to stderr. Before 0.15.0 the line was
`Local Review on <url>  (projects: <dir>)`, after the banner.

While it runs, `serve` writes `<data>/runtime.json` (its pid, port, URL and version) so
[`local-review busy`](#local-review-busy) can find it, and removes it when it exits. On `SIGTERM` or `SIGINT` it lets
saves and GitHub syncs under way finish first, for up to 5 seconds.

| Option | |
| --- | --- |
| `--port <n>` | The port, 0–65535 (`0` picks any free port). Wins over `PORT`. Also written `--port=<n>`. |
| `--quiet`, `-q` | Print only the first line, `Local Review <version>: <url>`: no banner, no hint for agents. |

If the port is taken, it says so and exits (`port 5622 is already in use; pick another with --port <n>`). It never
falls back to another port by itself: pick one with `--port <n>` or `PORT=<n>`.

:::caution[The default port was 5000 before 0.2.0]
macOS uses 5000 for AirPlay, so 0.2.0 moved the default to 5622. If you have bookmarks, scripts or agent prompts
with `localhost:5000`, update them, or keep the old port with `--port 5000` (or `PORT=5000`).
:::

## `local-review init <project>`

Creates `~/.local-review/projects/<project>/project.yaml` (under `$LOCAL_REVIEW_HOME` if that's set) from a commented
example, with `title:` set to the project name, and says what to do next:

```text
$ npx local-review init my-feature
Created /home/you/.local-review/projects/my-feature/project.yaml

Next: edit it (each repo's path and branch), then run `local-review` and open http://localhost:5622/my-feature
Edits to project.yaml are picked up live.
```

- The name is the project's **slug**, used in URLs and as its directory name: letters, digits, `.`, `_` and `-`,
  not starting with `.`.
- It **never replaces** an existing `project.yaml`: the write is a no-clobber rename, so if the file exists it stops
  with `… already exists; not replacing it`.
- The example it copies is
  [`examples/project.example.yaml`](https://github.com/edspencer/local-review/blob/main/examples/project.example.yaml).
  What to put in it: [project.yaml](/reference/project-yaml/).

## `local-review plan <project>`

Prints the read-only **materialization plan**: for each PR in scope, in order, what it should be on GitHub. It never
writes a file, pushes, or calls GitHub. What it prints and warns about: [The plan command](/agents/plan-command/).

| Option | |
| --- | --- |
| `--repo <name>` | Only this repo of the project (its `name` in `project.yaml`). |
| `--stack <n>` | Only stack `n`, 1-based as declared in the repo's `stacks:`. Needs `--repo` if several repos have a stack `n`. Naming a follow-on stack plans it, with a note. |
| `--include-follow-on` | Also plan [follow-on stacks](/concepts/follow-on-stacks/), which are left out by default. |
| `--format <f>` | `md` (the default), `json` or `yaml`. JSON is for scripts, e.g. `jq -r '.prs[0].body'`. |

## `local-review asset add <project> <file>`

Copies an image into the project's `assets/` folder and prints the markdown that shows it, ready to paste into a PR
description (its prs file's `body:`), a stack note or the project intro:

```text
$ npx local-review asset add my-feature "Architecture diagram.png"
Added /home/you/.local-review/projects/my-feature/assets/3f2a9c1e0b7d4a65.png
![Architecture diagram](assets/3f2a9c1e0b7d4a65.png)
```

The snippet is the only thing on stdout (the `Added …` line is on stderr), so
`snippet=$(npx local-review asset add my-feature shot.png)` works.

| Option | |
| --- | --- |
| `--alt <text>` | The alt text. The default is the file name without its extension. |

- PNG, JPEG, GIF, WebP and SVG, up to 5 MB. The file's extension says what it is, and its contents must agree
  (`… says it's PNG but its contents are JPG` otherwise).
- The file is named by its content, so adding the same image again prints the same snippet and adds nothing
  (`Already there: …`). It never replaces or removes a file. More: [Images](/reference/data-directory/#images).

## `local-review asset url <project> <name> <url>`

Records where an image is published, a URL the PR's readers can reach, in `assets/<name>.yaml` (`url: …`). From then
on `local-review plan` writes that URL into the PR bodies in place of `assets/<name>`. `<name>` can also be written as
it appears in markdown (`assets/<name>`). Running it again changes the URL; other fields in the file are kept. Why
this exists: [Publishing: images](/agents/publishing-stacked-prs/#images).

## `local-review examples [remove]`

Adds the **example projects**: "Orchard", a made-up booking app in four repos (Go, TypeScript, React, Terraform),
with four projects to click around: stacked PRs across all four repos, review threads with an agent's replies, two
[linked projects](/concepts/linked-projects/) (*Calendar reminders* builds on *Calendar feed*), and an archived project
whose PRs have all merged. It's the same as **Add the example projects** on the first-run page, or
at the bottom of the project switcher once you have projects of your own (where **Remove example projects** takes
its place while they're there).

`local-review examples add` does the same.

```text
$ npx local-review examples
Created example-waitlists, example-calendar-feed, example-calendar-reminders, example-webhook-retries

The example projects are in /home/you/.local-review/projects (4). `local-review examples remove` hides them again.
```

- It writes four small git repos into `~/.local-review/examples/orchard-<id>/` and the projects as
  `projects/example-*/`, in about a second and with no network. The history is built in memory and written with
  `git fast-import`, so it's the same everywhere. These repos are Local Review's own data, created fresh; nobody's
  work is touched, and once made they're only ever read.
- The git work runs in the background, so a running server keeps serving while the examples are made. Asking for them
  again meanwhile waits for the same run; removing them meanwhile is refused until it's done.
- Every file is created, never replaced: running it again leaves existing example projects alone, and **restores**
  removed ones exactly as they were (comments you wrote on them included).
- An update that ships a **new** example project adds just that one: the root page's Examples heading and the
  project switcher offer **Add the new example project**, and running this again does the same. (Its repos are made
  next to the old ones, since the example history changed; the projects you have keep theirs.)
- If a project of yours already has one of the names (`example-waitlists`, …) and isn't an example, it stops
  without writing anything.

`local-review examples remove` hides them again, **deleting nothing**: each example's `project.yaml` is renamed to
`project.example-removed.yaml.bak`, so the project drops out of the list and every other file stays. Only projects
whose `project.yaml` says `example: true` are touched. To reclaim the disk space (a few MB), delete
`~/.local-review/examples/` and the `projects/example-*` directories yourself.

## `local-review github`

Fetches and shows what GitHub says about published PRs: [GitHub status](/using/github-status/).

```text
$ local-review github refresh larch-runtime-preflight-auth
xbow-engineering/xbow-larch: 10 PRs fetched

$ local-review github status larch-runtime-preflight-auth
GitHub sync: on (source gh, max_age 300s) · /home/you/.local-review/config.yaml
Cache: /home/you/.local-review/github

larch-runtime-preflight-auth
  xbow-engineering/xbow-larch: 10 PRs, fetched 4s ago

  GitHub PR #9466
  Approved by prathap-xbow
  Checks passing
  2 threads: 1 open, 1 answered, 0 resolved · 5 comments on the PR
  https://github.com/xbow-engineering/xbow-larch/pull/9466
…
```

- **`refresh [<project>]`** fetches now, whatever the cache's age: the PRs of `<project>`, or of every project that
  hasn't opted out (`github: {sync: off}`), merged and closed ones included. One query per GitHub repo, through the
  [GitHub CLI](https://cli.github.com) (`gh auth login` first). It works whether or not
  [the sync](/reference/config-yaml/) is on, and with no server running: it writes only the cache,
  `~/.local-review/github/`, and a running server shows what it fetched within a few seconds. It runs the same code
  as the server's own fetches and the UI's Refresh button. Exit code 1 if a repo's fetch failed (the error is
  printed, and recorded for the UI).
- **`status [<project>]`** prints the settings from `config.yaml` and, from the cache, each project's GitHub repos
  with their last fetch; with `<project>`, each of its PRs too: approvals, checks and threads. No network.

## `local-review move`

```text
local-review move <from> <to> <repo> (<sha>… | --stack <n>) [--to-repo <name>] [--dry-run]
```

Moves PRs' review data (their [prs](/reference/pr-files/) and [comment](/reference/comment-files/) files: titles,
descriptions, readiness, branches, GitHub records, threads, Viewed marks) from project `<from>` to project `<to>`, for
when a project is split into [linked projects](/concepts/linked-projects/#splitting-a-project) and some of its commits
now belong to the other one.

```text
$ npx local-review move waitlists waitlist-controls orchard-api --stack 4
Moved from waitlists to waitlist-controls:
  (snapshot first: backups/2026-10-11T09-12-03Z)
  5c1e9a07 prs: waitlists/prs/orchard-api/5c1e9a07….yaml → waitlist-controls/prs/orchard-api/5c1e9a07….yaml; the original renamed to 5c1e9a07….moved-to-waitlist-controls.yaml.bak
  …
Then: check both project.yaml files: each repo's range (…) and its stacks' starts_at should now cover the commits that are in that project.
```

- **Which PRs:** commit shas or unique prefixes (7+ hex), from `<from>`'s range or with a file there (a commit that
  already left the range), or `--stack <n>`, every commit of declared stack `n` of `<repo>` in `<from>`.
  `--to-repo <name>` if the repo is named differently in `<to>`.
- **After a rebase.** A commit whose data is still in its old sha's file (re-matched, but nothing written under the new
  sha yet: [Following rebases](/concepts/following-rebases/)) gets that file moved, under its old name, so `<to>`
  re-matches it in the same way. The report says `(carried over from <old sha>)` for it.
- **Never deletes or replaces.** Each file is written into `<to>` create-only. If any of them is already there, it
  stops before writing anything. Only then is each original renamed to `<sha>.moved-to-<to>.yaml.bak`, so it drops out
  of `<from>` with its contents still there. A [snapshot](/reference/data-directory/#snapshots) of `projects/` is taken
  first. The images the moved descriptions show are copied into `<to>`'s `assets/` too; the originals stay.
- **Doesn't edit `project.yaml`.** It prints what's left to change: the ranges, `starts_at`, and the `landed:` keys of
  any merged PRs it moved.
- `--dry-run` writes nothing and takes no snapshot. It prints the same list under
  `Dry run: nothing written. Moving from <from> to <to> would:`.
- The snapshot is skipped when nothing changed since the newest one, and when snapshots are off (see
  [Snapshots](/reference/data-directory/#snapshots)).

## `local-review service`

```text
local-review service install [--port <n>] [--dry-run] [--from-checkout] [--refresh]
local-review service uninstall | start | status [--json]
local-review service stop | restart [--force]
local-review service logs [-f] [-n <lines>]
```

Runs Local Review in the background, started at login and restarted if it exits: a launchd LaunchAgent on macOS
(`~/Library/LaunchAgents/local-review.server.plist`), a systemd user unit on Linux
(`~/.config/systemd/user/local-review-server.service`, or under `$XDG_CONFIG_HOME`). Not on Windows: there it says so and does nothing. The whole
story, with the generated file: [Running as a service](/getting-started/service/).

| Command | |
| --- | --- |
| `service install` | Write the service's file and start it, then wait for it to answer. It runs this `local-review` and this Node, by absolute path, with a `PATH` that must find git, on 127.0.0.1 only. Running it again rewrites the file and restarts a running service onto it, and keeps the port, `LOCAL_REVIEW_HOME` and `LOCAL_REVIEW_USER` it was installed with unless you give new ones. |
| `service start` | Start the installed service, and wait until it answers. |
| `service stop` | Stop it until `service start` or your next login. It stays installed and enabled; `service uninstall` removes it. Refuses with exit 75 while it's [busy](#local-review-busy); `--force` stops it anyway (and says what it's overriding). |
| `service restart` | Restart it, e.g. after `npm i -g local-review@latest` (`local-review update` does that and the restart for you). A stale service file (an older version's, or one whose Node or `local-review` has gone) is rewritten first, keeping its port and environment. Refuses with exit 75 while it's busy, unless `--force`. |
| `service status` | Whether it's installed, loaded, running and answering, its port, the version installed and the version answering, the Node and `local-review` it runs, its log and whether it's busy, with a warning if something is off. Exits 0, 3 (installed, not running or not answering) or 4 (not installed). `--json` for scripts. |
| `service logs` | The last 50 lines of its log, `<data>/logs/service.log`. `-n <lines>` for more or fewer, `-f` to keep printing what it writes. |
| `service uninstall` | Stop it and remove its file. Nothing else: the data home, `logs/` included, is untouched. |

| Option (`install`) | |
| --- | --- |
| `--port <n>` | The port, 1–65535. Default: the one it was installed with, else 5622. `PORT` isn't used. |
| `--dry-run` | Print the file it would write, and do nothing else. |
| `--from-checkout` | Allow a source checkout's build (`dist/`) to be the service. Without it, a checkout is refused. |
| `--refresh` | Rewrite the installed service for this version from what it was installed with (its port, data home, environment and `PATH`, not this shell's), and restart it. `--port` still wins. Exits 4 with nothing installed. `update` runs it. |

It refuses to install from npx's cache (or pnpm dlx's, bunx's, yarn dlx's), which can be deleted at any time, and
says what to do instead: `npm i -g local-review`, then `local-review service install`.

## `local-review busy`

```text
local-review busy [--json]
```

Asks the running Local Review whether it's busy: whether a restart now would cut short a write under way. It counts
saves (a comment, a reply, a Viewed mark, a description, an image), backup snapshots and GitHub syncs. Open pages
don't count: drafts live in the browser, and pages reconnect after a restart.

```text
$ local-review busy
Local Review is busy: 1 save and 1 GitHub sync are running.
$ echo $?
75
```

It exits 0 when it isn't busy, 75 when it is, and 3 when nothing is running. It finds the instance through
`<data>/runtime.json`, which `serve` writes, so give it the same `--data-dir` (or `LOCAL_REVIEW_HOME`) as the
instance. `--json` prints `{ running, busy, url, version, counts }`. It's for scripts and for anything that restarts
Local Review (`service stop` and `restart` run the same check). The server's side is
[`GET /api/busy`](/reference/http-api/).

## `local-review update`

```text
local-review update [--check] [--to <version|tag>] [--yes] [--force] [--json]
```

Updates this `local-review` to the latest version on npm and restarts the service onto it; if the new version doesn't
answer, it puts the old one back. `upgrade` works too. The whole story: [Updating](/getting-started/updating/).

| Option | |
| --- | --- |
| `--check` | Only say whether there's a newer version, and change nothing. Exits 0 either way; `--json`'s `updateAvailable` says which. |
| `--to <v>` | A version (`0.16.0`) or a dist-tag (`next`). The only way to go to a lower version. |
| `--yes` | Don't ask. Without a terminal, `update` needs it (exit 2 otherwise). |
| `--force` | Update even while Local Review is [busy](#local-review-busy). The health check and the rollback still run. |
| `--json` | One JSON document on stdout; the progress goes to stderr. |

It exits 5 when this copy can't update itself (npx's cache, a source checkout, another project's dependency, a
global folder you can't write to), printing the command to run instead; 6 when the new version didn't start and the
old one is running again; 7 when that couldn't be undone either (it prints the commands to run by hand); and 75 when
it's busy.

## `local-review doctor`

```text
local-review doctor [--json] [--offline]
```

Checks this install, one line each: `✓` fine, `!` a warning, `✗` a problem, with a `fix:` line under each problem.

```text
$ local-review doctor
✓ Node 22.12.0 (Local Review needs >=22)
✓ Local Review 0.16.0, installed globally with npm: `local-review update` can update it
✓ the service is installed (systemd): ~/.config/systemd/user/local-review-server.service
✓ http://localhost:5622 is running 0.16.0
✓ port 5622 is Local Review's (0.16.0)
! linger is off for ed: the service stops when you log out, and starts only when you log in
    fix: sudo loginctl enable-linger ed
✓ the data home ~/.local-review is writable
✓ git: /usr/bin/git
✓ gh: /usr/bin/gh
✓ 0.16.0 is the latest
```

It checks this Node against what Local Review needs; how it was installed; the service (whether the Node and
`local-review` it runs are still there, and whether it's this one); that the version running is the one installed;
that the port is free or Local Review's; linger, on Linux; that the data home is writable; that git (needed) and gh
(for publishing and the GitHub sync) are on your `PATH`; and whether there's a newer version on npm, which
`--offline` skips. It exits 1 if a check failed; warnings don't count. `--json` gives
`{ ok, version, checks: [{ id, status, message, fix }] }`, `status` being `pass`, `warn`, `fail` or `skip`. It writes
nothing but `update-check.json`, as `update --check` does.

## `local-review guide`

Prints the [agent guide](/agents/agent-guide/) (`AGENT-GUIDE.md`, which ships in the package), so an agent reads the
version that matches the Local Review it is driving, without a checkout.

## `--version`, `--help`

`-v` / `--version` prints the version and nothing else; `-h` / `--help` prints the usage above.

## `--data-dir`

`--data-dir <path>` sets the data home for one command, before or after it: `local-review --data-dir /tmp/lr-demo`
is the same as `LOCAL_REVIEW_HOME=/tmp/lr-demo local-review`. `service install --data-dir <path>` installs a service
that uses it, as `LOCAL_REVIEW_HOME` would.

## Exit codes

| Code | When |
| --- | --- |
| `0` | Success. |
| `1` | An error, printed as `local-review: <message>` (no such project, the port is in use, `init`'s file exists, a file that isn't an image, a `move` that would replace a file, a `service install` refused or not answering, …). |
| `2` | Bad usage (an unknown command or option, a missing argument, a bad project or asset name, a URL `asset url` can't use): the message, then the usage. |
| `3` | `service status`: installed, but not running or not answering. `busy`: nothing is running. `update`: a `local-review` is running in a terminal, with no service to stop. |
| `4` | `service status`, `start`, `stop`, `restart`, `logs`, `install --refresh`: there's no service installed. |
| `5` | `update`: this copy can't update itself; the right command was printed. |
| `6` | `update`: the new version didn't start, and the old one is running again. |
| `7` | `update`: the new version didn't start, and the old one couldn't be put back; it printed what to run. |
| `75` | `busy`: it's busy. `update`, `service stop`, `restart`: refused because it's busy; try again later, or use `--force`. |

These follow the [CLI contract](https://github.com/edspencer/cli-contract) shared by Local Review and its sibling tools.

## Environment

`LOCAL_REVIEW_HOME`, `PORT`, `LOCAL_REVIEW_USER` and the rest: [Environment variables](/reference/environment/).
