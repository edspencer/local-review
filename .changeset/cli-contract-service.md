---
"local-review": minor
---

`local-review service start`, `service stop` and `service logs [-f] [-n <lines>]`, and `--data-dir <path>`, following the shared CLI contract (SPEC 0.1).

- **`service stop`** stops the service until `service start` or your next login. It doesn't disable it, so it stays installed (`service uninstall` removes it). **`service start`** starts it again and waits until it answers.
- **`service logs`** prints the end of the service's log, which is now one file, `<data>/logs/service.log`, for stdout and stderr both. A service installed by an earlier version writes `server.out.log` and `server.err.log`. `service logs` reads those, and `service restart` moves the service to the one file. More generally, `restart` now rewrites a stale service file first: an older version's, or one whose Node or `local-review` has gone. It keeps the port and the environment. The old log files are left in place.
- **Changed exit codes.** `service status` (with or without `--json`) used to exit 0 every time. It now exits **0** when the service is running and answering, **3** when it's installed but not running or not answering, and **4** when it isn't installed. `service restart` with no service installed now exits **4** (it was 1). `start`, `stop` and `logs` exit 4 likewise. Scripts that ran `service status` and expected 0 need updating.
- `service status` shows the installed version, and its `--json` gains `version` (the version answering), `installedVersion` and `log`. That replaces `logs: {out, err}`. It warns when the version answering isn't the one installed.
- `GET /api/health` now answers `{ok: true, version}`.
- `--data-dir <path>` sets the data home for one command, as `LOCAL_REVIEW_HOME` does (which still works).
