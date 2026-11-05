---
'local-review': minor
---

**Scripts that wait for the startup line need updating.** `local-review` (serve) now prints `Local Review <version>: <url>` as the first line on stdout, as the [CLI contract](https://github.com/edspencer/cli-contract) has it. The projects directory is on the next line (`Projects: <dir>`). The old line was `Local Review on <url>  (projects: <dir>)`. Match `^Local Review [^:]+: (http\S+)` instead. The server's log lines (`[backups] snapshot …`) now go to stderr, and so does the LOCAL REVIEW banner, which still shows in a terminal. `--quiet` prints only the new first line.

**`local-review busy [--json]`** asks the running Local Review whether a restart now would cut something short: a save, a backup snapshot or a GitHub sync. It exits 0 when it isn't busy, 75 when it is, and 3 when nothing is running. The server answers `GET /api/busy` with counts only, and `serve` writes `<data>/runtime.json` (its pid, port, URL and version) so the CLI can find it, removing the file when it exits. On SIGTERM it lets work under way finish first, for up to 5 seconds.

**`service stop` and `service restart` refuse, with exit 75, while it's busy.** Add `--force` to go ahead anyway; it says what it overrode. Before this, they never refused. `service status` shows whether it's busy, and its `--json` gains `runningVersion`, `unit` and `busy`.

On macOS, a restart now waits for launchd to finish unloading the service before it loads it again, so it no longer fails with `launchctl bootstrap … 5: Input/output error`.
