---
title: Where your data lives
description: The ~/.local-review directory, its layout, automatic snapshots and how to restore from them.
---

Everything you create (projects, PR title and description overrides, review comments, Viewed marks) lives in plain
files in a dot-directory in your home, like `~/.claude`. It is never in the repos you review and never in Local
Review's own install, so Local Review can be updated or reinstalled without touching anyone's reviews. It isn't
version-controlled; [snapshots](#snapshots) cover that.

```text
~/.local-review/                        # or $LOCAL_REVIEW_HOME
  projects/
    <slug>/                             # one per project; the slug is used in URLs: /<slug>/<repo>/<sha>
      project.yaml                      # which repos and commits, and how they're split into PR stacks
      prs/<repo>/<full-sha>.yaml        # optional PR title/description overrides, readiness, branch, GitHub PR, landed
      reviews/<repo>/<full-sha>.yaml    # review comments and Viewed marks
  backups/
    2026-10-09T08-45-12Z/               # automatic snapshots: a plain copy of projects/ at that time (UTC)
```

| File | Written by | Reference |
| --- | --- | --- |
| `project.yaml` | you (`local-review init` creates it), an agent, and the UI for the intro and stack notes | [project.yaml](/reference/project-yaml/) |
| `prs/<repo>/<sha>.yaml` | the UI (title, description, Draft/Ready) and an agent (branch, GitHub PR, landed) | [PR files schema](/reference/pr-files/) |
| `reviews/<repo>/<sha>.yaml` | the UI (your comments, Viewed) and an agent (its replies) | [Comment files schema](/reference/comment-files/) |

Every file under `projects/` is re-read on each request and watched, so edits from an agent or an editor show up in
the browser within about a second, with no restart.

**Getting started:** `npx local-review init my-feature` creates `~/.local-review/projects/my-feature/project.yaml`
from a commented example (it never replaces an existing one); then edit it. With no projects, the UI says the same.

## Moving it

`LOCAL_REVIEW_HOME` moves the whole data directory, e.g. for a scratch instance next to your real one:

```sh
LOCAL_REVIEW_HOME=/tmp/lr-demo npx local-review --port 5050
```

`LOCAL_REVIEW_PROJECTS_DIR` moves only `projects/`. It's for the tests, and it turns automatic snapshots off unless
`LOCAL_REVIEW_HOME` is set too. See [Environment variables](/reference/environment/).

## Snapshots

When the server starts, and then every hour while it runs, it copies `projects/` to `backups/<timestamp>/` (with file
times preserved), but only if something changed since the newest snapshot.

- A snapshot is copied under a hidden `.partial-…` name and renamed when complete, so every timestamped directory is
  a full copy.
- It keeps the **50 most recent** snapshots, plus the **first snapshot of each day for 30 days**.
- Pruning only ever removes directories directly inside `backups/` whose names are snapshot timestamps (not
  symlinks, not anything else you put there), and never the newest.

That pruning is the only deletion Local Review ever does; see the [never-delete guarantee](/guarantees/never-delete/).

## Restoring

Restoring is copying files back, by hand. Stop the server first if you're restoring a lot. For example:

```sh
ls ~/.local-review/backups/                                       # pick a snapshot
diff -r ~/.local-review/backups/<timestamp>/<slug> ~/.local-review/projects/<slug>
cp -p ~/.local-review/backups/<timestamp>/<slug>/reviews/<repo>/<sha>.yaml ~/.local-review/projects/<slug>/reviews/<repo>/
```

Deleting a comment in the UI (you can only delete your own) removes it from the file, as you'd expect; the previous
version is in the snapshots.
