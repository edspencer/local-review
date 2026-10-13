---
title: CLI
description: Every local-review command and flag.
---

One command, `local-review`, does everything: with no arguments it serves the UI, and its subcommands create
projects, add images, print a project's publishing plan, move review data between projects, add or hide the example
projects and print the agent guide. Run it with `npx local-review …`, or install it once with `npm i -g local-review`
and run `local-review …`.

```sh
npx local-review                          # serve the UI on http://localhost:5622
npx local-review --port 5050              # …on another port
npx local-review init my-feature          # create ~/.local-review/projects/my-feature/project.yaml
npx local-review asset add my-feature diagram.png   # prints ![diagram](assets/<hash>.png)
npx local-review plan my-feature --stack 1 --format json
npx local-review move my-feature my-follow-up my-service --stack 3   # after splitting a project
npx local-review examples                 # add the example projects (remove: `examples remove`)
npx local-review guide                    # print the guide for agents
```

## `local-review --help`

```text
Usage: local-review [serve] [--port <n>] [--quiet]
       local-review plan <project> [--repo <name>] [--stack <n>] [--include-follow-on] [--format md|json|yaml]
       local-review init <project>
       local-review asset add <project> <file> [--alt <text>]
       local-review asset url <project> <name> <url>
       local-review move <from> <to> <repo> (<sha>… | --stack <n>) [--to-repo <name>] [--dry-run]
       local-review examples [remove]
       local-review guide
       local-review --version | --help

  serve   (the default) Serve the review UI and API on http://localhost:<port> (127.0.0.1 only).
          --port <n>       the port (default 5622, or $PORT)
          --quiet, -q      print just the "Local Review on <url>" line: no banner, no hint for agents
                           (the banner is only shown on a terminal anyway)
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
  guide   Print the guide for agents using Local Review to get their work reviewed (AGENT-GUIDE.md).

Data: $LOCAL_REVIEW_HOME/projects (default ~/.local-review/projects). Agents: run `local-review guide`.
```

## `local-review [serve]`

Serves the review UI and its [HTTP API](/reference/http-api/) on `http://localhost:5622`, bound to 127.0.0.1 only
(see [Localhost security](/guarantees/localhost-security/)). `serve` is the default, so `local-review` on its own
does the same. On start, in a terminal, it prints a LOCAL REVIEW banner, then the URL and the projects directory it
reads, then how to get a coding agent to set up a project (from [its llms.txt](/agents/llms-txt/)):

```text
 ██     ▄████▄ ▄█████ ▄████▄ ██         █████▄ ██████ ██  ██ ██ ██████ ██    ██
 ██     ██  ██ ██     ██  ██ ██         ██  ██ ██     ██  ██ ██ ██     ██    ██
 ██     ██  ██ ██     ██  ██ ██         ██▄▄██ ██▄▄▄  ██  ██ ██ ██▄▄▄  ██    ██
 ██     ██  ██ ██     ██████ ██         ██▀██  ██▀▀▀  ██  ██ ██ ██▀▀▀  ██ ██ ██
 ██     ██  ██ ██     ██  ██ ██         ██  ██ ██      ████  ██ ██     ██ ██ ██
 ██████ ▀████▀ ▀█████ ██  ██ ██████     ██  ██ ██████   ██   ██ ██████ ▀██▀▀██▀

Local Review on http://localhost:5622  (projects: /home/you/.local-review/projects)


Point Claude Code/Codex/pi/whatever at http://localhost:5622/llms.txt then ask it to generate a project definition for you. Example:

  Read http://localhost:5622/llms.txt and create a local-review project for my feature-xyz branch on ~/code/my-git-project
```

The URLs are the ones it's actually on, so `--port` or `PORT` changes them. The banner is in the header's plum and
amber, in full colour where the terminal has it, else the nearest of 256 or 16 colours, else none (`NO_COLOR`; see
[Environment variables](/reference/environment/#colour-no_color-and-force_color)). It's left out when the output
isn't a terminal (piped, written to a log file, in CI) unless `FORCE_COLOR` is set, and a terminal narrower than 80
columns gets a one-line title instead. The `Local Review on …` line is always printed, first thing after the banner,
so a script can wait for it.

| Option | |
| --- | --- |
| `--port <n>` | The port, 0–65535 (`0` picks any free port). Wins over `PORT`. Also written `--port=<n>`. |
| `--quiet`, `-q` | Print only the `Local Review on …` line: no banner, no hint for agents. |

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

## `local-review guide`

Prints the [agent guide](/agents/agent-guide/) (`AGENT-GUIDE.md`, which ships in the package), so an agent reads the
version that matches the Local Review it is driving, without a checkout.

## `--version`, `--help`

`-v` / `--version` prints the version; `-h` / `--help` prints the usage above.

## Exit codes

| Code | When |
| --- | --- |
| `0` | Success. |
| `1` | An error, printed as `local-review: <message>` (no such project, the port is in use, `init`'s file exists, a file that isn't an image, a `move` that would replace a file, …). |
| `2` | Bad usage (an unknown command or option, a missing argument, a bad project or asset name, a URL `asset url` can't use): the message, then the usage. |

## Environment

`LOCAL_REVIEW_HOME`, `PORT`, `LOCAL_REVIEW_USER` and the rest: [Environment variables](/reference/environment/).
