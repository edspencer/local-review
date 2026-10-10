---
title: HTTP API
description: The local HTTP API the UI and your agent share.
---

The UI is a client of a small HTTP API on the same port, and an agent can use it too. Prefer it to editing files
while the server runs: its writes are atomic and are merged with concurrent edits
([how](/agents/comment-files/#concurrent-edits)). It answers on `http://localhost:5622` only, and only to localhost
requests; writes must be JSON, except an image upload, whose body is the image (see
[Localhost security](/guarantees/localhost-security/)).

```sh
P=my-feature; R=my-service; SHA=0a1b2c3d     # a short or full sha
BASE=http://localhost:5622/api/projects/$P/repos/$R/commits/$SHA
J='Content-Type: application/json'

curl -s $BASE/review | jq '.threads[] | select(.resolved != true)'                       # open threads
curl -s -X POST -H "$J" $BASE/threads/<tid>/comments -d '{"author":"claude","body":"…"}'   # reply
curl -s -X PATCH -H "$J" $BASE/threads/<tid> -d '{"resolved":true}'                       # resolve
curl -s -X PUT -H "$J" $BASE/pr -d '{"title":"…","body":"…"}'                           # null clears a field
curl -s -H 'Content-Type: image/png' --data-binary @shot.png \
  "http://localhost:5622/api/projects/$P/assets?alt=Screenshot" | jq -r .markdown          # add an image
```

More recipes are in the [agent guide](/agents/agent-guide/#api-httplocalhost5622).

## Endpoints

`…` below is `/api/projects/:p/repos/:r/commits/:sha`, where `:sha` is a short or full sha.

| Method | Path | |
| --- | --- | --- |
| GET | `/api/projects` | Projects: slug, title, repo names/count, commit count (`commitCount`, without follow-on stacks and merged PRs; `followOnCount`, `mergedCount`), `archived`, unresolved count, last modified; plus `projectsDir` and `home` (the user's home directory, so a client can show paths as `~/…`). |
| GET | `/api/projects/:p` | `description`, repos (range, errors, warnings), `stacks` (title, color, commit shas, warning, `description`, `follow_on: true` on follow-on stacks, `weight`), commits (+/−, `position`, `stack` index, PR `title`, unresolved counts, `branch`, `github`, `status`, `progress`, `landed` on landed PRs: the record plus `diff`, and `tip`/`parent`: what's diffed). |
| PUT | `/api/projects/:p/description` | `{description: string \| null}`: the project intro (null or blank removes it). |
| PUT | `/api/projects/:p/repos/:r/stacks/:n/description` | `{description, title?}`: stack `n`'s note (1-based in `stacks:`). A `title` that no longer matches is a 409. |
| POST | `/api/projects/:p/assets` | Upload an image: the body is the image itself, with its type as the `Content-Type` (`image/png`, `image/jpeg`, `image/gif`, `image/webp` or `image/svg+xml`), up to 5 MB. Optional `?alt=<text>`. Returns `{name, markdown, created}` (201; 200 with `created: false` if the same image was already there). See [Images](/reference/data-directory/#images). |
| GET | `/api/projects/:p/assets/:name` | An image, by its `<hash>.<ext>` name (anything else is a 404). Served with its type, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, so an SVG opened directly can't run script. |
| GET | `…` | Metadata (including `branch`, `github`), message body, files with old/new contents, `stack` (with position/count), project-wide `prev`/`next`, `pr`, review. |
| GET | `…/review` | The review: the file's contents with threads placed on this commit (`outdated`, relocated `line`), plus `file`, `target_file` (absolute paths), `matched_from`, `matched_by`, `carried_over`, `parse_error`. |
| GET | `…/pr` | `{title, body, title_source, body_source: 'commit'\|'override', commit_subject, commit_body, branch, github, file, …}` |
| PUT | `…/pr` | `{title?, body?, branch?, github?, status?}`. `null` clears a field; `status` is `"draft"`, `"ready"` or `null`. See [PR files](/reference/pr-files/#writing-it). |
| POST | `…/threads` | New thread: `{body, path?, side?, line?, start_line?, start_side?, author?}`. Without `path`/`side`/`line` it's a general thread. |
| POST | `…/threads/:tid/comments` | Reply: `{body, author?}`. |
| PATCH | `…/threads/:tid` | `{resolved}`. |
| PATCH / DELETE | `…/threads/:tid/comments/:cid` | Edit `{body}` / delete. Only the reviewer's own comments: an agent's are never edited or deleted by the UI. |
| PUT | `…/viewed` | `{path, viewed}`: tick or untick a file's **Viewed** box. |
| GET | `…/stack.svg`, `…/stack.png` | The [stack picture](/using/stack-pictures/) with this PR highlighted. See below. |
| GET | `/api/projects/:p/stack.svg`, `…/stack.png` | The same for the whole project, nothing highlighted (as on the homepage). |
| GET | `/api/me` | The reviewer: `{id, name}` (see [`LOCAL_REVIEW_USER`](/reference/environment/#local_review_user-the-reviewer)). |
| GET | `/api/health` | `{ok: true}`. |
| GET | `/api/events` | Server-Sent Events, below. |

### Commit fields

Each commit in `GET /api/projects/:p` (and the commit endpoint) carries:

- **`status`**: `draft`, `ready`, `published` or `merged`. See [Readiness](/concepts/readiness/).
- **`progress`**: `{threads, resolved, files, viewed}`: conversations (threads with at least one comment, outdated
  ones included) and how many are resolved, files changed and how many are marked Viewed.
- **`branch`**: `{name, status: 'ok'|'moved'|'missing'|'discovered'|'merged', points_at?, discovered: string[]} |
  null`. See [Branches](/concepts/branches/).
- **`github`**: `{number, url, branch?, base?, created?, stack?, stacked_on?} | null`. `url` is `''` if the file
  gives only a number.

### Stack picture options

The SVG is 680px wide; the PNG is drawn at 2x (1360px).

| Query | |
| --- | --- |
| `?scope=project` (default), `repo`, `stack` | What's in the picture. Only on the per-commit endpoint. |
| `?scale=sqrt` (default), `linear` | How the +/− bars scale. |
| `?title=0` | Drop the project heading and summary line. |
| `?download` | Add `Content-Disposition: attachment`. |

### Events

`GET /api/events` is a Server-Sent Events stream. The server watches `~/.local-review/projects/` and sends:

```json
{"type": "review", "project": "my-feature", "repo": "my-service", "sha": "…"}
{"type": "pr", "project": "my-feature", "repo": "my-service", "sha": "…"}
{"type": "project", "project": "my-feature", "reason": "…"}
{"type": "projects", "reason": "…"}
```

The UI uses it to refresh, so edits to the files (by an agent or an editor) show up within about a second.

## Errors

Errors are JSON, `{"error": "…"}`, with a status code:

- **400**: a malformed request: not JSON, a missing `body`, a `status` other than `draft`/`ready`/`null`, an
  ambiguous short sha, an empty upload.
- **403**: a `Host` (or, on a write, an `Origin`) that isn't localhost. See
  [Localhost security](/guarantees/localhost-security/).
- **404**: no such project, repo, thread or comment, or a sha that isn't in the repo's range (it may have been
  rebased away: look it up again in `GET /api/projects/:p`).
- **409**: the file isn't valid YAML, so the server won't overwrite it until it's fixed by hand (nothing is lost); or
  a stack note's `title` guard no longer matches.
- **413**: an upload over 5 MB. It's refused from its `Content-Length`, or as soon as a streamed body passes the
  limit, before being stored.
- **415**: a write (other than `DELETE`) without `Content-Type: application/json`; on an upload, a `Content-Type`
  that isn't one of the image types, or contents that don't match it (`the file says it's PNG but its contents are
  JPG`).
