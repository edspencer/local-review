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

**`local-review update` asks the registry for the latest version, checks whether Local Review is busy, asks you to
confirm, downloads the new version first (while the old one is still running), stops the service, installs, starts the
new version and waits until it answers.** If anything from the install on fails, it puts the old version back. It
installs with the package manager you installed it with, and restarts the [service](/getting-started/service/) onto
the new version. Your data isn't touched: it lives in `~/.local-review`, not in the package. `upgrade` works too.

## Just checking

```sh
local-review update --check
```

```text
Local Review 0.16.0 is available (you have 0.15.0).
  Run: local-review update
  Changes: https://github.com/edspencer/local-review/releases/tag/v0.16.0
```

**It reports and changes nothing. It exits 0 whether or not there's an update; with `--json`, read
`updateAvailable`.** The document is `{ name, current, target, updateAvailable, installMethod, canUpdate, command, … }`.
[`local-review doctor`](/reference/cli/#local-review-doctor) checks too, along with the rest of the install.

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

## Busy

**If Local Review is busy, `update` refuses with exit 75 before anything is stopped**, and says what's running:
saving a comment or a description, taking a backup snapshot, or syncing with GitHub. Wait, or use `--force`.

## If the new version doesn't start

**`update` waits up to 30 seconds for the new version to answer. If it doesn't, it prints the last 20 lines of the
log, reinstalls the old version and checks that it answers: exit 6, "0.16.0 didn't start; 0.15.0 is running again."
If the old version doesn't come back either, it exits 7 and prints the commands to run by hand.** The same rollback
runs if the install or the hand-over fails.

## Without a service

If you run `local-review` (`serve`) yourself, in a terminal, there's no service to stop or start, so `update` does
steps 1 to 6 and then:

- **if that `local-review` is answering, it asks you to stop it** (Ctrl-C in its terminal) **and exits 3**, before
  installing anything: it won't install under a running server. Run `update` again once it's stopped.
- otherwise it installs the new version and stops there. **Restart Local Review to use it.**

## Options

| Option | |
| --- | --- |
| `--check` | **Reports and changes nothing. It exits 0 whether or not there's an update; with `--json`, read `updateAvailable`.** |
| `--to <version\|tag>` | **A version or a dist-tag (`next`). It's the only way to move to a lower version.** |
| `--yes` | **Skips the question. Without a terminal (a script, cron), `--yes` is required, or `update` exits 2.** |
| `--force` | **Skips the busy check, and nothing else: the health check and the rollback still run.** |
| `--json` | One JSON document on stdout; prose on stderr. |

## When it can't update itself

Some copies aren't `update`'s to change. It says so, prints the right command, and exits **5**:

| Installed | What to run instead |
| --- | --- |
| Managed by something else (`LOCAL_REVIEW_UPDATE_HINT` is set) | Whatever that hint says. |
| With npx (`npx local-review`) | Nothing: **`npx local-review@latest` already runs the latest**. |
| From a git checkout | `git pull && npm install && npm run build` |
| Where npm's global folder isn't yours to write | **The same command with `sudo`**: `sudo npm install -g local-review@<version>`. **Local Review never runs `sudo` itself.** |
| With yarn's `global add`, or as a dependency of another project | Update it the way you installed it: `yarn global add local-review@<version>`, or `npm install local-review@<version>` in that project. |

**A managed install: if `LOCAL_REVIEW_UPDATE_HINT` is set, `update` prints it and exits 5.** Set it in the
environment of an install something else manages (an Ansible role, a NixOS module), so nobody updates it by hand.

A global install with npm, pnpm, bun or Volta is updated with that same tool.

## No automatic checks

**Local Review never checks for updates by itself. Only `update`, `update --check` and `doctor` ask the registry,
and only when you run them. `service status` repeats what the last of those found**, from
`~/.local-review/update-check.json`.

## Exit codes

| Code | |
| --- | --- |
| `0` | Updated, or up to date (and `--check`, either way). |
| `1` | Failed before anything changed: npm couldn't be reached, the version doesn't exist, the new version needs a newer Node, or another update is running. |
| `2` | Usage, or no terminal without `--yes`. |
| `3` | A foreground `local-review` is still answering. |
| `5` | **This install can't update itself; the right command was printed.** |
| `6` | **The update failed and was rolled back; the old version is running again.** |
| `7` | **The update failed and couldn't be rolled back; a person is needed.** Run what it printed. |
| `75` | **Busy.** Try again later, or use `--force`. |

These are the [CLI contract](https://github.com/edspencer/cli-contract)'s, shared with Local Review's sibling tools.
