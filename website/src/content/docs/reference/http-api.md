---
title: HTTP API
description: The local HTTP API the UI and your agent share.
---

The UI is a client of a small HTTP API on the same port, and an agent can use it too. Prefer it to editing files
while the server runs: its writes are atomic and are merged with concurrent edits
([how](/agents/comment-files/#concurrent-edits)). It answers on `http://localhost:5622` only, and only to localhost
requests; writes must be JSON, except an image upload, whose body is the image, and a `DELETE`, which has none (see
[Localhost security](/guarantees/localhost-security/)).

```sh
P=my-feature; R=my-service; SHA=0a1b2c3d     # a short or full sha
BASE=http://localhost:5622/api/projects/$P/repos/$R/commits/$SHA
J='Content-Type: application/json'

curl -s $BASE/review | jq '.threads[] | select(.resolved != true and .publish != true)'   # open threads
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
| GET | `/api/projects` | Projects: slug, title, `description`, `error` (a `project.yaml` that can't be read), repo names/count (`repoCount`), `branches`, commit count (`commitCount`, without follow-on stacks and merged PRs; `followOnCount`, `mergedCount`), `totals` (the [aggregate](/concepts/pr-stacks/#totals): `stacks`, `prs`, `additions`, `deletions`, with `followOn` and `merged` beside them), `readiness` (PRs by status, follow-on stacks left out: `{draft, ready, published, merged}`), `archived`, `example`, unresolved count, `modified` (the newest write to any of its files), `activity` (`{at, kind}`: the newest `comment`, live `commit` (author date), `merged` (`landed.at`) or file write, `edit`), `thumb` (the thumbnail's version), `after` and `next` ([linked projects](/concepts/linked-projects/): the predecessor's slug or null, the successors' slugs), `warnings` (project-level, e.g. a bad `after:`); plus `newExamples` (example projects new in this version, not added yet), `exampleCount` (how many example projects there are), `projectsDir`, `home` (the user's home directory, so a client can show paths as `~/…`) and `examples`: `present`, `removed` (removed earlier, restorable) or `none`. |
| POST | `/api/examples` | `{}`: add the [example projects](/reference/cli/#local-review-examples-remove) (create, restore removed ones, leave existing ones). Returns `{created, restored, existing, removed}` (slugs); 201 if it created any, else 200; 409 if a project of yours has an example's name. The git work doesn't block the server; a second request while one is running gets the same result. |
| POST | `/api/examples/remove` | `{}`: remove them (rename each `project.yaml` to a `.bak`; nothing deleted). Returns the same shape; 409 while they're still being added. |
| GET | `/api/projects/:p/thumb.svg` | The root page's thumbnail of the project (a lane per repo, a bar per PR; see [the root page](/using/ui-tour/#the-root-page)), 280×150, or `?w=<200–800>` wide (the card's width, so it's never scaled), light or dark with the page. `ETag` is the list's `thumb` (at the default width), with `Cache-Control: no-cache`, so a revisit is a 304; same CSP as the stack pictures. |
| GET | `/api/projects/:p` | `slug`, `title`, `file` (its `project.yaml`), `error`; `after` (`{slug, title}` or null) and `next` (`[{slug, title}]`): [linked projects](/concepts/linked-projects/); `warnings` (project-level); `description`, repos (range, errors, warnings, `after`: the predecessor's range end in this repo or null, `startsAfter`: whether the range starts there), `stacks` (title, color, commit shas, warning, `description`, `follow_on: true` on follow-on stacks, `weight`; `number`, the 1-based position in `stacks:` that stack URLs use, null for an implicit group, which has `implicit: 'unstacked'|'branch'` instead), commits (+/−, `position`, `stack` index, PR `title`, unresolved counts, `branch`, `github`, `status`, `progress`, `landed` on landed PRs: the record plus `diff`, and `tip`/`parent`: what's diffed). |
| GET | `/api/projects/:p/threads` | Every thread with a comment in it, on every PR of the project (all repos and stacks, every commit in the range, published or not), as the [Comments tab](/using/ui-tour/#the-comments-tab) lists them: open threads first, then by last update, newest first. `?repo=<name>` keeps one repo's PRs, and `?repo=<name>&stack=<ref>` one stack's (`:ref` as in the stack picture's URL below). Returns `{threads, problems}`. Each of `threads` is `{repo, sha, position, thread, updated}`: the PR's full sha and its 1-based position in its repo, the thread as `…/review` gives it (placed on that commit, `outdated` set, carried over after a rebase), and `updated`, its newest comment or reply, written or edited (ISO, or null). `problems` are review files that aren't valid YAML, whose threads are left out: `{repo, sha, file, error}`. Read-only. 400 for `?stack=` without `?repo=` or a malformed ref, 404 for no such repo or stack. |
| PUT | `/api/projects/:p/description` | `{description: string \| null}`: the project intro (null or blank removes it), up to 256 KB. Returns `{description, file}`. |
| PUT | `/api/projects/:p/repos/:r/stacks/:n/description` | `{description, title?}`: stack `n`'s note (1-based in `stacks:`). A `title` that no longer matches is a 409. Returns `{description, title, file}`; 404 for no such stack. |
| POST | `/api/projects/:p/assets` | Upload an image: the body is the image itself, with its type as the `Content-Type` (`image/png`, `image/jpeg`, `image/gif`, `image/webp` or `image/svg+xml`), up to 5 MB. Optional `?alt=<text>`. Returns `{name, markdown, created}` (201; 200 with `created: false` if the same image was already there). See [Images](/reference/data-directory/#images). |
| GET | `/api/projects/:p/assets/:name` | An image, by its `<hash>.<ext>` name (anything else is a 404). Served with its type, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, so an SVG opened directly can't run script. |
| GET | `…` | `project`, `projectTitle`, `repo`, `repoPath`, `branch` (the range's end, a string), `index`, `total`; `commit`: metadata (including its `branch` record, `github`, `status`, `landed`), message body, files with old/new contents, `stack` (with position/count), project-wide `prev`/`next`, `pr`, review. |
| GET | `…/review` | The review: the file's contents with threads placed on this commit (`outdated`, relocated `line`), plus `file`, `target_file` (absolute paths), `matched_from`, `matched_by` (set while the comments are still in an earlier commit's file), `carried_over` (`{from, by, saved}`, or null: the review came from an earlier commit after a rebase, and whether it's saved under this sha yet; the PR page shows it as a note), `parse_error`. |
| GET | `…/pr` | `{title, body, title_source, body_source: 'commit'\|'override', commit_subject, commit_body, branch, github, file, …}` |
| PUT | `…/pr` | `{title?, body?, branch?, github?, status?}`. `null` clears a field; `status` is `"draft"`, `"ready"` or `null`. See [PR files](/reference/pr-files/#writing-it). |
| POST | `…/threads` | New thread: `{body, path?, side?, line?, start_line?, start_side?, author?, publish?}`. Without `path`/`side`/`line` it's a general thread. `publish: true` marks it for the GitHub PR ([Threads for the GitHub PR](/reference/comment-files/#threads-for-the-github-pr)). |
| POST | `…/threads/:tid/comments` | Reply: `{body, author?}`. |
| PATCH | `…/threads/:tid` | Any of `{resolved: true \| false}`; `{publish: true \| false}` (mark it for the GitHub PR, or not: the reviewer's call); `{published: {url, id?, at?} \| null}` (the agent's record of the GitHub comment it posted: an http(s) `url`, the comment's `id`, `at` defaulting to now; null clears it). 400 for anything else in those fields. |
| PATCH / DELETE | `…/threads/:tid/comments/:cid` | Edit `{body}` / delete. Only the reviewer's own comments: an agent's are never edited or deleted by the UI. |
| PUT | `…/viewed` | `{path, viewed}`: tick or untick a file's **Viewed** box. |
| GET | `…/stack.svg`, `…/stack.png` | The [stack picture](/using/stack-pictures/) with this PR highlighted. See below. |
| GET | `/api/projects/:p/stack.svg`, `…/stack.png` | The same for the whole project, nothing highlighted (as on the project page). |
| GET | `/api/projects/:p/repos/:r/stacks/:ref/stack.svg`, `…/stack.png` | Just one stack, nothing highlighted (as on its stack page). `:ref` is the stack's number in `stacks:`, optionally with its title as a slug (`2-groundwork`), or `unstacked` / `branch`, resolved like the [stack page's URL](/using/ui-tour/#urls) (a reordered list follows the title). `?title=0`, `?scale=linear` and `?download` as below; no `scope`. 400 for a malformed ref, 404 for no such stack. |
| GET | `/llms.txt` | For coding agents: how to set up a project, with this server's data directory, existing projects and URLs ([llms.txt](/agents/llms-txt/)). `text/plain`, `Cache-Control: no-store`. |
| GET | `/llms-full.txt` | The same, followed by the whole [agent guide](/agents/agent-guide/). |
| GET | `/agent-guide.md` | The agent guide on its own (`text/markdown`), with this server's URLs. |
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
| `?context=1` | A [linked project](/concepts/linked-projects/) (project and PR pictures): draw the predecessor's stacks first in each shared repo, greyed out, unnumbered, out of the totals. |
| `?download` | Add `Content-Disposition: attachment`. |

### Events

`GET /api/events` is a Server-Sent Events stream. The server watches `~/.local-review/projects/` and polls each
repo's branches every 2 seconds. It sends an `event: hello` first, then each change as an `event: change` whose data
is one of these (so listen with `addEventListener('change', …)`; `onmessage` sees nothing), and a comment line every
25 seconds to keep the connection open:

```json
{"type": "review", "project": "my-feature", "repo": "my-service", "sha": "…"}
{"type": "pr", "project": "my-feature", "repo": "my-service", "sha": "…"}
{"type": "project", "project": "my-feature", "reason": "…", "repo": "my-service"}
{"type": "projects", "reason": "…"}
```

`reason` is `config` (`project.yaml`), `dir`, `reviews`, `prs`, `head` or `refs` (a repo's branches moved; with
`repo`), or `examples`. The UI uses it to refresh, so edits to the files (by an agent or an editor) show up within about a second.

## Errors

Errors are JSON, `{"error": "…"}`, with a status code:

- **400**: a malformed request: not JSON, a missing `body`, a `status` other than `draft`/`ready`/`null`, a sha that
  isn't hex or an ambiguous short one, a bad `author`, `path`, `line` or `start_side`, a branch name git wouldn't
  accept, a malformed `github`, a bad stack number or ref, a text over its size limit, an empty upload.
- **403**: a `Host` (or, on a write, an `Origin`) that isn't localhost (see
  [Localhost security](/guarantees/localhost-security/)); or editing or deleting a comment that isn't the reviewer's.
- **404**: no such project, repo, stack, asset, thread or comment, or a sha that isn't in the repo's range (it may have been
  rebased away: look it up again in `GET /api/projects/:p`).
- **409**: the file isn't valid YAML, so the server won't overwrite it until it's fixed by hand (nothing is lost); or
  a stack note's `title` guard no longer matches; or the example projects can't be added or removed (a project of
  yours has an example's name, or they're still being added); or an image upload whose name is taken by different
  contents.
- **413**: an upload over 5 MB. It's refused from its `Content-Length`, or as soon as a streamed body passes the
  limit, before being stored.
- **415**: a write (other than `DELETE`) without `Content-Type: application/json`; on an upload, a `Content-Type`
  that isn't one of the image types, or contents that don't match it (`the file says it's PNG but its contents are
  JPG`).
- **500**: anything else, with the message.
