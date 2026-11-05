---
'local-review': minor
---

**`local-review update`** updates Local Review to the latest version on npm and restarts the service onto it. It asks first (`--yes` answers; without a terminal `--yes` is needed, or it exits 2), refuses while Local Review is busy (exit 75, `--force` to go ahead), and if the new version doesn't come up it puts the old one back and exits 6 (7 if even that fails, with the commands to run by hand). `--check` only reports, and `--to <version|tag>` picks a version, including a lower one. A copy it can't update itself (npx, a source checkout, a project's dependency, a global folder you can't write) prints the command to run instead and exits 5. `upgrade` works too. It's the only thing in Local Review, with `doctor`, that asks npm for a version, and only when you run it. See [Updating](https://local-review.edspencer.net/getting-started/updating/).

**`local-review doctor [--json] [--offline]`** checks the install: Node against what Local Review needs, how it was installed, the service (whether the Node and `local-review` it runs are still there), that the running version is the installed one, the port, linger on Linux, the data home, git and gh, and whether there's a newer version (`--offline` skips that). It prints a fix under each problem and exits 1 if a check failed.

**`local-review service install --refresh`** rewrites the installed service in this version's format from what it was installed with (port, data home, environment), not from your shell, and restarts it. It exits 4 if nothing is installed.

**`service install` over a running service now restarts it**, so it never leaves the old process serving; before, an unchanged service file left it alone. `service status` repeats what the last `update --check` or `doctor` found (in its `--json`, as `update`), without asking npm. On Linux, `service start` and `restart` clear a unit's failed state first, so one that hit systemd's start limit comes back. On macOS, a service start retries launchd's "operation already in progress" (37) as well as error 5.

**Scripts:** a flag a command can't use is a usage error (exit 2), as before; `update` adds exit codes 5, 6 and 7.
