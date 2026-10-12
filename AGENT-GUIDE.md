# Driving Local Review: a guide for agents

**This is for agents working on OTHER repos** (e.g. `~/code/my-service`) that use Local Review to get a stack of
commits reviewed and then published as GitHub stacked PRs. It is not about developing Local Review itself (for that,
see [AGENTS.md](https://github.com/edspencer/local-review/blob/main/AGENTS.md) in its repo). `npx local-review guide`
prints this guide.

Commands below are `local-review …`: run them as `npx local-review …` unless it's installed globally
(`npm i -g local-review`). The URLs assume the default port, 5622; if the reviewer runs it with `--port`, use
theirs. The reference docs (file schemas, the HTTP API, every edge case) are at
https://local-review.edspencer.net; this guide links the pages it relies on.

## What Local Review is

A local, GitHub-PR-style review UI for stacks of commits. Each commit is one candidate PR. The reviewer (the human you're working for) reviews them at
**http://localhost:5622/&lt;project&gt;/&lt;repo&gt;/&lt;sha&gt;** (short or full sha; `/` lists every project, `/<project>` is the project page, `/<project>/<repo>/stacks/<n>` a stack
page).
Local Review never talks to GitHub and never modifies the repos it shows. You do the git and GitHub work, and record
the results in its files.

Everything lives in plain YAML under `~/.local-review/projects/<slug>/` (or `$LOCAL_REVIEW_HOME/projects/<slug>/`):

```
project.yaml                    repos, commit ranges, PR stacks, intro and stack notes
reviews/<repo>/<full-sha>.yaml  the reviewer's threads and your replies (schema: the docs site's "Comment files schema")
prs/<repo>/<full-sha>.yaml      PR title/body overrides, status (draft / ready), branch, github, landed
assets/<hash>.<ext>             images shown in descriptions, stack notes and the intro (`local-review asset add`)
```

`local-review init <slug>` creates a new project's `project.yaml` from a commented example (it never replaces one).
The server watches these files (re-reading them whenever they change) and pushes changes to the browser, so edits show
up live. When the
server is running, prefer its API (below): its writes are atomic and are merged with concurrent edits.

## The data model

**`project.yaml`.** It lists `repos`, each with a `path`, a `branch` (the range end) and a `base` (the range starts
at `merge-base(base, branch)`). Each repo has `stacks`, consecutive groups of commits, each with a `title`, a
`starts_at` selector and an optional `description` (the stack note). The top-level `description` is the project
intro. `starts_at` is a commit **subject** (or a sha prefix): a stack runs from that commit up to the next stack's
start. A stack may have `follow_on: true`: parked work for later (below). After merges, a repo also has
`landed:`, the keys of its merged PRs' prs files, bottom to top ("After merges"), and its `branch` becomes optional.
A project may name the project it builds on, `after: <slug>` ("Linked projects"): then a repo they share starts
where the predecessor's range ends.
The full schema: [project.yaml](https://local-review.edspencer.net/reference/project-yaml/).

**Follow-on stacks** are parked work: PRs to get to later, not part of the stacks going up now. They're
reviewed like any other, keep their PR numbers, and sit at the end of the repo's `stacks:`. **Don't publish or
materialize them as part of a stack barrage unless the reviewer asks.** There's nothing else to do with them: no promote
step. When the reviewer wants one to go up, they (or you, when asked) remove the `follow_on:` line. They're always **yellow**
(any `color:` on them is ignored), and yellow is reserved for them: regular stacks use blue, green, purple, orange,
pink, teal, red or a `#hex` (`color: yellow` on a regular stack is a warning). Totals everywhere (stack picture,
project page, sidebar, project list) leave follow-on stacks out and mention them beside the numbers
(`+1 follow-on stack (2 PRs)`); the API's `GET /api/projects` gives `commitCount` without them and `followOnCount`.

**`reviews/<repo>/<sha>.yaml`.** Its `threads[]` each have an `id`, `resolved`, optional `path`/`side`/`line`, and
`comments[]` (`author`, `body`).

**`prs/<repo>/<sha>.yaml`.** All fields are optional. Hand-written files need only the fields you set:

```yaml
title: Short PR title          # default: the commit subject
body: |                        # default: the commit body
  What and why, briefly.
status: ready                  # draft (default, when absent) or ready: the reviewer's call, see below
branch: me/feature-flag        # the plain git branch for this PR (you choose the name)
github:                        # once the PR exists on GitHub
  number: 123
  url: https://github.com/<org>/my-service/pull/123
  branch: me/feature-flag
  base: me/config-loader
  stack: 12                    # optional: the GitHub stack number
  stacked_on: me/config-loader # optional: the branch it was stacked on before GitHub retargeted it
landed:                        # once it has merged, written by you before any fetch ("After merges")
  head: <full sha>             # headRefOid at merge
  base: <full sha>             # baseRefOid (pull.base.sha) at merge
  commit: <full sha>           # mergeCommit.oid
  method: merge                # merge, squash or rebase
  at: 2026-10-09T12:00:00Z     # mergedAt
```

**Readiness: draft → ready → published → merged.** Every PR starts as a draft. The reviewer marks it **ready** in the UI when they're happy
with it (that writes `status: ready`). It's **published** once it has a `github:` record, whatever `status:` says,
and **merged** once it has a `landed:` record. The API gives each commit `status` (`draft` / `ready` / `published` /
`merged`) and `progress` (threads resolved, files viewed).
**Never set `status: ready` yourself (or `"status":"ready"` through the API) unless the reviewer asks you to: readiness is
their call.** Don't clear it either. Recording `github:` after publishing is what makes a PR published.

**Local Review comments and GitHub comments are entirely separate.** Review threads here are between the reviewer
and you, locally. Never copy them to GitHub, and never import GitHub review threads or comments into Local Review
files, not even for merged or historical PRs.

**Files follow rebases.** A file named after an old sha is re-attached to the new commit by patch-id, then by
Change-Id, then by **subject**. Landed PRs' files never move and are never taken by another commit. A fixup or amend changes the patch, so the subject is what carries the comments
across. **Keep subjects stable**: don't reword a reviewed commit's subject, and give every commit a unique one. The
stack selectors (`starts_at`) depend on subjects too.

## Building the local representation (before anything goes to GitHub)

1. **Shape the commits into PRs.** One commit is one PR. Each should be reviewable on its own, with a clear
   subject. Use `git rebase -i` to split, squash and reorder.
2. **Group them into stacks** by editing `starts_at` in `project.yaml`, one stack per coherent chunk of work.
3. **Titles and descriptions:** the commit message is the default. To change one without touching the commit,
   write `title:`/`body:` into the prs file, or call `PUT …/pr` (below).
4. **Keep descriptions short.** Reviewers dislike verbose, AI-sounding descriptions: no headings, no restating the diff,
   no "This PR…" boilerplate. Say what changed and why, in a few lines. Only write the project intro and stack
   notes (`description:` in `project.yaml`) when asked.
5. **Images** (a diagram, a before/after screenshot), only where a picture says it better: add the file with
   `local-review asset add <project> <file> [--alt <text>]`, which copies it into the project's `assets/` folder and
   prints the markdown to paste into a `body:` or `description:`, e.g. `![Overview](assets/3f2a9c1e0b7d4a65.png)`.
   Never write `data:` URIs or copy files into `assets/` yourself: names are content hashes, and the command checks
   the type and the 5 MB limit. GitHub can't show these until they're published ("Images" under "Materializing").

Then tell the reviewer it's ready, with the URL.

## API (http://localhost:5622)

Use a short or full sha.

```sh
P=my-feature; R=my-service; SHA=0a1b2c3d
BASE=http://localhost:5622/api/projects/$P/repos/$R/commits/$SHA
J='Content-Type: application/json'

# all commits: position, stack, title, status, unresolved, branch, github
curl -s http://localhost:5622/api/projects/$P | jq '.repos[] | {name, commits: [.commits[] | {position, short, title, status, unresolved, branch, github}]}'

curl -s $BASE/review | jq '.threads[] | select(.resolved != true)'                      # open threads
curl -s -X POST -H "$J" $BASE/threads/<tid>/comments -d '{"author":"claude","body":"…"}'  # reply
curl -s -X PATCH -H "$J" $BASE/threads/<tid> -d '{"resolved":true}'                      # resolve
curl -s -X PUT -H "$J" $BASE/pr -d '{"title":"…","body":"…"}'                          # null clears a field
curl -s -X PUT -H "$J" $BASE/pr -d '{"branch":"me/x"}'                                 # record a branch
```

With the server down, edit the YAML files directly instead: see
[Comment files](https://local-review.edspencer.net/agents/comment-files/) for the recipe and
[the schema](https://local-review.edspencer.net/reference/comment-files/).

## Handling review threads

To find every open thread in a project:

```sh
for f in ~/.local-review/projects/$P/reviews/*/*.yaml; do
  npx yaml --json --single < "$f" | jq -r --arg f "${f##*/reviews/}" '.threads[]? | select(.resolved != true) | "\($f) \(.id) \(.path // "general"):\(.line // "") \(.comments[-1].body | split("\n")[0])"'
done
```

For each thread:

- **Always reply first**, as `author: claude`. Say what you changed and in which commit, e.g. "Renamed to
  `parseFlag` in 0a1b2c3d (Add the feature flag)." If you changed nothing, say why.
- **Resolve it yourself** (`resolved: true`) only when the comment was a clear instruction that you carried out
  exactly ("delete this", "rename this to X", "use this wording").
- **Leave it open** when it was a question, needed a judgement call, or you did something different from what was
  asked. The reviewer resolves those.
- **Never delete threads or comments, and never change `id`s.** Don't edit the reviewer's comments.

## Fixing a reviewed commit in a stack

```sh
cd ~/code/my-service                        # on the stack's tip branch, clean work tree
# … edit …
git commit --fixup=<sha-of-the-reviewed-commit>
MB=$(git merge-base origin/main me/my-feature)          # <base> and <branch> from project.yaml
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash --update-refs "$MB"
```

- **Rebase onto the stack's current merge-base, not `origin/main`.** The merge-base is the commit the stack sits on
  now, so the rebase rewrites only the stack's own commits. If `origin/main` has moved since (it usually has after a
  fetch), rebasing onto it silently moves the whole stack onto the new main. Every commit then changes. The diffs
  the reviewer reviewed shift under them. Conflicts appear that have nothing to do with the fix, and the branches no longer
  match what was reviewed. Moving to a new main is a separate, deliberate step (see "After merges").
- **Keep subjects unchanged.** The fixup is squashed into the target commit, keeping its subject, so its review
  file follows it.
- **`--update-refs`** moves every branch that points at a rewritten commit (see "Branch tagging"). Without it, they
  stay on the old commits and show as `moved`.
- **Afterwards,** check that the threads re-attached: open the PR in the UI, or run `curl -s $BASE/review | jq
  '{carried_over, threads: [.threads[] | {id, outdated, line}]}'` with the new sha. Then reply in each thread you
  addressed. `outdated: true` means the commented lines are gone. That's expected when you deleted them; say so in
  the reply.

## Branch tagging

Each candidate PR gets a plain git branch pointing at its commit. GitHub needs one head branch per PR, so this is
what lets the stack become real PRs later, and it lets the reviewer see in the sidebar what each PR's branch will be. **You
choose the name**: Local Review has no naming scheme. Pick short, descriptive names in the repo's usual style (e.g.
`me/feature-flag`). Tagging is local only: create and record the branches, but **don't push them** until the
reviewer approves materializing a stack (below). Don't move or rename the stack's own branch.

```sh
git config rebase.updateRefs true            # once per repo: every rebase moves these branches
git branch me/feature-flag 0a1b2c3d          # one per commit, bottom to top
curl -s -X PUT -H "$J" $BASE/pr -d '{"branch":"me/feature-flag"}'        # or write branch: into the prs file
```

The top commit already has the stack's own branch (e.g. `me/my-feature`). Local Review shows it as
`discovered`. Give the top commit its own name too, unless that branch is meant to be the top PR's head.

The API and the UI show each commit's branch with a status:

| status | meaning | fix |
| --- | --- | --- |
| `ok` | the recorded branch points at this commit | nothing to do |
| `moved` | it points elsewhere (`points_at`), e.g. after a rebase without `--update-refs` | `git branch -f <name> <sha>` |
| `missing` | it's recorded but not in git | `git branch <name> <sha>`, or record the right name |
| `discovered` | nothing is recorded; a branch in git points here | record it, if it's the one |

## The plan command

The plan command is read-only: it never writes, pushes or calls GitHub. Run it from anywhere:

```sh
local-review plan <project> [--repo <name>] [--stack <n>] [--include-follow-on] [--format md|json|yaml]
local-review plan my-feature --repo my-service --stack 1
```

It lists each PR in scope, in order, with:

- the commit, its readiness (`Status: draft|ready|published`), and the branch with its status;
- the base: the previous PR's branch, or the repo's base (remote prefix stripped, e.g. `main`) for the first PR;
- the title, and the **exact full body**: project intro, stack note, `---`, PR description, the same as the UI's
  "Full body" button;
- any recorded `github:` info;
- the images the body shows (`images[]` in JSON: `name`, `file`, `url`).

It warns about anything that needs fixing first: unresolved `starts_at` selectors, PRs without a branch, `missing`
and `moved` branches, and stacks that still contain draft PRs (only the reviewer can clear that one, by marking them ready). `--format json` is for scripts, e.g. `jq -r '.prs[0].body'`.
It also warns when a live PR's recorded `github.base` differs from the plan's base (retarget the PR, or check the
order), and when a prs file with a `github:` record and no `landed:` has a commit that's now in the repo base: it
landed upstream but wasn't frozen (do that now; "After merges"). And for each image (`assets/<name>`) in a body with
no published URL, since GitHub can't show a file on this machine ("Images" under "Materializing"). Where a URL is
recorded, the body already has it in place of `assets/<name>`.

In a linked project ("Linked projects") whose range in a repo starts where the predecessor's ends, the first PR there
is based on the **predecessor's top PR's branch** instead (`base_from: predecessor`; the others are `repo-base` and
`previous-pr`), with a warning while that PR isn't published: publish the predecessor first.

Landed (merged) PRs are never planned, with no warnings of their own; the first live PR's base is the repo base. A
note lists them ("Skipped 9 landed (merged) PRs …"); in JSON, `excluded_landed[]` (`repo`, `prs`).

Follow-on stacks are left out by default, with none of their warnings, and a note says so ("Excluded 1 follow-on
stack (2 PRs: …); use --include-follow-on"). `--include-follow-on` plans them too (the first one's base is the
previous PR's branch, as for any stack). `--stack <n>` naming a follow-on stack plans it, with a note that it's a
follow-on. In JSON: `scope.include_follow_on`, `excluded_follow_on[]` (`repo`, `stack`, `title`, `prs`), `notes[]`,
and `stack.follow_on` on each PR.

## Materializing with GitHub native stacked PRs

**Only when the reviewer asks, one stack at a time:**

1. Fix every warning, run the plan for **one** stack, and **show it to the reviewer**. Skip follow-on stacks unless
   the reviewer names one. If it still has draft PRs, say so:
   the reviewer marks them ready (or tells you to go ahead anyway).
2. **Wait for an explicit go-ahead.**
3. Publish that one stack (below).
4. Record what you created, and **report back** with the PR URLs.
5. Stop. The next stack waits for the next go-ahead.

This uses the [`gh stack` extension](https://github.com/github/gh-stack) (`gh extension install github/gh-stack`).
See [About stacked PRs](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs), the
[CLI reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands) and the extension's
[docs](https://github.com/github/gh-stack/tree/main/docs/src/content/docs) (FAQ, REST API). `gh stack` has **no
title or body flags**: `submit` opens an interactive editor, and `--auto` uses generated text. So create each PR
with `gh pr create`, which takes the exact title and body, then link the PRs into a stack with `gh stack link`,
which is meant for branches managed by other tools.

Each repo gets **one GitHub stack**, grown one Local Review stack at a time: the first go-ahead creates it, and each
later one appends to its top by stack number. (Stack numbers share the repo's numberspace with PRs and issues,
so they never equal a PR number.)

```sh
cd ~/code/my-service
local-review plan $P --repo $R --stack 1 --format json > /tmp/plan.json

# 0. stacked PRs available? Any 200 (even `[]`) means yes; 404 means not enabled, or no access to the repo
gh api "repos/{owner}/{repo}/stacks?per_page=1" >/dev/null

# 1. push the stack's branches (bottom to top)
git push --force-with-lease origin $(jq -r '.prs[].branch.name' /tmp/plan.json)

# 2. one PR per branch, bottom to top, with the plan's base, title and full body
jq -c '.prs[]' /tmp/plan.json | while read -r pr; do
  jq -r .body <<<"$pr" > /tmp/pr-body.md
  gh pr create --draft --head "$(jq -r .branch.name <<<"$pr")" --base "$(jq -r .base <<<"$pr")" \
    --title "$(jq -r .title <<<"$pr")" --body-file /tmp/pr-body.md
done

# 3a. first stack in this repo: create the GitHub stack, bottom to top. Always pass --base: without it, link
#     retargets the bottom PR to the repo's default branch.
gh stack link --remote origin --base "$(jq -r '.prs[0].base' /tmp/plan.json)" $(jq -r '.prs[].branch.name' /tmp/plan.json)
# 3b. later stack: append only the new PRs to the existing GitHub stack, by its number (--base is ignored here)
N=$(gh api "repos/{owner}/{repo}/stacks?pull_request=<any earlier PR number>" --jq '.[0].number')
gh stack link --remote origin "$N" $(jq -r '.prs[].branch.name' /tmp/plan.json)

# check: the stack, bottom to top (gh stack view can't see it; see below)
gh api "repos/{owner}/{repo}/stacks?pull_request=$(gh pr view "$(jq -r '.prs[0].branch.name' /tmp/plan.json)" --json number --jq .number)" \
  --jq '.[0] | "stack #\(.number) on \(.base.ref): \([.pull_requests[] | "#\(.number) \(.head.ref)"] | join(" <- "))"'

# 4. record each PR in its prs file (this also records the branch)
for b in $(jq -r '.prs[].branch.name' /tmp/plan.json); do
  sha=$(git rev-parse "$b")
  gh pr view "$b" --json number,url,headRefName,baseRefName \
    | jq '{github: {number, url, branch: .headRefName, base: .baseRefName}}' \
    | curl -s -X PUT -H "$J" -d @- http://localhost:5622/api/projects/$P/repos/$R/commits/$sha/pr >/dev/null
done
```

Checked against the docs and the extension's source (October 2026):

- **No setup:** stacked PRs are GA on all github.com plans (6 Oct 2026), with no repo or org setting. Step 0 is
  the check. `gh stack` exits `9` for "not enabled for this repository" (a 404 from the Stacks API).
- `link` keeps **no local state**, so `gh stack view`, `push`, `rebase` and `sync` don't know about the stack
  (exit `2`, "not part of a stack"). Read it with `gh api` instead, as above.
- `link` pushes branch arguments **without force**, so push rebased branches with `--force-with-lease` first
  (step 1). It reuses open PRs for those branches and retargets any whose base breaks the chain. It **only adds**,
  and only to the top. A PR can be in only one stack, and a stack holds 2–100 PRs, all in the same repo (no forks).
  Don't pass `--open`: it marks every PR in the command ready for review. Removing or reordering means
  `gh stack unstack <n>` and relinking, which is the reviewer's call.
- A **fully merged** stack can't be extended. The next Local Review stack then becomes a new GitHub stack (3a,
  with the plan's base, which is `main` by then).
- Force-pushing rebased branches keeps the stack: membership belongs to the PRs, not the commits. Merging needs a
  linear history, so each branch must contain the one below it, which `--update-refs` keeps true.
- CI and branch protection treat **every** PR as if it targeted the stack's base, so workflows on `pull_request`
  to `main` run for each PR in the stack. To merge a PR, every PR below it must pass its checks and reviews too.

Not verified (needs a live test):

- splitting one repo's chain into several GitHub stacks, each based on the previous one's top branch. GitHub says
  stacks can branch off one another, but we haven't tried `link --base <previous top branch>`. Use one stack per
  repo;
- whether approvals survive a local force-push. GitHub says its own **Rebase stack** button keeps them, but
  after a local force-push the repo's "dismiss stale approvals" rule probably applies.

Check `gh stack link --help` before you run it, and if anything differs from the above, tell the reviewer rather than guess.

### Images

GitHub has no API for attaching an image to a PR body: its upload exists only in the web UI. So an `assets/<name>`
reference in a plan body would show as a broken image on GitHub. For each image the plan warns about, either:

- **record a URL the PR's readers can reach**, with `local-review asset url <project> <name> <url>` (for example an
  image committed to a repo they can read, or one already uploaded to an earlier PR or issue), then re-run the plan:
  the body now has that URL; or
- **leave it to the reviewer**: publish as usual, and tell them which PRs have images to drag in by hand (the plan's
  `images[].file` is where each one is). Dragging an image into the PR on GitHub uploads it; they then replace the
  `assets/<name>` reference with the link GitHub inserts.

Don't upload images anywhere public on your own initiative, and ask before committing one to a repo.

## After merges

- Stacks merge **bottom-up**, in the web UI or with `gh stack merge <pr> --yes` (`--squash`/`--rebase`/`--merge`).
  This lands that PR and every unmerged PR below it, all or nothing. **`gh pr merge` can't merge a stacked PR.**
  Squash gives one commit per PR. Merging is the reviewer's call.
- GitHub then retargets the lowest unmerged PR to the stack's base and **rebases the rest on the server**,
  force-pushing their branches. The remote branches have moved, so fetch before pushing anything, but **freeze the
  merged PRs first** (below).

### Freezing merged PRs (before any fetch or rebase)

Once merged, a PR's commits leave the Local Review range when you rebase onto the new main, and the stack would empty
out and renumber. Freezing keeps it as a **landed PR**: same number, same stack, purple **Merged** badge, GitHub's diff
of it. **This is your job, and it comes first**, while the prs files still sit under the shas the reviewer reviewed.
Local Review only reads the result and warns (`local-review plan`: "landed upstream but not frozen"); it never calls GitHub.

For each merged PR, bottom to top (`N` its number, `SHA` the full sha of its prs file, i.e. the commit it was reviewed as):

```sh
P=my-feature; R=my-service; N=123; SHA=<full sha>
F=~/.local-review/projects/$P/prs/$R/$SHA.yaml

# 1. what landed (read-only GETs)
gh pr view $N --json headRefOid,baseRefOid,mergeCommit,mergedAt > /tmp/merged.json
PARENTS=$(gh api "repos/{owner}/{repo}/commits/$(jq -r .mergeCommit.oid /tmp/merged.json)" --jq '.parents | length')
METHOD=$([ "$PARENTS" = 2 ] && echo merge || echo squash)   # one parent: squash, or rebase if that's how it merged
#    optional, for github.stacked_on: the branch it was stacked on before GitHub retargeted it
gh api graphql -F n=$N -f query='query($n:Int!){repository(owner:"<owner>",name:"<repo>"){pullRequest(number:$n){
  timelineItems(first:5,itemTypes:[AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT]){nodes{... on AutomaticBaseChangeSucceededEvent{oldBase newBase}}}}}}' \
  --jq '.data.repository.pullRequest.timelineItems.nodes[0].oldBase'

# 2. write the landed: record into its prs file (append it; keep everything else)
grep -q '^landed:' "$F" 2>/dev/null || jq -r --arg m "$METHOD" \
  '"landed:\n  head: \(.headRefOid)\n  base: \(.baseRefOid)\n  commit: \(.mergeCommit.oid)\n  method: \($m)\n  at: \(.mergedAt)"' \
  /tmp/merged.json >> "$F"
```

3. **Append its key to the repo's `landed:` list** in `project.yaml` (bottom to top; a quoted sha prefix is fine), by
   hand, keeping the rest of the file:

   ```yaml
   repos:
     - path: ~/code/my-service
       branch: me/my-feature
       base: origin/main
       landed: ["0a1b2c3d", "4e5f6a7b"]   # the merged PRs, bottom to top
   ```

   Make sure the prs file has `subject:` (the commit's subject; the server writes it whenever it saves the file):
   a stack whose `starts_at` is that subject keeps matching the landed PR.
4. **Then fetch and rebase** what's left onto the new main. This is the one time to rebase onto `origin/main`:

   ```sh
   git fetch origin
   git rebase --update-refs origin/main        # on the tip branch
   ```

   Git skips commits whose patch is already upstream (a squashed single-commit PR has the same patch). If a merged
   commit was changed during the merge and isn't skipped, use
   `git rebase --update-refs --onto origin/main <merged-commit-sha>`.

- Then push only the published branches whose content differs from GitHub's rebase (normally none):
  `git diff --quiet origin/$b $b || git push --force-with-lease origin $b`. `gh stack push`, `rebase` and `sync`
  would do all this, but only for stacks tracked locally (`gh stack init <branches…>`, which also turns on
  `rerere`). `link` doesn't set that up, so don't use them.
- The landed PRs stay first in the repo, in their stacks, with their numbers; their review and prs files stay where
  they are. Don't remove or regroup the stacks. Once everything has landed, the branch can go (`branch:` is optional
  with `landed:`) and the project is archived automatically. Review threads on landed PRs work as normal, and stay
  in Local Review: don't carry them to GitHub, and don't import GitHub's.
- A PR merged without being frozen (you fetched first) can still be frozen: its prs file is where it was, and `gh pr
  view` still has the data. `local-review plan` lists the ones whose commits it can see in the base.

### Importing a historical, already-merged stack (for reference or demos)

Only when the reviewer asks. Everything comes from read-only `gh` GETs, and **no review threads, ever** (no
`reviews/` files; GitHub's comments stay on GitHub).

1. Get the members in order from the GitHub stack API: `gh api repos/{owner}/{repo}/stacks/<n>` lists
   `pull_requests[]` with each one's `number`, `head` (`ref`, `sha`) and `base` (`ref`, `sha` at merge) and
   `merged_at`; `gh api repos/{owner}/{repo}/pulls/<N> --jq .stack.position` gives a PR's position, if you need to
   check the order. Then per PR: `gh pr view <N> --json title,body,headRefName,baseRefName,headRefOid,baseRefOid,mergeCommit,mergedAt`.
2. Write one prs file per PR, named after its head sha, `prs/<repo>/<headRefOid>.yaml`, with `commit:`, `title:`,
   `body:`, `branch:`, `github:` (`number`, `url`, `branch`, `base`, `stack: <n>`, optionally `stacked_on`) and
   `landed:` (as above).
3. Write `project.yaml`: the repo's `path` and `base`, no `branch`, `github_stack: <n>` (informational), `landed:`
   with the head shas bottom to top, and the stacks (one per GitHub stack is simplest, `starts_at` the first PR's
   title). A neutral project intro if the reviewer wants one.
4. The diffs need the heads and bases in the local clone (fetching is your call, in your repo; Local Review never
   fetches). Without the head or base, a PR shows its merge commit's diff; without that either, no diff and a
   warning. Check the files / + / − against GitHub's numbers.

Stacking tools leave merged stacks looking different on GitHub. Check which kind you have before writing `landed:`:

- **ghstack (e.g. PyTorch): "Closed", not merged.** A merge bot lands each PR on `main` as one commit and closes the
  PR, so `mergedAt` and `mergeCommit` are null. Find the landed commit by its `Pull Request resolved: …/pull/<N>`
  trailer (`gh api search/commits -f q='repo:<owner>/<repo> "pull/<N>"'`), and use it as `landed.commit`, with
  `method: rebase` and its commit date as `at`. Each PR's base is its own synthetic `gh/<user>/<n>/base` branch, not
  the PR below; `headRefOid`/`baseRefOid` still give the PR's own diff.
- **Meta's exported repos (e.g. pytorch/executorch): "Merged", but into a synthetic base.** The PR merged into its
  own `gh/…/base` branch, and that merge commit is not on `main`. The real commit on `main` comes from Meta's export
  (a `Differential Revision:` trailer): use that as `landed.commit`, not `mergeCommit`.
- **GitHub native stacks merged in one go: a stale `baseRefName`.** The upper PRs keep the branch below as their
  `baseRefName` although everything landed on the stack's base. That's expected: record it as is, since `baseRefOid`
  (the head of the PR below) is what gives each PR its own diff.
- **Graphite and other auto-retargeted stacks: interleaved squashes.** After each merge GitHub retargets the next PR
  to `main`, so its `baseRefName` is `main` and the squash commits sit between unrelated commits on `main`. The
  head/base pairs still give each PR's own diff; the branch it was stacked on is only in the timeline
  (`github.stacked_on`, as in "Freezing merged PRs").
- **Sapling: cumulative PRs.** Each PR targets `main` and contains every PR below it, so its head/base diff is the
  whole stack so far, and GitHub's numbers are cumulative too. Set each PR's `landed.base` to the `headRefOid` of the
  PR below it (the bottom PR keeps its own base), so each one shows just its own change.

## Linked projects

One effort can be split into **linked projects**: the second builds on the first. Each is an ordinary project
with its own intro, stacks and review; the successor names its predecessor in `project.yaml`:

```yaml
title: Calendar reminders
after: calendar-feed           # the project this one builds on (its slug)
repos:
  - path: ~/code/orchard-api   # the same clone the predecessor reviews
    branch: theo/calendar-reminders
    base: origin/main
```

**Ranges.** In a repo the predecessor also has (the same `path`, else the same `name`), the successor's range
starts where the predecessor's ends (its `branch:`, or `to:`) **while that's an ancestor of the successor's branch**.
Otherwise it starts at `merge-base(base, branch)` as usual, which is what you want once the predecessor has merged
and the successor is rebased onto the base. `from:` still wins. A repo only the successor has is unaffected. A bad
`after:` (no such project, itself, a cycle) is a warning, and the projects aren't linked.

**Creating one.** Put the successor's commits on their **own branch, on top of the predecessor's branch** (one
branch per project, stacked like Graphite or git-town branches), not as a `to:` range of one branch: a `to:` sha
moves with every rebase. Then `local-review init <slug>`, fill in `after:`, the repos and stacks.

**Keeping them aligned.** A fix in the predecessor rebases the successor too: rebase the successor's branch onto
the predecessor's with `git rebase --update-refs` (so every PR's branch tag follows). Don't rebase the successor
onto the base while the predecessor hasn't merged.

**Splitting an existing project.** Ask the reviewer first. Make the branches (above), create the new project with
`after:`, narrow the old one's range, and move the review data of the commits that changed project:

```sh
local-review move <old> <new> <repo> --stack 3 --dry-run     # or commit shas instead of --stack
local-review move <old> <new> <repo> --stack 3
```

It copies those commits' prs and reviews files into the new project (never over an existing file: then it moves
nothing) and renames the originals to `<sha>.moved-to-<new>.yaml.bak`, after a snapshot. It doesn't edit either
`project.yaml`; it prints what's left to change there (ranges, `starts_at`, `landed:` keys).

**Publishing.** `local-review plan <successor>` bases the first PR of a shared repo on the predecessor's top PR
branch (`base_from: predecessor`) and warns while that PR isn't published: publish the predecessor first. The
predecessor's own plan is unchanged.

**After the predecessor merges.** Freeze its merged PRs in **its** project, as always ("After merges"). Then rebase
the successor's branch onto the base (`git rebase --onto origin/main <predecessor's branch> <successor's branch>
--update-refs`): its range then starts at the base. If the predecessor was **squash-merged** and its branch deleted
before you rebased, the successor's range picks up the predecessor's commits; Local Review warns ("includes N
commits of the project it builds on") and says which. Rebase as above; never delete files to hide them.

## Hand-off prompt template

To start a chat that addresses the reviewer's comments, paste this (fill in the `<…>`s):

```
I've reviewed <repo> in Local Review (project <project>, http://localhost:5622/<project>).
Address my open review threads. First run `npx local-review guide` and follow that guide exactly:
- fix each reviewed commit with --fixup + autosquash onto the stack's current merge-base, with
  --update-refs, keeping subjects unchanged;
- reply in every thread (author: claude) saying what changed and in which commit;
- resolve only threads that were clear instructions carried out exactly, and leave the rest open;
- never delete threads or comments; don't push or touch GitHub.
Then check that the threads re-attached, run the plan command and report what's left.
```
