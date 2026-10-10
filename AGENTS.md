# Driving Local Review: a guide for agents

**This is for agents working on OTHER repos** (e.g. `~/code/my-service`) that use Local Review to get a stack of
commits reviewed and then published as GitHub stacked PRs. It is not about developing Local Review itself (for that,
see [README.md](README.md) and [CLAUDE.md](CLAUDE.md)).

## What Local Review is

A local, GitHub-PR-style review UI for stacks of commits. Each commit is one candidate PR. The reviewer (the human you're working for) reviews them at
**http://localhost:5000/&lt;project&gt;/&lt;repo&gt;/&lt;sha&gt;** (short or full sha; `/<project>` is the project homepage).
Local Review never talks to GitHub and never modifies the repos it shows. You do the git and GitHub work, and record
the results in its files.

Everything lives in plain YAML under `~/.local-review/projects/<slug>/` (or `$LOCAL_REVIEW_HOME/projects/<slug>/`):

```
project.yaml                    repos, commit ranges, PR stacks, intro and stack notes
reviews/<repo>/<full-sha>.yaml  the reviewer's threads and your replies (schema: README "Comment files")
prs/<repo>/<full-sha>.yaml      PR title/body overrides, status (draft / ready), branch, github
```

The server re-reads these files on every request and pushes changes to the browser, so edits show up live. When the
server is running, prefer its API (below): its writes are atomic and are merged with concurrent edits.

## The data model

**`project.yaml`.** It lists `repos`, each with a `path`, a `branch` (the range end) and a `base` (the range starts
at `merge-base(base, branch)`). Each repo has `stacks`, consecutive groups of commits, each with a `title`, a
`starts_at` selector and an optional `description` (the stack note). The top-level `description` is the project
intro. `starts_at` is a commit **subject** (or a sha prefix): a stack runs from that commit up to the next stack's
start. A stack may have `follow_on: true`: parked work for later (below). See README "Projects" for the
full schema.

**Follow-on stacks** are parked work: PRs to get to later, not part of the stacks going up now. They're
reviewed like any other, keep their PR numbers, and sit at the end of the repo's `stacks:`. **Don't publish or
materialize them as part of a stack barrage unless the reviewer asks.** There's nothing else to do with them: no promote
step. When the reviewer wants one to go up, they (or you, when asked) remove the `follow_on:` line. They're always **yellow**
(any `color:` on them is ignored), and yellow is reserved for them: regular stacks use blue, green, purple, orange,
pink, teal, red or a `#hex` (`color: yellow` on a regular stack is a warning). Totals everywhere (stack picture,
homepage, sidebar, project list) leave follow-on stacks out and mention them beside the numbers
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
```

**Readiness: draft → ready → published.** Every PR starts as a draft. The reviewer marks it **ready** in the UI when they're happy
with it (that writes `status: ready`). It's **published** once it has a `github:` record, whatever `status:` says. The
API gives each commit `status` (`draft` / `ready` / `published`) and `progress` (threads resolved, files viewed).
**Never set `status: ready` yourself (or `"status":"ready"` through the API) unless the reviewer asks you to: readiness is
their call.** Don't clear it either. Recording `github:` after publishing is what makes a PR published.

**Files follow rebases.** A file named after an old sha is re-attached to the new commit by patch-id, then by
Change-Id, then by **subject**. A fixup or amend changes the patch, so the subject is what carries the comments
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

Then tell the reviewer it's ready, with the URL.

## API (http://localhost:5000)

Use a short or full sha.

```sh
P=my-feature; R=my-service; SHA=0a1b2c3d
BASE=http://localhost:5000/api/projects/$P/repos/$R/commits/$SHA
J='Content-Type: application/json'

# all commits: position, stack, title, status, unresolved, branch, github
curl -s http://localhost:5000/api/projects/$P | jq '.repos[] | {name, commits: [.commits[] | {position, short, title, status, unresolved, branch, github}]}'

curl -s $BASE/review | jq '.threads[] | select(.resolved != true)'                      # open threads
curl -s -X POST -H "$J" $BASE/threads/<tid>/comments -d '{"author":"claude","body":"…"}'  # reply
curl -s -X PATCH -H "$J" $BASE/threads/<tid> -d '{"resolved":true}'                      # resolve
curl -s -X PUT -H "$J" $BASE/pr -d '{"title":"…","body":"…"}'                          # null clears a field
curl -s -X PUT -H "$J" $BASE/pr -d '{"branch":"me/x"}'                                 # record a branch
```

With the server down, edit the YAML files directly instead (README "Comment files", "For agents: a recipe").

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

The plan command is read-only: it never writes, pushes or calls GitHub. Run it from your Local Review checkout (here `~/code/local-review`):

```sh
npm run --silent lr -- plan <project> [--repo <name>] [--stack <n>] [--include-follow-on] [--format md|json|yaml]
npm run --silent lr -- plan my-feature --repo my-service --stack 1
```

It lists each PR in scope, in order, with:

- the commit, its readiness (`Status: draft|ready|published`), and the branch with its status;
- the base: the previous PR's branch, or the repo's base (remote prefix stripped, e.g. `main`) for the first PR;
- the title, and the **exact full body**: project intro, stack note, `---`, PR description, the same as the UI's
  "Full body" button;
- any recorded `github:` info.

It warns about anything that needs fixing first: unresolved `starts_at` selectors, PRs without a branch, `missing`
and `moved` branches, and stacks that still contain draft PRs (only the reviewer can clear that one, by marking them ready). `--format json` is for scripts, e.g. `jq -r '.prs[0].body'`.

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
cd ~/code/local-review
npm run --silent lr -- plan $P --repo $R --stack 1 --format json > /tmp/plan.json
cd ~/code/my-service

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
    | curl -s -X PUT -H "$J" -d @- http://localhost:5000/api/projects/$P/repos/$R/commits/$sha/pr >/dev/null
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

## After merges

- Stacks merge **bottom-up**, in the web UI or with `gh stack merge <pr> --yes` (`--squash`/`--rebase`/`--merge`).
  This lands that PR and every unmerged PR below it, all or nothing. **`gh pr merge` can't merge a stacked PR.**
  Squash gives one commit per PR. Merging is the reviewer's call.
- GitHub then retargets the lowest unmerged PR to the stack's base and **rebases the rest on the server**,
  force-pushing their branches. The remote branches have moved, so fetch before pushing anything.
- Locally, rebase what's left onto the new main. This is the one time to rebase onto `origin/main`:

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
- The merged commits drop out of the Local Review range automatically: the merge-base moved. Their review and prs
  files stay on disk as history. If a stack is now empty, remove it from `project.yaml` (or point its `starts_at`
  at the next stack's first commit).

## Hand-off prompt template

To start a chat that addresses the reviewer's comments, paste this (fill in the `<…>`s):

```
I've reviewed <repo> in Local Review (project <project>, http://localhost:5000/<project>).
Address my open review threads, following <path to local-review>/AGENTS.md exactly:
- fix each reviewed commit with --fixup + autosquash onto the stack's current merge-base, with
  --update-refs, keeping subjects unchanged;
- reply in every thread (author: claude) saying what changed and in which commit;
- resolve only threads that were clear instructions carried out exactly, and leave the rest open;
- never delete threads or comments; don't push or touch GitHub.
Then check that the threads re-attached, run the plan command and report what's left.
```
