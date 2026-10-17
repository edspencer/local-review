---
title: Environment variables
description: Environment variables that change where Local Review keeps data and how it runs.
---

Local Review needs no configuration. These variables change where it keeps its data, which port it uses and who it
thinks you are.

| Variable | Default | What it does |
| --- | --- | --- |
| `LOCAL_REVIEW_HOME` | `~/.local-review` | The [data directory](/reference/data-directory/): `projects/`, `backups/`, `examples/`, `cache/` and `logs/` all move. `~` is expanded. |
| `PORT` | `5622` | The port `local-review` serves on. `--port` wins over it. Also used in the URL `init` prints. Not used by `service install`. |
| `LOCAL_REVIEW_USER` | `git config user.name`, else `$USER` | Who you are: your comments are stored under this name's id. See [The reviewer](#local_review_user-the-reviewer). |
| `NO_COLOR`, `FORCE_COLOR` | colour on a terminal | The startup banner's colours. See [Colour](#colour-no_color-and-force_color). |
| `XDG_CONFIG_HOME` | `~/.config` | Linux only, for `service`: the systemd user unit goes in `$XDG_CONFIG_HOME/systemd/user` if it's an absolute path. |
| `LOCAL_REVIEW_PROJECTS_DIR` | `$LOCAL_REVIEW_HOME/projects` | Moves only `projects/`. For the tests; it turns automatic snapshots and the git cache off unless `LOCAL_REVIEW_HOME` is set too. |

## `LOCAL_REVIEW_HOME`: a scratch instance

Point it at a throwaway directory to try Local Review, or run a second instance, without touching your real reviews:

```sh
LOCAL_REVIEW_HOME=/tmp/lr-demo npx local-review --port 5050
```

Snapshots then go to `/tmp/lr-demo/backups/`. Everything under it is described in
[Where your data lives](/reference/data-directory/).

## `PORT`

`PORT=5050 npx local-review` is the same as `npx local-review --port 5050`; if both are given, `--port` wins. `serve`
rejects a value that isn't an integer from 0 to 65535 rather than silently using the default.

`local-review service install` ignores `PORT`, so a `PORT` exported for something else can't end up in the service:
give it `--port <n>` instead.

## A service's environment

A service started by launchd or systemd gets almost none of your shell's environment, so
[`local-review service install`](/getting-started/service/) writes what Local Review needs into the service's file:
`PATH` (cleaned up, with git on it), `HOME`, and `LOCAL_REVIEW_HOME` (made absolute) and `LOCAL_REVIEW_USER` if they're set
when you install. A reinstall keeps the last two if they aren't set then; to drop one, run `local-review service
uninstall` first. Nothing else is passed on: set the others in the service's file only if you know you need them, and
expect `service install` to rewrite it.

## `LOCAL_REVIEW_USER`: the reviewer

Your comments are stored as `author: <id>`, and only yours can be edited or deleted in the UI (an agent's, `author:
claude`, never are). The name comes from `LOCAL_REVIEW_USER`, else `git config user.name`, else `$USER`. The id is its
first word, lowercased and reduced to `[a-z0-9_-]`, at most 32 characters: "Ada Lovelace" becomes `ada`. `claude` is
the agent's id, so a reviewer who would get it (or an empty id) is `reviewer` instead. `GET /api/me` returns both.

If your comment files were written under some id, set `LOCAL_REVIEW_USER` to that id to keep them yours:

```sh
LOCAL_REVIEW_USER=ada npx local-review
```

## `LOCAL_REVIEW_PROJECTS_DIR`

Moves just the `projects/` directory. It's meant for the test suite: it isn't a data home, so automatic
[snapshots](/reference/data-directory/#snapshots) and the git cache (`cache/`) are **off** unless `LOCAL_REVIEW_HOME`
is set as well (they then go to `$LOCAL_REVIEW_HOME/backups` and `$LOCAL_REVIEW_HOME/cache`). Prefer `LOCAL_REVIEW_HOME`.

## Developing Local Review

These only matter when you run Local Review from a checkout with `npm run dev` (see
[Contributing](/contributing/)):

| Variable | Default | What it does |
| --- | --- | --- |
| `LOCAL_REVIEW_WEB_PORT` | `5622` | The port Vite serves the UI on. |
| `LOCAL_REVIEW_API_PORT` | `5623` | The port of the API server Vite proxies `/api` to. |
| `LOCAL_REVIEW_DEV` | unset | Set by `npm run dev` for the API server: it doesn't serve the built UI (Vite does), and its default port is `5623`. |

Change both to run a dev instance next to a live one.

## Colour: `NO_COLOR` and `FORCE_COLOR`

Only `local-review`'s startup banner is coloured, and it follows Node's own rules
([`getColorDepth`](https://nodejs.org/api/tty.html#writestreamgetcolordepthenv)):

- `NO_COLOR` (any non-empty value, [no-color.org](https://no-color.org/)): the banner without colour.
- `FORCE_COLOR`: colour, and the banner, even when the output isn't a terminal. `FORCE_COLOR=1`, `2` and `3` pick
  16, 256 or 16 million colours; `FORCE_COLOR=0` turns colour off. If both are set, `FORCE_COLOR` wins, as in Node
  and at [force-color.org](https://force-color.org/).
- Otherwise: colour on a terminal that has it (`COLORTERM`, `TERM`; Windows 10 and later), none on `TERM=dumb`, and
  no banner at all when the output isn't a terminal.

`--quiet` leaves the banner out whatever these say.
