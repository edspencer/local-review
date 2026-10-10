---
title: CLI
description: Every local-review command and flag.
---

One command, `local-review`, does everything: with no arguments it serves the UI, and its subcommands create
projects, add images, print a project's publishing plan and print the agent guide. Run it with `npx local-review …`, or install
it once with `npm i -g local-review` and run `local-review …`.

```sh
npx local-review                          # serve the UI on http://localhost:5622
npx local-review --port 5050              # …on another port
npx local-review init my-feature          # create ~/.local-review/projects/my-feature/project.yaml
npx local-review asset add my-feature diagram.png   # prints ![diagram](assets/<hash>.png)
npx local-review plan my-feature --stack 1 --format json
npx local-review guide                    # print the guide for agents
```

## `local-review --help`

```text
Usage: local-review [serve] [--port <n>]
       local-review plan <project> [--repo <name>] [--stack <n>] [--include-follow-on] [--format md|json|yaml]
       local-review init <project>
       local-review asset add <project> <file> [--alt <text>]
       local-review asset url <project> <name> <url>
       local-review guide
       local-review --version | --help

  serve   (the default) Serve the review UI and API on http://localhost:<port> (127.0.0.1 only).
          --port <n>       the port (default 5622, or $PORT)
  plan    For each PR in scope, in order: commit, status (draft / ready / published), branch (with its
          status), base, title and the exact full body (project intro, stack note, ---, PR description), plus
          any recorded github: info. Warns about stacks with draft PRs, GitHub bases that differ from the
          plan's, and published PRs that landed upstream without being frozen. Landed (merged) PRs are
          never planned. Read-only.
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
  guide   Print the guide for agents using Local Review to get their work reviewed (AGENT-GUIDE.md).

Data: $LOCAL_REVIEW_HOME/projects (default ~/.local-review/projects). Agents: run `local-review guide`.
```

## `local-review [serve]`

Serves the review UI and its [HTTP API](/reference/http-api/) on `http://localhost:5622`, bound to 127.0.0.1 only
(see [Localhost security](/guarantees/localhost-security/)). `serve` is the default, so `local-review` on its own
does the same. On start it prints the URL and the projects directory it reads:

```text
Local Review on http://localhost:5622  (projects: /home/you/.local-review/projects)
```

| Option | |
| --- | --- |
| `--port <n>` | The port, 0–65535 (`0` picks any free port). Wins over `PORT`. Also written `--port=<n>`. |

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

## `local-review guide`

Prints the [agent guide](/agents/agent-guide/) (`AGENT-GUIDE.md`, which ships in the package), so an agent reads the
version that matches the Local Review it is driving, without a checkout.

## `--version`, `--help`

`-v` / `--version` prints the version; `-h` / `--help` prints the usage above.

## Exit codes

| Code | When |
| --- | --- |
| `0` | Success. |
| `1` | An error, printed as `local-review: <message>` (no such project, the port is in use, `init`'s file exists, a file that isn't an image, …). |
| `2` | Bad usage (an unknown command or option, a missing argument): the message, then the usage. |

## Environment

`LOCAL_REVIEW_HOME`, `PORT`, `LOCAL_REVIEW_USER` and the rest: [Environment variables](/reference/environment/).
