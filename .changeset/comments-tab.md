---
"local-review": minor
---

The project and stack pages have a **Comments** tab: every comment thread on every PR there (in all repos and stacks
on the project page, and published or not), general and inline alike. Open threads come first, then the most recently
updated. Each thread says which PR it's on and, if it's inline, its `file:line`, which opens Files changed scrolled to
that thread. Resolved and outdated threads start folded, as in Files changed. You can reply, resolve, edit and delete
there, and the list and the tab's counter of open threads update live. A PR page now takes `?thread=<id>` to jump to a
thread and open it. New, read-only: `GET /api/projects/:p/threads` (`?repo=<name>&stack=<ref>` for one stack).
