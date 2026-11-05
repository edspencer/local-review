---
title: Running as a service
description: Keep Local Review running in the background, started at login, as a launchd LaunchAgent on macOS or a systemd user service on Linux.
---

`local-review service install` sets Local Review up to start when you log in and to restart if it stops: a
LaunchAgent on macOS, a systemd user service on Linux. **Windows isn't supported yet**: there, `service install` says
so and does nothing. Run `local-review` in a terminal, or set up a Task Scheduler task yourself.

`npx local-review` runs until you close the terminal. To have the UI always there on `http://localhost:5622`, install
Local Review and make it a service:

```sh
npm i -g local-review
local-review service install      # run it at every login
```

```text
$ local-review service install
Installed Local Review as a LaunchAgent: ~/Library/LaunchAgents/local-review.server.plist
It's running: http://localhost:5622
It starts at login and is restarted if it exits.
Data: ~/.local-review. Log: ~/.local-review/logs/service.log (`local-review service logs`).
```

Both start at **login**, not at boot (except a Linux service with lingering on, below).

## Installing

```sh
local-review service install [--port <n>] [--dry-run] [--from-checkout] [--refresh]
```

- **`--port <n>`** picks the port (default 5622). `$PORT` isn't used, so a `PORT` exported for something else can't
  end up in the service by accident.
- **It waits until Local Review answers** before it returns, for up to 15 seconds. If it doesn't answer, it says so,
  prints the last 20 lines of its log and exits 1.
- **Running it again is safe:** it keeps the port and settings the service already has, unless you give new ones, and
  restarts the running service onto them. Those settings are the port, `LOCAL_REVIEW_HOME` and `LOCAL_REVIEW_USER`;
  it says when it kept one, and to drop one, `uninstall` first. It rewrites the file (`(unchanged)` if nothing in it
  changed), and the old process never keeps serving.
- **`--dry-run` prints the unit and writes nothing**: no file, no directory, nothing started.
- **`--refresh`** rewrites the installed service in this version's format from what *it* records (its port, data
  home, environment and `PATH`), not from the shell you run it in, then restarts it. `--port` still wins. With nothing
  installed it exits 4 rather than installing with defaults. It's what [`local-review update`](/getting-started/updating/)
  runs with the new version.
- It refuses to install **from an npx cache** (the folder is temporary), **from a git checkout unless you add
  `--from-checkout`**, and **when something else holds the port** (most likely `local-review` running in a terminal:
  stop that first, or pick another port). Each refusal writes nothing. More on the first two below.
- If systemd or launchd refuses a first install, it takes back the file it wrote, so `service status` doesn't say
  it's installed. A refused reinstall keeps the file it had.

### Linux: linger

**Without linger, the service stops when you log out**, and starts only when you log in. With it, the service runs
while you're logged out, and starts at boot. Turn it on once:

```sh
sudo loginctl enable-linger $USER
```

`install` reminds you of it, and [`doctor`](/reference/cli/#local-review-doctor) checks, and prints
`sudo loginctl enable-linger <user>` when it's off. **Local Review never runs `sudo` itself.**

### Not from npx

`local-review service install` refuses to run from npx's cache, which npm can delete at any time: the service would
break at some later login, and it would stay on that one version. It refuses pnpm dlx, bunx and yarn dlx for the same
reason, writes nothing and says what to do instead:

```text
$ npx local-review service install
local-review: Local Review is running from npx's cache, which npm can delete at any time, so a service that runs it would break at some later login. Install it first: `npm i -g local-review`, then run `local-review service install` again.
```

### Not from a checkout, unless you mean it

From a clone of the repo, it refuses too: the service would run whatever the checkout last built, and break when it's
cleaned or rebuilt. If that's what you want (you're working on Local Review itself), build it and add
`--from-checkout`:

```sh
npm run build
npm run lr -- service install --from-checkout
```

## Where things are

