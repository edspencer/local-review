---
title: PR files schema
description: The schema of prs/<repo>/<sha>.yaml.
---

A commit's PR title and description are its subject and body, unless `prs/<repo>/<full-sha>.yaml` says otherwise.
The same file holds the PR's readiness, its branch, the GitHub PR an agent created from it and, once it merged, what
landed. The reviewed repo is never touched: overrides live here, not in the commit.

**Location:** `~/.local-review/projects/<project>/prs/<repo>/<full-40-char-sha>.yaml` (or under `$LOCAL_REVIEW_HOME`).
One file per commit, created on the first override, Draft/Ready toggle or record.

## Schema

```yaml
commit: <full sha>
patch_id: <git patch-id --stable>   # server-maintained, for rebase re-matching
subject: <original commit subject>  # server-maintained, for rebase re-matching
title: Better PR title              # optional; absent or blank: the commit subject
body: |                             # optional; absent: the commit body (`description:` also works)
  Markdown.
status: ready                       # optional: draft (the default when absent) or ready; the reviewer's call
branch: me/feature-flag             # optional: the plain git branch an agent tagged this commit with
github:                             # optional: the GitHub PR created from it (recorded by the agent)
  number: 123                       # a number, "123" or "#123"; or derived from a .../pull/123 url
  url: https://github.com/<org>/<repo>/pull/123
  branch: me/feature-flag           # optional: the PR's head branch (wins over `branch:` for display)
  base: me/config-loader            # optional: the PR's base branch
  created: 2026-10-09T12:00:00Z     # optional
  stack: 12                         # optional, informational: the GitHub stack it's in
  stacked_on: me/config-loader      # optional, informational: the branch it was stacked on before GitHub retargeted it
landed:                             # optional: it merged on GitHub (frozen by the agent; see "Landed PRs")
  head: <full sha>                  # the PR's head at merge (headRefOid)
  base: <full sha>                  # the PR's base at merge (pull.base.sha / baseRefOid)
  commit: <full sha>                # the merge or squash commit
  method: merge                     # merge, squash or rebase
  at: 2026-10-09T12:00:00Z          # when it merged
updated: 2026-10-09T12:00:00Z
```

Hand-written files only need the fields they set.

## Fields

| Field | Notes |
| --- | --- |
| `commit`, `patch_id`, `subject` | Server-maintained, used to [follow the commit across rebases](/concepts/following-rebases/). For a landed PR, `subject:` is its stored subject, which [stack selectors](/concepts/pr-stacks/#how-starts_at-picks-a-commit) match. |
| `title` | The PR title. Absent or blank: the commit subject. A `title` identical to the commit subject (or a `body` identical to the commit body) counts as unedited. |
| `body` (or `description`) | The PR description, Markdown. Absent: the commit body. |
| `status` | `draft` (the default when absent) or `ready`. Case-insensitive (`Ready`, `READY`); any other value counts as absent. Setting it is the reviewer's call: see [Readiness](/concepts/readiness/). |
| `branch` | The plain git branch an agent tagged this commit with. See [Branches](/concepts/branches/). |
| `github` | The GitHub PR made from this commit. May also be just a PR number or url; one without a usable number is ignored. A usable `github:` record makes the PR **published**. |
| `landed` | What merged on GitHub. Shas must be full 40-hex (any case; others are ignored), and `method` is case-insensitive. The block counts once it has a `head` or a `commit`, and makes the PR **merged**. See [Landed PRs](/concepts/landed-prs/). |
| `updated` | When the server last wrote the file. |

Fields the server doesn't know about are kept.

## Writing it

Through the UI's editors (see [Editing PR titles & descriptions](/using/editing-pr-text/)), through the API, or by
editing the file. The API call is `PUT /api/projects/<p>/repos/<r>/commits/<sha>/pr` with any of
`{title?, body?, branch?, github?, status?}`:

```sh
curl -s -X PUT -H 'Content-Type: application/json' \
  http://localhost:5622/api/projects/my-feature/repos/my-service/commits/0a1b2c3d/pr \
  -d '{"title":"Add the feature flag","branch":"me/feature-flag"}'
```

- `null` clears a field: the title and body go back to the commit message.
- `status` is `"draft"`, `"ready"` or `null`. Marking a PR draft again removes the key.
- Writes are atomic, applied to a fresh read of the file and retried if it changed meanwhile, exactly as for
  [comment files](/agents/comment-files/#concurrent-edits).

`landed:` isn't settable through the API: an agent appends it to the file (see the
[agent guide](/agents/agent-guide/#freezing-merged-prs-before-any-fetch-or-rebase)).
