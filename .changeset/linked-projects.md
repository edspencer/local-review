---
'local-review': minor
---

Linked projects: a project can say it builds on another with `after: <slug>` in its `project.yaml`. In a repo both
review, its range then starts where the other one's ends (while that's still an ancestor of its branch, and at its
`base` again once the first has merged and it's been rebased), and `local-review plan` bases its first PR there on the
other project's top PR. Local Review warns when the link doesn't hold, e.g. a squash-merged predecessor whose commits
are still in the range. Linked projects are shown together on the root page, linked from each other's project pages,
the sidebar, breadcrumbs and the project switcher, and the stack picture can draw the predecessor's stacks too,
greyed out (**Show …**, or `?context=1`).

New: `local-review move <from> <to> <repo> (<sha>… | --stack <n>)` moves PRs' review data (prs and reviews files)
from one project to another, for splitting a project: it copies, never over an existing file, and renames the
originals to `.bak`, after a snapshot.

The example projects gain **Calendar reminders**, which builds on **Calendar feed**. If you already have the
examples, **Add the new example project** (on the root page's Examples heading or in the project switcher, or
`local-review examples`) adds just that one.
