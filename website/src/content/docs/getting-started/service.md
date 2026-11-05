---
title: Run it as a service
description: Keep Local Review running in the background, started at login, as a launchd LaunchAgent on macOS or a systemd user unit on Linux.
---

`npx local-review` runs until you close the terminal. To have the UI always there on `http://localhost:5622`,
install Local Review and make it a service:

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

It registers Local Review with your OS's own service manager and starts it:

- **macOS:** a LaunchAgent, `~/Library/LaunchAgents/local-review.server.plist`, loaded now and at every login, and
  restarted if it exits.
- **Linux:** a systemd user unit, `~/.config/systemd/user/local-review-server.service` (under `$XDG_CONFIG_HOME` if
  that's set), enabled and started, and restarted if it exits. A user unit runs while you're logged in; to keep it
  running without a login session, and start it at boot, enable lingering once with `loginctl enable-linger $USER`.
  Local Review never does that for you.
- **Windows:** not supported. `local-review service install` says so and does nothing. Run `local-review` in a
  terminal, or set up a Task Scheduler task yourself.

Both start at **login**, not at boot (except a Linux unit with lingering on).

## The commands

```sh
local-review service install [--port <n>] [--dry-run] [--from-checkout]
local-review service start
local-review service stop [--force]
local-review service restart [--force]
local-review service status [--json]
local-review service logs [-f] [-n <lines>]
local-review service uninstall
```

`start`, `stop`, `restart` and `logs` exit 4 when there's no service installed, and say how to install one.

### `service install`

Writes the service's file and starts it, then waits up to 15 seconds for it to answer. If it doesn't, it says so,
prints the last lines of its log and exits 1.

- **`--port <n>`** picks the port (default 5622). `$PORT` isn't used, so a `PORT` exported for something else can't
  end up in the service by accident.
- **It's safe to run again.** It rewrites the file (`(unchanged)` if nothing in it changed), and a service that's
  running is restarted onto it, so the old process never keeps serving. A reinstall **keeps the port, `LOCAL_REVIEW_HOME` and `LOCAL_REVIEW_USER` the service was
  installed with** unless you give new ones, and says when it kept one. To drop one, `uninstall` first.
- **`--dry-run`** prints the file it would write and does nothing else: no file, no directory, nothing started.
- **`--refresh`** rewrites the installed service in this version's format from what *it* records (its port, data home,
  environment and `PATH`), not from the shell you run it in, then restarts it. `--port` still wins. With nothing
  installed it exits 4 rather than installing with defaults. It's what [`local-review update`](/getting-started/updating/)
  runs with the new version.
- If the port is already taken by something else (most likely `local-review` running in a terminal), it stops before
  writing anything: stop that first, or pick another port.

### `service start` and `service stop`

`service start` starts the installed service and waits until it answers, as `install` does, printing the end of its
log if it doesn't. It refuses if something else has the port (a `local-review` in a terminal, say).

`service stop` stops it **until you start it again or until your next login**, whichever comes first. It doesn't
disable it, so it's still installed, and on Linux with lingering on, the next boot starts it too. That's what
`systemctl --user stop` and `launchctl bootout` do on their own. To keep it off for good, use `service uninstall`.

```text
$ local-review service stop
Stopped Local Review. It starts again at your next login, or with `local-review service start`. To keep it off, `local-review service uninstall`.
```

### Busy: `stop` and `restart` wait for you

`service stop` and `service restart` first ask the service whether it's [busy](/reference/cli/#local-review-busy):
saving a comment or a description, taking a backup snapshot, or syncing with GitHub. If it is, they don't stop it.
Instead they say what's under way and exit 75:

```text
$ local-review service restart
local-review: Local Review is busy: 1 GitHub sync is running. Try again once it has finished (`local-review busy` says when), or restart it anyway with --force.
```

Those writes take a moment, so trying again usually just works. `--force` goes ahead regardless, and says what it
overrode (`Overriding: Local Review is busy: …`). Open pages don't count as busy: drafts live in the browser, and the
pages reconnect once it's back. `service uninstall` doesn't ask, since removing the service is a deliberate act.

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

Restarts it, for instance after an upgrade (below), unless it's [busy](#busy-stop-and-restart-wait-for-you). If the service's file is stale, it's rewritten first, keeping
the port and the environment it was installed with. A file is stale when an older Local Review wrote it (one from
before 0.14 logs to two files), or when the Node or `local-review` it names has gone. In that last case, it's pointed
at the `local-review` you ran and its Node.

### `service logs`

Prints the last 50 lines of the service's log, `logs/service.log` in the data home. `-n <lines>` prints more or fewer,
and `-f` keeps printing what it writes until you press Ctrl-C. Local Review writes that file itself on both OSes,
not the systemd journal, so it's the same command everywhere. A service installed before 0.14 writes `server.out.log`
and `server.err.log` instead. `service logs` shows both until `service restart` moves the service to the one file.
The old files are left where they are.

### `service uninstall`

Stops the service and removes its file. **Nothing else**: your data in `~/.local-review` (and its `logs/`) stays
exactly where it is, as the [never-delete guarantee](/guarantees/never-delete/) promises. Running it when there's no
service just says so. It works from npx too.

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
  there. Local Review rotates it itself, by copying and truncating, at 8 MB, keeping 3.

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

## Not from npx

`local-review service install` refuses to run from npx's cache, which npm can delete at any time: the service would
break at some later login, and it would stay on that one version. It refuses pnpm dlx, bunx and yarn dlx for the same
reason, writes nothing and says what to do instead:

```text
$ npx local-review service install
local-review: Local Review is running from npx's cache, which npm can delete at any time, so a service that runs it would break at some later login. Install it first: `npm i -g local-review`, then run `local-review service install` again.
```

## Not from a checkout, unless you mean it

From a clone of the repo, it refuses too: the service would run whatever the checkout last built, and break when it's
cleaned or rebuilt. If that's what you want (you're working on Local Review itself), build it and add
`--from-checkout`:

```sh
npm run build
npm run lr -- service install --from-checkout
```

## Updating

`local-review update` installs the latest version and restarts the service onto it, and if the new version doesn't
come up it puts the old one back: see [Updating](/getting-started/updating/). By hand, it's
`npm i -g local-review@latest` then `local-review service install --refresh`.

If you've changed Node since you installed the service (a new version through nvm, fnm or Homebrew), your global
packages may have moved with it. Run `local-review service install` again to point the service at the new ones; it
keeps the port and data home. `local-review service status` and `local-review doctor` warn when this is needed.

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
