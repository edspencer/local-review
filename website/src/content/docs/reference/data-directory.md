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
      assets/<hash>.<ext>               # images shown in descriptions, stack notes and the intro
      assets/<hash>.<ext>.yaml          # optional: where an image is published (url:), for plan
  backups/
    2026-10-09T08-45-12Z/               # automatic snapshots: a plain copy of projects/ at that time (UTC)
  examples/                             # only if you added the example projects
    orchard-<id>/                       # their git repos (made by Local Review; see below)
```

| File | Written by | Reference |
| --- | --- | --- |
| `project.yaml` | you (`local-review init` creates it), an agent, and the UI for the intro and stack notes | [project.yaml](/reference/project-yaml/) |
| `prs/<repo>/<sha>.yaml` | the UI (title, description, Draft/Ready) and an agent (branch, GitHub PR, landed) | [PR files schema](/reference/pr-files/) |
| `reviews/<repo>/<sha>.yaml` | the UI (your comments, Viewed) and an agent (its replies) | [Comment files schema](/reference/comment-files/) |
| `assets/<hash>.<ext>` | `local-review asset add`, and pasting, dropping or attaching an image in the UI | [Images](#images) |
| `assets/<hash>.<ext>.yaml` | `local-review asset url`, an agent or you | [Images](#images) |

Every file under `projects/` is re-read on each request and watched, so edits from an agent or an editor show up in
the browser within about a second, with no restart.

**The example projects** (`local-review examples`, or the button on the first-run page) are ordinary projects named
`projects/example-*`, with `example: true` in their `project.yaml`, reviewing four git repos that Local Review creates
under `examples/`. Removing them renames each `project.yaml` to `project.example-removed.yaml.bak`; nothing is deleted
([details](/reference/cli/#local-review-examples-remove)).

**Getting started:** `npx local-review init my-feature` creates `~/.local-review/projects/my-feature/project.yaml`
from a commented example (it never replaces an existing one); then edit it. With no projects, the UI's first-run page says the same, and offers the example projects.

## Images

A project's images live in its `assets/` folder. Markdown refers to them as `assets/<name>`, for example
`![Overview](assets/3f2a9c1e0b7d4a65.png)`, and the UI shows them in PR descriptions, stack notes and the project
intro (see [Images](/using/editing-pr-text/#images)).

- **Named by content.** The name is the first 16 hex digits of the file's SHA-256, plus `.png`, `.jpg`, `.gif`,
  `.webp` or `.svg`. Adding the same image twice is a no-op, and nothing else can be called that.
- **Checked.** PNG, JPEG, GIF, WebP and SVG only, up to 5 MB. The bytes must really be the type the file claims to be
  (by their magic numbers; an SVG must start with an `<svg` root element).
- **Written once.** An asset is created and never replaced or removed. Nothing in Local Review deletes one, even if
  no description uses it any more; delete unused ones by hand if you want the space back.
- **`<name>.yaml`** beside an image can record where it's published, as `url: https://…`. `local-review plan` then
  puts that URL in the PR bodies in place of `assets/<name>`, because GitHub can't show a file on your machine (see
  [Publishing](/agents/publishing-stacked-prs/#images)). Write it with `local-review asset url <project> <name> <url>`,
  or by hand; any other fields in it are kept.

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
- Images are **hard-linked** into a snapshot rather than copied (where `backups/` is on the same file system), so
  every snapshot shares one copy of each image on disk instead of adding up to 5 MB per image per hour. That's safe
  because an asset's name is its content and Local Review never changes one in place. Editing an asset file in place
  with another tool would change it in the snapshots too; don't (add the edited image as a new asset instead).

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
