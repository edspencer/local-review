---
'local-review': patch
---

**The service's log is rotated.** `serve` now rotates `<data>/logs/service.log` itself, when it starts and every 15
minutes: past 8 MB it's copied to `service.log.1` and truncated in place (launchd and systemd keep it open), older
copies shift down, and three are kept, `service.log.1` to `.3`. Until now it grew without limit. You'll see the
numbered copies next to it in `logs/` once it passes 8 MB; a foreground `local-review` has no service log and does
nothing.

**A first `service install` the service manager refuses no longer leaves a unit behind.** When systemd refuses to
reload, enable or start it, or launchd refuses to bootstrap it, `install` still fails (exit 1, with the reason), but it
now removes the unit or LaunchAgent it had just written, so `service status` says it isn't installed (exit 4) rather
than installed and not running, and the next login doesn't try it again. A reinstall that's refused keeps the unit it
had.
