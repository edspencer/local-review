---
title: Comment files schema
description: The schema of reviews/<repo>/<sha>.yaml.
---

Each PR's review (its threads, comments and Viewed marks) is one YAML file. How an agent reads and replies to one is
on [Comment files](/agents/comment-files/); this page is the schema.

**Location:** `~/.local-review/projects/<project>/reviews/<repo>/<full-40-char-sha>.yaml` (or under
`$LOCAL_REVIEW_HOME`; see [Where your data lives](/reference/data-directory/)), never in the reviewed repo. One file
per commit, created on the first comment or Viewed toggle. The UI shows the file it is reading at the bottom of each
Conversation tab.

## Schema

```yaml
repo: my-service                    # repo name in project.yaml
repo_path: /home/you/code/my-service
branch: me/my-feature
commit: 0123456789abcdef0123456789abcdef01234567   # full sha this file belongs to; all `line`s refer to it
patch_id: f00dfeed1234…             # `git patch-id --stable` of the commit (for re-matching after a rebase)
change_id: I8f3c…                   # the commit's Change-Id trailer, only if it has one
subject: "Add the feature flag"
previous_commits: [89abcdef…]       # only after a rebase re-match: earlier shas, oldest first
matched_by: subject                 # how the last re-match was made: patch-id | change-id | subject
viewed: [src/index.ts]              # files marked "Viewed"
threads:
  - id: t-1a2b3c4d
    path: src/flags/parser.ts           # omit path (and side/line) for a general conversation thread
    side: right                         # right = line in the NEW file, left = line in the OLD file
    line: 12                            # 1-based line on that side, on `commit` (the last line of a range)
    start_line: 10                      # optional, first line of a multi-line range
    start_side: left                    # optional, only for a range that starts on the OTHER side (see below)
    resolved: false
    outdated: true                      # server-maintained, only present when true (see below)
    anchor:                             # server-maintained: where the thread was made. Never edit.
      commit: 89abcdef…                 # sha it was made on
      path: src/flags/parser.ts
      old_path: src/flags/parse.ts      # only if the file was renamed in that commit
      side: right
      line: 9
      start_line: 7
      before: |-                        # up to 3 lines before the commented lines (absent at line 1)
        …
      text: |-                          # the exact commented lines, start_line..line
        …
      start_side: left                  # only for a mixed-side range; then `text` is just the `line` line
      start_text: …                     # and this is the text of `start_line` on `start_side`
      after: |-                         # up to 3 lines after
        …
    comments:
      - id: c-5e6f7a8b
        author: ada                     # the reviewer's id or "claude"
        created: 2026-10-08T18:32:25Z
        body: |
          Markdown text.
```

## File fields

| Field | |
| --- | --- |
| `repo`, `repo_path`, `branch` | Which repo the file belongs to: its `name` in `project.yaml`, its path and its branch. A file whose `repo_path` is a different repo, and whose sha this repo doesn't have, is skipped when re-matching. |
| `commit` | The full sha this file belongs to. Every `line` in it refers to this commit. |
| `patch_id`, `change_id`, `subject` | What the file is re-matched by after an amend or rebase. Server-maintained; a hand-written file gets them from git. See [Following rebases](/concepts/following-rebases/). |
| `previous_commits`, `matched_by` | Written after a rebase re-match: the earlier shas, oldest first, and how the last match was made (`patch-id`, `change-id` or `subject`). |
| `viewed` | Paths of the files marked **Viewed**. |
| `threads` | The conversation threads, below. |

## Thread fields

| Field | |
| --- | --- |
| `id` | `t-…`. Never change one. A new thread can leave it out: the server assigns one on its next write. |
| `path`, `side`, `line` | Where an inline thread is, **on the file's `commit`**: `side: right` is a line in the new file, `left` in the old one; `line` is 1-based, and is the range's *last* line. Leave all three out for a general (conversation) thread. |
| `start_line`, `start_side` | A multi-line range's first line, and its side if that differs from `side` (below). |
| `resolved` | `true` or `false` (absent: unresolved). |
| `outdated` | Server-maintained, only present when `true`: the commented code is gone from this commit. |
| `anchor` | Server-maintained, never edit: where the thread was made, with the exact text and context. See [Line anchoring](/concepts/following-rebases/#line-anchoring-how-inline-threads-follow-the-code). |
| `comments` | The thread's comments, oldest first: `id` (`c-…`), `author`, `created`, `body` (Markdown). |

`author` is the reviewer's id (see [`LOCAL_REVIEW_USER`](/reference/environment/#local_review_user-the-reviewer)) or
`claude` for an agent. Missing `id`, `created`, `resolved` or `author` fields are tolerated; an unknown author shows as
"unknown". Fields the server doesn't know about are kept.

## Ranges across old and new lines

`side`/`line` is always the range's *last* line. A range on one side has `start_line < line` on that same side.

A range selected in the unified view from a deleted line down to an added line (or the other way round) also has
`start_side`: the side `start_line` is on. Then `start_line` and `line` are on different files, so no ordering between
the two numbers is implied. For example, `start_side: left, start_line: 12, side: right, line: 15` is "-12 to +15".
`start_side` is left out when it would equal `side`, and files without it read exactly as before.

## Validity

Keep the file valid YAML. If it fails to parse, the UI shows an error and the server refuses to overwrite it (HTTP
409) until it's fixed, so nothing is lost. Write the whole file at once, or via a temp file and a rename.
