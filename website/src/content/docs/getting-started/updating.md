---
title: Updating
description: Update Local Review with `local-review update`, which restarts the service onto the new version and puts the old one back if it doesn't start.
---

```sh
local-review update
```

```text
$ local-review update
Update Local Review 0.15.0 → 0.16.0? The service will restart.
  Changes: https://github.com/edspencer/local-review/releases/tag/v0.16.0
  Continue? [y/N] y
  Fetching local-review@0.16.0…
  Stopping the Local Review service…
  Installing local-review@0.16.0 with npm…
  Refreshing the service unit with the new version…
  Waiting for 0.16.0 to answer at http://127.0.0.1:5622…
Updated Local Review 0.15.0 → 0.16.0. Running at http://127.0.0.1:5622
```

It installs the latest version from npm with the package manager you installed it with, then restarts the
[service](/getting-started/service/) onto it. Your data isn't touched: it lives in `~/.local-review`, not in the
package. `upgrade` works too.

## Just checking

```sh
local-review update --check
```

```text
Local Review 0.16.0 is available (you have 0.15.0).
  Run: local-review update
  Changes: https://github.com/edspencer/local-review/releases/tag/v0.16.0
```

It changes nothing and exits 0 whether or not there's a newer version. With `--json` it prints
`{ name, current, target, updateAvailable, installMethod, canUpdate, command, … }` for scripts.
[`local-review doctor`](/reference/cli/#local-review-doctor) checks too, along with the rest of the install.
`local-review service status` repeats what the last check found, but never asks npm itself: nothing in Local Review
contacts npm unless you run one of those three commands.

## What it does, in order

1. **Takes a lock** (`~/.local-review/update.lock`), so two updates can't run at once.
2. **Asks npm** for the latest version (or the one `--to` names), and compares. Up to date: it says so and stops.
3. **Checks it can**: that this copy is one it can update (below), that the new version runs on your Node, and that
   npm's global folder is writable by you. It never runs `sudo`; it prints the command with `sudo` instead.
4. **Asks whether Local Review is busy**, as [`local-review busy`](/reference/cli/#local-review-busy) does, before
   anything stops. If it's saving a comment, taking a snapshot or syncing with GitHub, it refuses with exit 75: run
   it again in a moment, or add `--force`.
5. **Asks you**, with the release notes' link. `--yes` answers for you, and without a terminal (a script, cron)
   `--yes` is required.
6. **Fetches both versions** into npm's cache first, so a network failure happens while the old version still runs,
   and the old one is at hand for a rollback.
7. **Stops the service**, then **installs** the new version.
8. **Hands over** to the new version's own `local-review service install --refresh`, which rewrites the service
   from what it was installed with (port, data home, environment), in the new version's format, and starts it.
9. **Waits for the new version** to answer on `/api/health`, for up to 30 seconds.

If anything from the install on fails, it prints the last lines of the service's log and **puts the old version
back**: it reinstalls it, refreshes the service with the old version's CLI, and checks it answers. Then it exits
**6** (`0.16.0 didn't start; 0.15.0 is running again.`). If even that fails, it exits **7** and prints the commands
to run by hand.

**Without a service** (you run `local-review` in a terminal), it does steps 1 to 6 and the install. If Local Review is
running, stop it first (Ctrl-C): `update` won't install under a running server, and exits 3 if one answers. Then
start it again.

## Options

| Option | |
| --- | --- |
| `--check` | Report, change nothing. |
| `--to <v>` | A version (`0.16.0`) or a dist-tag (`next`). The only way to go back to a lower version. |
| `--yes` | Don't ask. |
| `--force` | Update even while it's busy. Only the busy check is skipped: the health check and the rollback still run. |
| `--json` | One JSON document on stdout, the progress on stderr. |

## When it can't update itself

Some copies aren't `update`'s to change. It says so, prints the right command, and exits **5**:

| Installed | What to run instead |
| --- | --- |
| With npx (`npx local-review`) | Nothing: `npx local-review@latest` fetches the latest each time. |
| From a source checkout | `git pull && npm install && npm run build` |
| As a dependency of another project | `npm install local-review@<version>` in that project. |
| With yarn's `global add` | `yarn global add local-review@<version>` |
| Where npm's global folder isn't yours to write | `sudo npm install -g local-review@<version>` |
| Managed by something else (`LOCAL_REVIEW_UPDATE_HINT` is set) | Whatever that hint says. |

A global install with npm, pnpm, bun or Volta is updated with that same tool.

## Exit codes

| Code | |
| --- | --- |
| `0` | Updated, already up to date, or (`--check`) reported. |
| `1` | Failed before anything changed: npm couldn't be reached, the version doesn't exist, the new version needs a newer Node, or another update is running. |
| `2` | No terminal to ask, and no `--yes`. |
| `3` | Local Review is running in a terminal, with no service to stop. |
| `5` | This copy can't update itself; the command to run was printed. |
| `6` | The new version didn't start; the old one is running again. |
| `7` | The new version didn't start, and the old one couldn't be put back. Run what it printed. |
| `75` | Busy. Try again later, or use `--force`. |

These are the [CLI contract](https://github.com/edspencer/cli-contract)'s, shared with Local Review's sibling tools.
