---
"local-review": patch
---

The first page load after a restart is much faster. What git says about each commit (subject, author, changed files, merge-bases, ancestry, patch-ids) is now kept in `~/.local-review/cache/`, so a restart needs a couple of dozen git processes rather than several per commit: 403 down to 27 on a 13-range setup. The cache is disposable: delete it any time.
