---
"local-review": patch
---

Display fixes:

- A PR title or description written into a prs file that matches the commit message (ignoring whitespace) no longer
  shows as "edited", and `local-review plan` no longer says "(edited)" for it. The file itself isn't changed.
- Tabs in code in the Conversation tab (code blocks in comments and descriptions, and the code under inline
  threads) are now as wide as in the Files changed diff, instead of 8 columns.
- A repo whose PRs have all merged is labelled **merged** on the project homepage and in the stack picture, as it
  already was in the sidebar, instead of with its base branch (for example `origin/main`).
- Paths under your home directory are shown as `~/…`, for example `~/.local-review/projects/…`. The API still returns
  absolute paths, and now always does: they used to be relative to Local Review's own directory when your data was
  inside it. `GET /api/projects` also returns `home`, the home directory the UI shortens paths against.