| | macOS | Linux |
| --- | --- | --- |
| The unit | `~/Library/LaunchAgents/local-review.server.plist` | `~/.config/systemd/user/local-review-server.service` (under `$XDG_CONFIG_HOME` if that's set) |
| The log | `~/.local-review/logs/service.log` | the same |

The log is in the data home, so it's `logs/service.log` under `LOCAL_REVIEW_HOME` if you installed with that set.

The unit runs this Node and this install's `cli.js` by their real paths, never the `local-review` shim (see
[What the service runs](#what-the-service-runs)). So **if you remove that Node version (nvm, fnm, volta), `service
status` and `doctor` warn, and `service install` again fixes it.** It keeps the port and data home.

## The commands

| Command | |
| --- | --- |
| `service install` | Write the unit, start it, and wait until it answers ([Installing](#installing)). |
| `service uninstall` | Stop it and remove the unit. Your data and logs stay. |
| `service start` | Start the installed service, and wait until it answers. |
| `service stop [--force]` | Stop it until `service start`, or the next login or boot. Refuses while it's [busy](#busy). |
| `service restart [--force]` | Stop it and start it again, rewriting a stale unit first. Refuses while it's [busy](#busy). |
| `service status [--json]` | Installed? Running? Which version? Answering? Busy? |
| `service logs [-f] [-n <lines>]` | The last 50 lines of its log; `-f` follows, `-n` sets how many. |

`start`, `stop`, `restart` and `logs` exit 4 when there's no service installed, and say how to install one.

### `service start` and `service stop`

`service start` starts the installed service and waits until it answers, as `install` does, printing the end of its
log if it doesn't. It refuses if something else has the port (a `local-review` in a terminal, say).

`service stop` **stops it until `service start`, or the next login or boot. It doesn't disable the service. To keep it
off for good, use `service uninstall`.** That's what `systemctl --user stop` and `launchctl bootout` do on their own
(the next boot only starts a Linux unit with lingering on). Like `restart`, it first checks whether Local Review is
[busy](#busy).

```text
$ local-review service stop
Stopped Local Review. It starts again at your next login, or with `local-review service start`. To keep it off, `local-review service uninstall`.
```

### `service status`

```text
$ local-review service status
Service:   ~/.config/systemd/user/local-review-server.service
Loaded:    yes (active (running)), starts at login
Running:   yes, pid 48213
UI:        http://localhost:5622
Busy:      no
Version:   0.15.0
Node:      ~/.nvm/versions/node/v22.12.0/bin/node
Runs:      ~/.nvm/versions/node/v22.12.0/lib/node_modules/local-review/dist/server/cli.js
Data:      ~/.local-review
Log:       ~/.local-review/logs/service.log
```

It warns when the Node or the `local-review` the service runs has gone (after a Node upgrade, say), when it runs a
different `local-review` from the one you just ran, or when the version answering isn't the one installed (you
upgraded but haven't restarted). `Busy` is what [`local-review busy`](/reference/cli/#local-review-busy) would say.
`--json` gives the same as JSON, for scripts: `version` (and `runningVersion`) is the version answering,
`installedVersion` the one on disk, `unit` the service's file, `busy` what it's doing, and `update` what the last
[`update --check`](/getting-started/updating/) or `doctor` found (left out when there's nothing to repeat: `status`
never asks npm itself). The fields are the ones
the [CLI contract's schema](https://github.com/edspencer/cli-contract/blob/main/schemas/service-status.schema.json)
names.

It exits **0** when the service is running and answering, **3** when it's installed but isn't (stopped, or
not answering), and **4** when it isn't installed, with or without `--json`. Those are the codes `systemctl status`
uses.

### `service restart`

Restarts it, for instance after an upgrade (below), unless it's [busy](#busy). If the service's file is stale, it's rewritten first, keeping
the port and the environment it was installed with. A file is stale when an older Local Review wrote it (one from
before 0.14 logs to two files), or when the Node or `local-review` it names has gone. In that last case, it's pointed
at the `local-review` you ran and its Node.

### `service logs`

**The last 50 lines; `-f` follows, `-n` sets how many** (until you press Ctrl-C). It reads `logs/service.log` in the
data home ([Logs](#logs), below), not the systemd journal, so it's the same command on both OSes. A service installed before 0.14 writes `server.out.log`
and `server.err.log` instead. `service logs` shows both until `service restart` moves the service to the one file.
The old files are left where they are.

### `service uninstall`

**Stops it and removes the unit. Your data and logs stay**: everything in `~/.local-review`, `logs/` included, stays
exactly where it is, as the [never-delete guarantee](/guarantees/never-delete/) promises. Running it when there's no
service just says so. It works from npx too.

## Busy

**`service stop` and `service restart` first ask the running Local Review whether it's busy**: saving a comment or a
description, taking a backup snapshot, or syncing with GitHub. **If it is, they refuse with exit 75 and say what's
running. Wait and try again, or add `--force`, which prints the same message prefixed `Overriding:` and goes ahead.**

```text
$ local-review service restart
local-review: Local Review is busy: 1 GitHub sync is running. Try again once it has finished (`local-review busy` says when), or restart it anyway with --force.
```

Those writes take a moment, so trying again usually just works. Open pages don't count as busy: drafts live in the
browser, and the pages reconnect once it's back. `uninstall` doesn't ask, since removing the service is a deliberate
act. [`local-review busy`](/reference/cli/#local-review-busy) asks the same question on its own (0 not busy, 75 busy,
3 nothing running).

## Logs

One file, `~/.local-review/logs/service.log`, which stdout and stderr both append to, on both OSes. **Local Review
rotates it itself** (by copying and truncating, at 8 MB, keeping 3: `service.log.1` to `.3`), because the service
manager holds it open: when it starts, and every 15 minutes while it runs. `service logs` reads it, and `service
uninstall` leaves it.

## Exit codes

| Code | |
| --- | --- |
| `0` | Running and answering (`status`); done (the rest). |
| `1` | Failed: refused (npx, a checkout, the port), or started but not answering. |
| `2` | Usage: an unknown command or option, or an option the command doesn't take. |
| `3` | **Installed but not running or not answering** (`status`). |
| `4` | **Not installed** (`status`, `start`, `stop`, `restart`, `logs`, `install --refresh`). |
| `75` | **Busy** (`stop`, `restart`): try again later, or use `--force`. |

## What the service runs

The service runs exactly the `local-review` you installed it from, with absolute paths, because launchd and systemd
start a service with almost no environment of its own:

```text
/usr/local/bin/node /usr/local/lib/node_modules/local-review/dist/server/cli.js serve --quiet --port 5622
```

- **Node** is the one that ran `service install`, as a real path (never a version manager's shim).
- **`PATH`** starts with that Node's own `bin` directory, then the parts of your shell's `PATH` that last (not a
  version manager's per-terminal directory such as fnm's `fnm_multishells/…`, not npx's or `npm run`'s, nothing
  relative and nothing that doesn't exist), then the usual system directories. Local Review runs git, so
  `service install` refuses if git isn't on it.
- **`HOME`** is your home directory, so the data home, the logs and git's `user.name` (your reviewer id) are the
  ones you'd get in a terminal.
- **`LOCAL_REVIEW_HOME`** and **`LOCAL_REVIEW_USER`** are passed on if they're set when you install
  (`LOCAL_REVIEW_HOME` made absolute). Nothing else from your environment is.
- It still listens on **127.0.0.1 only**, as `local-review` always does. There's no option to change that
  ([Localhost security](/guarantees/localhost-security/)).
- Its working directory is the data home, and its output, stdout and stderr both, is appended to `logs/service.log`
  there ([Logs](#logs)).

Here is a generated unit, from `local-review service install --dry-run` on Linux:

```ini
# Generated by Local Review (local-review.server). Don't edit it: `local-review service install` rewrites it.
# Node v22.12.0: /usr/local/bin/node
[Unit]
Description=Local Review: the review UI on http://localhost:5622

[Service]
Type=simple
WorkingDirectory=/home/you/.local-review
ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/local-review/dist/server/cli.js serve --quiet --port 5622
Environment="PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
Environment="HOME=/home/you"
StandardOutput=append:/home/you/.local-review/logs/service.log
StandardError=append:/home/you/.local-review/logs/service.log
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

The macOS plist says the same: `RunAtLoad` and `KeepAlive`, with `ThrottleInterval` 10.

## Updating

`local-review update` installs the latest version and restarts the service onto it, and if the new version doesn't
come up it puts the old one back: see [Updating](/getting-started/updating/). By hand, it's
`npm i -g local-review@latest` then `local-review service install --refresh`.

## How much of this has been tested

- **Tests, on Linux and macOS:** the generated plist and unit, read back again; escaping; the `PATH`; the refusals;
  install, reinstall, start, stop, status and its exit codes, restart (and a stale file rewritten), logs, the busy
  refusal and `--force`, launchd's bootout-then-bootstrap race, and uninstall, with launchctl and systemctl stood in
  for. On macOS the plist also
  passes `plutil -lint`, and on Linux the unit passes `systemd-analyze verify`.
- **For real, in CI:** the package as you'd install it, against launchd on a GitHub macOS runner and a systemd user
  instance on a GitHub Ubuntu runner: refused from npx, installed, reinstalled, killed (and restarted by
  launchd or systemd), asked whether it's busy, stopped (and still installed and enabled, with its `runtime.json`
  removed by a clean exit), started, restarted, its log read, moved to another
  port, and uninstalled with the data home untouched.
- **Not tested yet:** a real logout and login, or a reboot, on either OS.
