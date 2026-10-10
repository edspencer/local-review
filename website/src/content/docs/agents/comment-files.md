---
title: Comment files
description: Your review lives in YAML files an agent can read and reply to.
---

Your review is plain YAML: one file per PR, with its threads, comments and Viewed marks. An agent reads it, replies by
appending a comment with `author: claude`, and resolves the threads it fully dealt with. The reply shows up in your
browser within about a second, and the threads follow their code when the agent amends or rebases the commits.

How to *behave* in a review (reply first, when to resolve, how to fix a commit mid-stack) is in the
[agent guide](/agents/agent-guide/#handling-review-threads). This page is the file-level recipe; the full schema is
[Comment files schema](/reference/comment-files/).

<!-- SHOT: agent-reply-live — a thread with the reviewer's comment and an `author: claude` reply that just arrived; crop to the thread -->

## A recipe for agents

1. **Find the file for a commit:** `~/.local-review/projects/<project>/reviews/<repo>/<full sha>.yaml`
   (`ls ~/.local-review/projects/` lists the projects). For example:

   ```sh
   ls ~/.local-review/projects/my-feature/reviews/my-service/$(git -C ~/code/my-service rev-parse me/my-feature).yaml
   ```

   Repo names are the `name` in `project.yaml` (default: the repo directory name). If there's no file under that sha
   but the commit was just rebased, its comments may still be in the old sha's file:
   `GET http://localhost:5622/api/projects/<project>/repos/<repo>/commits/<sha>/review` returns `file` (where they are
   now), `target_file` and `carried_over`. Either file can be edited; the server moves it on its next write.

2. **List the unresolved threads:** those with `resolved: false`, or no `resolved`. For example:

   ```sh
   npx yaml --json --single < ~/.local-review/projects/my-feature/reviews/my-service/<sha>.yaml \
     | jq '.threads[] | select(.resolved != true) | {id, path, line, last: .comments[-1].body}'
   ```

   Or just read the YAML. `path`/`side`/`line` say what's being discussed, on the file's `commit`. Use
   `git show <commit>` in the reviewed repo (read-only) for the code. If `outdated: true`, the code is gone from this
   commit, and `anchor.text` is what was commented on.

3. **Reply:** append a comment with `author: claude` to the thread's `comments` list:

   ```yaml
         - author: claude
           created: 2026-10-08T15:00:00Z   # optional
           body: |
             Good catch. Fixed in the next commit by …
   ```

4. **Add a new thread** if you need to: append to `threads`, with `path`/`side`/`line` for an inline comment or
   without them for a general one. Leave out `anchor`: the server computes it from `commit` on its next write.

5. **Don't change existing `id`s.** New comments and threads can leave out `id`: the server assigns one the next time
   it writes the file.

6. **Set `resolved: true` to resolve a thread** (or `false` to reopen it).

7. **Keep the file valid YAML.** If it fails to parse, the UI shows an error and the server refuses to overwrite it
   until it's fixed, so nothing is lost. Write the whole file at once (or via a temp file and a rename).

The server watches `~/.local-review/projects/` and pushes changes to the browser over Server-Sent Events
(`/api/events`), so edits appear within about a second. Fields the server doesn't know about are kept. Missing `id`,
`created`, `resolved` or `author` fields are tolerated: an unknown author shows as "unknown".

:::tip[Server running? Use the API]
While the server runs, the [HTTP API](/reference/http-api/) does the same with no YAML to get wrong:
`POST …/threads/<tid>/comments` with `{"author":"claude","body":"…"}` to reply, `PATCH …/threads/<tid>` with
`{"resolved":true}` to resolve.
:::

## Concurrent edits

You and an agent can work on the same file at the same time without losing anything.

- **The UI never sends a whole file.** Every UI action (a new thread, a reply, resolve, edit, delete, Viewed) is an
  operation that the server applies to a fresh read of the file from disk.
- **Writes are serialised per file and atomic** (a temp file, then a rename).
- **Just before writing, the server re-reads the file.** If it changed since it was read (an agent saved it), the
  operation is re-applied to the new contents and retried, so an agent's reply saved a moment before the UI's write is
  kept.
- **A file that is briefly invalid YAML** (caught mid-save) is retried for a fraction of a second before the server
  gives up and refuses to write (HTTP 409; the file is left exactly as it is).
- **The server never deletes or truncates a review file.** The only rename is the `.superseded-by-…bak` one after a
  rebase re-match, and the only comment deletion is the reviewer deleting their own comment in the UI. See the
  [never-delete guarantee](/guarantees/never-delete/).

## After an amend or rebase

A file is named after the sha it was written for. When the agent amends or rebases, the commit gets a new sha, and
the server finds the old file by patch-id, Change-Id or subject, shows its threads on the new commit, and moves the
file on its next write. Inline threads are re-placed by the text they were on. The rules are in
[Following rebases](/concepts/following-rebases/).

**Keep commit subjects stable** and unique: a fixup or amend changes the patch, so the subject is what carries the
comments across.
