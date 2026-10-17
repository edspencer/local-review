---
"local-review": minor
---

`local-review service install | uninstall | status | restart` runs Local Review in the background, started at login
and restarted if it exits: a launchd LaunchAgent on macOS (`~/Library/LaunchAgents/local-review.server.plist`), a
systemd user unit on Linux (`~/.config/systemd/user/local-review-server.service`). The service runs the installed
`local-review` and the Node that installed it, by absolute path, with a `PATH` that must find git, on 127.0.0.1 only,
with an optional `--port` and the `LOCAL_REVIEW_HOME` / `LOCAL_REVIEW_USER` set at install. Its output goes to
`logs/` in the data home. Running `install` again rewrites it and keeps its port and environment unless given new
ones; `--dry-run` prints the file and does nothing. It refuses to run from npx's cache (and pnpm dlx's, bunx's, yarn
dlx's) or from a source checkout (unless `--from-checkout`), saying what to do instead. `uninstall` removes the
service's file and nothing else. Windows isn't supported: it says so and does nothing.
