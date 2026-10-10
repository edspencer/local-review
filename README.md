# Local Review

A local, GitHub-PR-style review UI for **stacks of commits**. Work is grouped into **projects** (e.g. "My
feature"), each spanning one or more **repos** (a commit range each), whose commits are split into
colour-coded **PR stacks**. Each commit is shown as one "PR" with a Conversation tab and a Files changed tab. You leave general and inline comments. They are saved as plain YAML files, in
`~/.local-review/` (not in this repo; see [Where your data lives](#where-your-data-lives)), that an AI agent (Claude) can
read and reply to by editing them, and replies show up in the UI live.

Nothing here is pushed or published anywhere: Local Review never talks to GitHub. An agent can record the
branch it tagged each commit with, the GitHub PR it later created and, once that merged, what landed (`prs/` files),
and `npm run lr -- plan` prints what each PR should be. Merged PRs stay in their stacks as **landed PRs** (see
[Landed PRs](#landed-prs)). **Agents using Local Review on other repos: read [AGENTS.md](AGENTS.md).**

## Run

```sh
npm install
npm start          # builds the frontend if needed, then serves UI + API on http://localhost:5000
```

`npm run dev` runs Vite with hot reload on :5000, proxying `/api` to the API server on :5001
(`LOCAL_REVIEW_WEB_PORT` / `LOCAL_REVIEW_API_PORT` change both, e.g. to run it next to a live instance).
`npm run typecheck` type-checks the server and the frontend. `npm run --silent lr -- plan <project> [--repo <name>]
[--stack <n>] [--include-follow-on] [--format md|json|yaml]` prints the read-only materialization plan (see [AGENTS.md](AGENTS.md#the-plan-command)). `npm test` runs the tests
(`node:test`; they build throwaway git repos in the OS temp dir and delete them afterwards).

Environment overrides: `LOCAL_REVIEW_HOME` (the data directory, default `~/.local-review`), `PORT` (default 5000),
`LOCAL_REVIEW_USER` (who you are; see [The reviewer](#the-reviewer)). On macOS the AirPlay Receiver also listens on
port 5000; if `npm start` can't bind or you get the wrong page, run `PORT=5050 npm start` (or turn AirPlay Receiver
off in System Settings). The server binds to 127.0.0.1 only, answers only requests whose
`Host` is `localhost`/`127.0.0.1`/`[::1]` (against DNS rebinding), and only accepts writes that are JSON and,
if the browser sends an `Origin`, come from localhost (against cross-site requests).

`@pierre/diffs` is pinned to an exact version: the unified view's second line-number column patches one of
its private methods (see the comment at the top of `src/FilesChanged.tsx`). If that method changes, the patch
falls back to the stock single column and warns once in the browser console. Check it when upgrading.

## The reviewer

Your comments are stored as `author: <id>`, and only yours can be edited or deleted in the UI (an agent's, `author:
claude`, never are). The name comes from `LOCAL_REVIEW_USER`, else `git config user.name`, else `$USER`; the id is its
first word, lowercased and reduced to `[a-z0-9_-]` ("Ada Lovelace" → `ada`). `GET /api/me` returns both. If your
comment files were written under some id, set `LOCAL_REVIEW_USER` to that id to keep them yours, e.g.
`LOCAL_REVIEW_USER=ada npm start`.

## Where your data lives

Everything you create (projects, PR title/description overrides, review comments, Viewed marks) lives in plain
files in a dot-directory in your home, like `~/.claude`, never in this repo, so the app can be shared and
updated without touching anyone's reviews. It isn't version-controlled.

```
~/.local-review/                        # or $LOCAL_REVIEW_HOME
  projects/
    <slug>/                             # one per project; the slug is used in URLs: /<slug>/<repo>/<sha>
      project.yaml                      # which repos and commits, and how they're split into PR stacks
      prs/<repo>/<full-sha>.yaml        # optional PR title/description overrides, readiness, branch, GitHub PR, landed
      reviews/<repo>/<full-sha>.yaml    # review comments and Viewed marks (see "Comment files")
  backups/
    2026-10-09T08-45-12Z/               # automatic snapshots: a plain copy of projects/ at that time (UTC)
```

**Getting started:** `mkdir -p ~/.local-review/projects/my-feature && cp examples/project.example.yaml
~/.local-review/projects/my-feature/project.yaml`, then edit it (see "Projects" below). With no projects, the UI
says the same.

**`LOCAL_REVIEW_HOME`** moves the whole data directory (e.g. `LOCAL_REVIEW_HOME=/tmp/lr-demo npm start` for a
scratch instance next to your real one). `LOCAL_REVIEW_PROJECTS_DIR` only moves `projects/`; it's for the tests,
and turns automatic snapshots off unless `LOCAL_REVIEW_HOME` is set too.

**Snapshots.** When the server starts, and then every hour while it runs, it copies `projects/` to
`backups/<timestamp>/` (with file times preserved), but only if something changed since the newest snapshot. A
snapshot is copied under a hidden `.partial-…` name and renamed when complete, so every timestamped directory is a
full copy. It keeps the 50 most recent snapshots plus the first snapshot of each day for 30 days. Pruning only ever
removes directories directly inside `backups/` whose names are snapshot timestamps (not symlinks, not anything
else you put there), and never the newest.

**Restoring** is copying files back, by hand. Stop the server first if you're restoring a lot, e.g.:

```sh
ls ~/.local-review/backups/                                       # pick a snapshot
diff -r ~/.local-review/backups/<timestamp>/<slug> ~/.local-review/projects/<slug>
cp -p ~/.local-review/backups/<timestamp>/<slug>/reviews/<repo>/<sha>.yaml ~/.local-review/projects/<slug>/reviews/<repo>/
```

**Never-delete guarantees.** The server can't irreparably delete anything in `~/.local-review`:

- Every write is atomic: a new temp file in the same directory (opened with `wx`, so never over an existing file),
  then renamed over the target. A failed write leaves the old file as it was (and removes only its own temp file).
- Writes are operations applied to a fresh read of the file, never a whole file from the browser, and a file
  that isn't valid YAML is never overwritten (HTTP 409; fix it by hand).
- No file's contents are ever unlinked or truncated. A superseded file (after a rebase re-match) is renamed to
  `*.superseded-by-<sha8>.yaml.bak`, and a rename never replaces an existing file: it's a hard link (which fails
  if the name is taken) followed by dropping the old name, or, on file systems without hard links, an existence
  check under the per-file lock.
- The only deletion anywhere is snapshot pruning, guarded as above. All of this lives in `server/safefs.ts` and
  `server/backups.ts`, and `test/fsguard.test.ts` statically scans `server/**/*.ts` and fails if any other code
  (or more code there) calls `unlink`, `rm`, `rmdir`, `truncate`, `writeFile`, `rename`, `copyFile`/`cp`, or
  shells out to `rm`/`mv`/….

Deleting a comment in the UI (only the reviewer's own) removes it from the file, as you'd expect; the previous version is in
the snapshots.

## Projects

Each project is a directory under `~/.local-review/projects/` (layout above); `examples/project.example.yaml` is a
commented starting point.

**`project.yaml`:**

```yaml
title: My feature
# optional: the project intro (markdown), one or two paragraphs of context; every full PR body starts with it
description: |
  Why this effort exists, …
repos:
  - name: my-service                # optional, default: the path's basename; used in URLs and dir names
                                    # (a duplicate gets "-2", "-3"… by position, with a warning: name it)
    path: ~/code/my-service
    branch: me/my-feature           # range end = branch head (or `to: <sha|ref>`, inclusive); optional with `landed:`
    base: origin/main               # range start = merge-base(base, end), exclusive; default origin/HEAD, main, master
    # from: <sha|ref>               # alternative start: the first commit included (overrides base)
    # landed: ["0a1b2c3d", …]       # optional: merged PRs, bottom to top: keys of prs/<repo>/<sha>.yaml files (see "Landed PRs")
    # github_stack: 12              # optional, informational: the GitHub stack these PRs went up as
    stacks:                         # optional; consecutive groups, in order
      - title: Groundwork
        color: blue                 # blue green purple orange pink teal red, or "#hex"; default cycles (no yellow)
        starts_at: "Add the config loader"
        # optional: a stack note (markdown), inter-stack context; after the intro in this stack's full PR bodies
        description: |
          First of three stacks: …
      - title: The feature itself
        starts_at: "Add the feature flag"
      - title: Later
        starts_at: "Polish the feature"
        follow_on: true             # optional: parked work, held back from the stacks going up now (see below)
```

**Intro and stack notes.** `description:` (top level) is the project intro; `description:` on a stack is that
stack's note. Both are optional markdown, are shown on the project homepage and in each PR's **Project context**
box, and can be edited there in place. The UI never writes anything you didn't type: no text is generated.
Saving writes just that one field into `project.yaml` (as a `|` block; saving it empty removes the key), via
the `yaml` package's Document API, so comments, key order and quoting elsewhere in the file are kept. (Only the
spacing before a trailing `# comment` is normalised to one space.) The write is atomic, re-reads the file just
before writing and re-applies the change if it moved (an agent saved it), and is refused (HTTP 409) while the
file doesn't parse. A stack is addressed by its position in `stacks:`, with its title as a guard, so a note never
lands on a stack that was reordered meanwhile. A `- Title` shorthand stack becomes `- title: Title` to hold one.

Each commit is diffed against its first parent with rename detection (`-M`), so a base that has moved on
doesn't matter (landed PRs are diffed differently; see [Landed PRs](#landed-prs)). Branch heads are polled every 3 s,
and every file under `~/.local-review/projects/` is re-read on each request and watched (edits push a refresh to the
browser), so no restart is needed. A missing repo or branch shows as an error in the sidebar (a missing branch isn't
one in a repo with landed PRs).

**Stacks.** `starts_at` selects a commit: a hex sha prefix (7+ chars; quote it in YAML) or a commit subject,
compared after trimming, collapsing whitespace and stripping `fixup!`/`squash!`/`amend!`; failing those, a PR title
(a `title:` override, the same way). Subjects survive rebases, so prefer them. A landed PR's subject is its stored
one (below), so a stack whose bottom PRs have merged keeps its shape. A stack runs from its start up to the next stack's start; with duplicate subjects the
first match after the previous stack's start is used, and the first stack may omit `starts_at` (it then starts
at the first commit). Commits before the first stack go into an implicit grey **Unstacked** group. A selector
that matches nothing, or only commits at or before the previous stack's start (out of order), makes that stack
empty and shows a warning on the repo in the sidebar. No `stacks:` means one stack named after the branch.

**Follow-on stacks.** `follow_on: true` (or `yes`; `false`/`no`/absent: a regular stack) marks a stack as parked
work: PRs to get to later, not part of the stacks going up now. It's purely advisory: the PRs keep their numbers
and position, review, comments, Viewed and Draft/Ready work as usual, and there's no promote action (delete the
line when it's time). The UI shows such stacks in yellow and a little faded, under a `FOLLOW-ON · HELD BACK`
divider in the sidebar and on the homepage, with a `follow-on` badge on the stack; the stack picture fades them and
tags them `follow-on`. `lr plan` leaves them out unless asked (AGENTS.md). Any other value is ignored with a warning.
Follow-on stacks belong at the end of a repo's `stacks:`: a regular stack after one gets a warning, since its PRs
would sit on held-back work.

**Colours.** A stack's `color:` is one of blue, green, purple, orange, pink, teal, red, or a `#hex`; without one,
stacks cycle through that list in order. **Yellow is reserved for follow-on stacks**: a follow-on stack is always
yellow whatever its `color:` says (the field can be left out), and `color: yellow` on a regular stack gives a
warning and falls back to the colour it would have had by default. (Hex colours aren't checked for yellowness.)

**Totals leave follow-on stacks and merged PRs out.** Every aggregate (the stack picture's summary line and repo
headings, the homepage's totals, the sidebar's viewed count, the project switcher's commit count) counts regular
stacks' unmerged PRs only and mentions the rest beside it: `2 repos · 4 stacks · 12 PRs · +3,300 −150 · +1 follow-on
stack (2 PRs) · +9 merged`. A stack whose PRs have all merged isn't counted among the stacks. A stack's own heading
and its PRs still show their real numbers. When only follow-on work is in view (the picture of just a follow-on
stack), its numbers are shown, labelled `1 follow-on stack · 2 PRs`; when only merged work is (an archived project),
likewise: `1 repo · 1 stack · 9 merged PRs`. The arithmetic lives in `shared/totals.ts`, used by both the server and
the UI, so they agree.

### Landed PRs

Once a stack goes up as GitHub stacked PRs and they merge, their commits leave the live range (the merge-base moves),
so on their own they'd vanish: stacks would empty out and PRs renumber. Instead, the agent **freezes** each merged PR
before it fetches or rebases (AGENTS.md "After merges"): it writes a `landed:` record into the PR's prs file and
appends the file's key to the repo's `landed:` list in `project.yaml`. Local Review only reads these; it never calls
GitHub.

- **Order and numbering.** A repo's PRs are its landed PRs, in `landed:` order (bottom to top), then its live
  commits. PR numbers ("PR 3", `#3`) are positions across both, so they don't change when PRs merge. Keys are prs
  file names (`<full sha>.yaml`): a full sha or a unique prefix (quote prefixes in YAML). A key that matches no file
  (or several), a file without a usable `landed:` block, or a duplicate is a warning on the repo, and is skipped. A
  landed PR whose commit is still in the live range (frozen before the rebase) is shown once, as landed.
- **Diffs.** A landed PR shows GitHub's view of it: `merge-base(landed.base, landed.head)...landed.head` (GitHub
  retargets each stacked PR to the base and rebases it there as the one below merges, so this is its own change
  and nothing else, for a multi-commit PR too). If the head or base object isn't in the local repo (a deleted
  branch, never fetched), it falls back to the merge commit's first-parent diff (`commit^1..commit`; a note on the
  page says so), and with neither there's no diff and a warning. Live PRs are diffed as before.
- **The repo's range.** With `landed:` present, `branch` / `to` are optional: no branch, a deleted branch or an empty
  live range is no error, and other range problems are a warning. Only a missing repo is still an error.
- **Stacks.** Landed PRs stay in their stacks. `starts_at` also matches PR titles and a landed PR's stored subject
  (`subject:` in its prs file, else its head's subject), so a part-merged stack keeps its shape.
- **Readiness and branches.** A landed PR is **merged** (above published): GitHub's merge icon in a purple circle,
  and a purple **Merged** pill on its page. Its recorded branch has status `merged`, never a warning (it may well be
  deleted).
- **Totals** count merged PRs on the side (`+9 merged`), as above.
- **Archived projects.** A project in which some repo has landed PRs and no repo has a live commit is archived
  automatically: the project switcher lists it in a separate, collapsed **Archived** section.
- **Re-matching.** Landed prs files are never orphans for rebase re-matching (see below), so a live commit with the
  same subject can't take them, and a landed PR never takes another commit's file.
- **Reviews** work as normal on landed PRs (threads, Viewed). **Local Review comments and GitHub comments are
  entirely separate**: Local Review never imports GitHub review threads, and never sends its own to GitHub.
- **Plan.** `lr plan` never plans landed PRs (the first live PR's base is the repo base), and warns about live PRs
  whose recorded `github.base` differs from the plan's base, and about prs files with a `github:` record but no
  `landed:` whose commit is now in the repo base ("landed upstream but not frozen").

**PR title/description overrides.** A commit's PR title and description are its subject and body, unless
`prs/<repo>/<full-sha>.yaml` says otherwise (the reviewed repo is never touched):

```yaml
commit: <full sha>
patch_id: <git patch-id --stable>   # server-maintained, for rebase re-matching
subject: <original commit subject>  # server-maintained, for rebase re-matching
title: Better PR title              # optional; absent or blank: the commit subject
body: |                             # optional; absent: the commit body (`description:` also works)
  Markdown.
status: ready                       # optional: draft (the default when absent) or ready; the reviewer's call (see below)
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

Hand-written files only need the fields they set. `github:` may also be just a PR number or url; one without a
usable number is ignored. `status:` is case-insensitive (`Ready`, `READY`); any other value counts as absent. In
`landed:`, shas must be full 40-hex (any case; others are ignored) and `method` is case-insensitive; the block counts
once it has a `head` or a `commit`. For a landed PR, `subject:` is its stored subject (used for stack selectors).

**Readiness.** Each PR is **draft**, **ready**, **published** or **merged** (`status` on every commit in the API).
Draft and ready are stored in `status:` (absent: draft; marking a PR draft again removes the key). Published is
derived: a PR is published as soon as it has a usable `github:` record, whatever `status:` says. Merged is derived
from a usable `landed:` record, and wins over the rest. Marking a PR ready is the reviewer's call:
agents don't set it unless asked. The API also gives each commit `progress: {threads, resolved, files, viewed}`:
conversations (threads with at least one comment, outdated ones included) and resolved ones, files changed and those
marked Viewed. Progress is (resolved + viewed) / (threads + files). They follow rebases exactly like review files (same
patch-id / Change-Id / subject rules below; missing `patch_id`/`subject` are looked up in the repo from the
file's sha). `PUT …/pr` with `{title?, body?, branch?, github?, status?}` sets them (`null` clears a field; the title and
body go back to the commit message; `status` is `"draft"`, `"ready"` or `null`), with the same atomic, re-read-and-retry writes as reviews.

**Branches.** Local Review has no branch naming scheme: the agent that writes the code picks names and creates
plain branches (`git branch <name> <sha>`). The server lists the repo's local and remote-tracking branches with one
read-only `git for-each-ref` per range and reconciles each commit (`branch` in the API):

- the display name is the recorded `github.branch`, else `branch:`, else a discovered local branch pointing at the
  commit (one other than the range's own tip branch first), else a discovered remote branch, else none (`null`);
- `status`: `ok` (recorded, points here), `moved` (recorded, points at `points_at`, e.g. after a rebase without
  `--update-refs`), `missing` (recorded, not in git), `discovered` (nothing recorded, found in git) or `merged` (a
  landed PR's recorded branch, whatever git says; never a warning);
- `discovered` lists every branch pointing at the commit: local first, the tip branch (e.g. `me/my-feature`
  on the top commit) last.

**For agents** (the full workflow, from shaping commits to GitHub stacked PRs, is in [AGENTS.md](AGENTS.md)): to
regroup stacks, edit `starts_at` in `project.yaml`. The intro and stack notes are its
`description:` fields; only write them when asked (no generated descriptions). To rewrite a PR description, write
`body:` (or `title:`) into `~/.local-review/projects/<project>/prs/<repo>/<full sha>.yaml`. Both show up in the UI live.

## Read-only guarantee

Reviewed repos are never modified. All git access goes through `server/git.ts`, which:

- runs `git -C <repo> …` via `execFile` with no shell, so paths and refs can't inject;
- refuses any subcommand outside a read-only allow-list (`log show diff diff-tree rev-list rev-parse
  merge-base patch-id cat-file ls-tree for-each-ref`), and options that write files or run programs
  (`--output`, `--no-index`, `--ext-diff`, `--textconv`, …);
- only uses object-level commands: diffs are always commit-to-commit (`git diff <parent> <sha>`), never
  against the work tree or index, and `git status` is never run;
- passes `--no-optional-locks` and sets `GIT_OPTIONAL_LOCKS=0`, so git never takes index locks or refreshes
  the index, drops any inherited `GIT_*` environment (e.g. `GIT_DIR`), and disables textconv, external diff
  drivers and signature checking;
- only passes refs from `project.yaml` (checked: no leading `-`, no `..`, after `--end-of-options`) and full
  40-hex shas that git itself returned (a landed PR's shas from its prs file are used only after `git rev-parse
  --verify <sha>^{commit}` has returned them).

Nothing ever fetches, checks out, commits, stashes, rebases or resets. URL shas must be hex and are only
used after matching them against the repo's own commit list. Project and repo names are restricted to
`[A-Za-z0-9._-]` with no leading dot and must exist in the config, and review/PR file names to
`<40-hex>.yaml`, so no path can leave `~/.local-review/projects/`.

## The deliberate "not GitHub" difference

The layout follows GitHub's PR page closely, but the top bar is **deep plum (#4a1942) with an amber underline**.
It carries a letter-spaced **LOCAL REVIEW** wordmark and an amber **"not on GitHub"** pill. Selected tabs also
get an amber top edge. You can't mistake it for github.com.

## Using the UI

- Header: the project title, with a project switcher when there's more than one. Archived projects (everything
  landed) are in a collapsed **Archived** section at the bottom of the switcher.
- Sidebar: one collapsible section per repo (`repo · branch`, with commits fully viewed and open threads), then
  each PR stack as a box with a coloured border and its title on the top line (`STACK 1 · GROUNDWORK`;
  Unstacked is grey and dashed). Commits are numbered 1..n across the whole repo, oldest first ("PR 2"), with the
  PR title, its branch name (middle-truncated; short sha if none; a warning icon if the recorded branch moved, struck
  through if missing), a `#1234 ↗` badge once the GitHub PR exists, +/− counts on the right, and one **readiness
  badge** (its tooltip has the details, e.g. "Draft · 6 of 15 done: 6/6 conversations resolved, 0/9 files viewed"):
  a small grey progress pie while the PR is a draft (a full pie at 100%: done, but not marked ready), a white tick in
  a green circle once it's ready, GitHub's PR icon in a blue circle once it's published, and GitHub's merge icon in a
  purple circle once it has merged (purple is kept for merged alone). Once any PR in a stack is ready, the stack's
  bottom border says how many (`2/4 READY`; published and merged count as ready), and `4/4 MERGED` in purple once
  they've all merged. A repo with nothing live shows a purple `merged` pill instead of its branch. (The per-row
  files-viewed bar is hidden for now: `SHOW_FILES_VIEWED` in `src/App.tsx`.) Missing repos/branches show an error
  card, stack problems a warning. The project homepage's PR list shows the same badges.
- **Follow-on stacks** (`follow_on: true`), always yellow (GitHub's attention colours: `#9a6700` text and `#bf8700`
  lines in light mode, `#d29922` in dark): a dashed yellow `FOLLOW-ON · HELD BACK` divider above the first one, then
  their boxes with a yellow border, faint yellow hatching and slightly faded rows (the text at 72%; full strength on
  hover and for the open PR; readiness badges and branch warnings never fade), and a dashed yellow `follow-on` badge
  on the stack title (not on each row, where it would squeeze the branch name), in the commit page's stepper (its
  pills yellow) and on the project homepage (a dashed yellow left border, and the divider). The repo heading's viewed
  count leaves them out and shows their PRs beside it in a dashed yellow pill (`0/11 (+2)`; the tooltip says how
  many of them are viewed). The open-threads counter still counts every PR. In the stack picture a follow-on stack
  has a yellow border and label with a yellow `follow-on` tag; its border and rows are drawn at 72% opacity (the
  label, the tag and a highlighted PR at full strength).
- Commit header: the PR title with its repo position (`#3`); where GitHub shows Open / Draft, a **Draft | Ready**
  toggle that writes `status:` to the prs file (or a blue **Published** pill with the `#1234 ↗` link once a
  `github:` record exists, or a purple **Merged** pill once a `landed:` record does, with "merged <when> (method)"
  in the line below), and the review progress (`6 of 15 done`, details in its tooltip); then "commit 3 of 10
  in <repo>", and a stepper of the commits in this PR stack, in its colour (`GROUNDWORK · PR 3 of 4`), each
  with its readiness badge. Toggling, agents' edits to the prs file and new Viewed marks or resolved threads update
  the sidebar, header and stepper live.
- **Editing PR titles and descriptions.** **Edit** beside the title turns it into an input (Enter saves, Esc
  cancels). The pencil in the description's header (or **…** → Edit) opens a Write/Preview editor with a small
  toolbar (bold, italic, code, link, list, quote; ⌘B / ⌘I / ⌘K), prefilled with the current description; ⌘/Ctrl+Enter
  saves, Esc cancels (asking first if you changed something). Saves go to `prs/<repo>/<sha>.yaml`, never to the
  commit; saving text identical to the commit message clears the override instead. An overridden field shows
  **edited ▾** ("Edited locally; the commit message is unchanged"), whose menu shows the commit's version and has
  **Revert to commit message**. If the file changes on disk (an agent) while you edit, an untouched editor just
  follows; one with your changes keeps them and offers "Load it" / "Keep mine". Drafts survive switching tabs and
  commits (not a reload; the browser warns before leaving).
- **Copying** (to paste into a real GitHub PR later): the copy icon beside the title copies the plain title (no
  `#n`); the one in the description header copies its raw Markdown; **…** → Copy title + description gives
  `title`, a blank line, then the body. **Full body** (beside the copy icon, and **…** → Copy full PR body) copies
  what the real PR's body should be: the project intro, a blank line and the stack note (if there is one), then
  a blank line, `---`, a blank line, and the PR description. Missing parts are left out. The separator is
  `CONTEXT_SEPARATOR` in `shared/prText.ts`
  (the plan command composes the same text).
- **Project context** (Conversation tab, above the description): a compact box with the project intro and this
  PR's stack note, each with Copy / Edit (the same editor as the description: Write/Preview, toolbar, ⌘↵ saves,
  Esc cancels, "changed elsewhere" notice). Collapse it with its chevron; that's remembered (localStorage, for
  every PR and project). **Project overview** goes to the homepage.
- **Stack tab** (`?tab=stack`): a picture of the project's PR stacks, like the sidebar but wider, with this PR
  highlighted (tinted row, **◀ this PR**, its stack's border emphasised). Each stack's title shows its weight
  (PRs, distinct files, +/−), and every stack and PR has a green/red bar on one square-root scale shared by the
  whole image, so weights are comparable. **This stack / This repo / Whole project** (default This stack) picks
  what's in it, and **Show title** turns the project heading and summary line on or off (both remembered in
  localStorage, for every PR and project); **Copy image** puts the PNG on the clipboard (ClipboardItem), **Download PNG** saves it, for pasting next to
  a real PR or into Slack. It's drawn on the server (below), so it looks the same everywhere.
- **Project homepage** (`/<project>`, or click the project title in the header): the project intro (editable in
  place), the same picture for the whole project, nothing highlighted, with Copy / Download, and a list of repos
  → stacks → PRs linking to each, with the project's and each repo's totals (follow-on stacks left out and
  mentioned, as in the picture). Each stack shows its weight (PRs, distinct files, +/−) and its note (Edit, or
  "Add a stack note").
- URLs: `/<project>/<repo>/<sha>` (short or full sha), with `?tab=files|stack` and an optional `&file=<path>`. `/`
  opens the most recently modified project's first commit; `/<project>` is its homepage and `/<project>/<repo>`
  the repo's first commit. Old `/<repo>/<sha>` URLs redirect into the project that has that repo.
- Keys (ignored while you're typing): `j` / `k` (and Prev / Next) walk every commit in the project in sidebar
  order, across stacks and repos; `n` / `p` next / previous file on Files changed.
- Files changed: Split/Unified (remembered; unified has old and new line-number columns), Expand/Collapse all,
  a file tree (directories collapse, single-child chains are compacted, the file you're reading is highlighted)
  with a filter, and a per-file **Viewed** checkbox (saved to YAML; a viewed file collapses; progress in the
  toolbar). Files with more than 800 changed lines show "Load diff" instead of the diff. Binary files, pure
  renames and empty files get their own placeholders. Off-screen diffs render as you scroll.
- Context: the bars between hunks expand 20 lines up or down, or **Expand all**.
- Inline comments: hover a diff line and click the blue **+** in the gutter. For a range, drag over the line
  numbers (or the +), or click one line number and shift-click another; a multi-line selection opens the
  comment form. A range that mixes old and new lines in unified view keeps both ends exactly ("Comment on
  lines -12 to +15", stored with `start_side`); if one end is an unchanged line it's saved on one side. Threads
  render under their (last) line with Reply and Resolve/Unresolve; range threads say "Comment on lines +40 to
  +42" and their lines are tinted (more strongly while you hover the thread). Resolved threads collapse. A
  thread whose line isn't in a shown hunk is listed at the top of its file card.
- Diffs are rendered with [`@pierre/diffs`](https://diffs.com) (Shiki `github-light` / `github-dark`), from full
  old and new file contents, so you can expand unchanged context. Dark mode follows the OS setting.

## Comment files (for agents: read this)

**Location:** `~/.local-review/projects/<project>/reviews/<repo>/<full-40-char-sha>.yaml` (or under `$LOCAL_REVIEW_HOME`; see
[Where your data lives](#where-your-data-lives)), never in this repo. There is one file per commit, created on the first
comment or Viewed toggle. The UI shows the file it is reading at the bottom of each Conversation tab.

**Schema:**

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
        author: ada                     # the reviewer's id (see "The reviewer") or "claude"
        created: 2026-10-08T18:32:25Z
        body: |
          Markdown text.
```

**Ranges across old and new lines.** `side`/`line` is always the range's *last* line. A range on one side
has `start_line < line` on that same side. A range selected in the unified view from a deleted line down to
an added line (or the other way round) also has `start_side`: the side `start_line` is on. Then `start_line`
and `line` are on different files, so no ordering between the two numbers is implied, e.g. `start_side: left,
start_line: 12, side: right, line: 15` is "-12 to +15". `start_side` is omitted when it would equal `side`,
and files without it read exactly as before.

### For agents: a recipe

How to reply, when to resolve and how to fix the commits is in [AGENTS.md](AGENTS.md#handling-review-threads);
this is the file-level detail.

1. **Find the file for a commit:** `~/.local-review/projects/<project>/reviews/<repo>/<full sha>.yaml` (`ls
   ~/.local-review/projects/` lists the projects), e.g.
   `ls ~/.local-review/projects/my-feature/reviews/my-service/$(git -C ~/code/my-service rev-parse me/my-feature).yaml`.
   Repo names are the `name` in `project.yaml` (default: the repo directory name). If there's no file under that
   sha but the commit was just rebased, its comments may still be in the old sha's file: `GET
   http://localhost:5000/api/projects/<project>/repos/<repo>/commits/<sha>/review` returns `file` (where they are now),
   `target_file` and `carried_over`. Either file can be edited; the server moves it on its next write.
2. **List unresolved threads:** threads with `resolved: false` (or no `resolved`). For example:
   ```sh
   npx yaml --json --single < ~/.local-review/projects/my-feature/reviews/my-service/<sha>.yaml | jq '.threads[] | select(.resolved != true) | {id, path, line, last: .comments[-1].body}'
   ```
   or just read the YAML. `path`/`side`/`line` say what's being discussed, on the file's `commit`. Use
   `git show <commit>` in the reviewed repo (read-only) for the code. If `outdated: true`, the code is gone
   from this commit; `anchor.text` is what was commented on.
3. **Reply:** append a comment with `author: claude` to the thread's `comments` list:
   ```yaml
         - author: claude
           created: 2026-10-08T15:00:00Z   # optional
           body: |
             Good catch. Fixed in the next commit by …
   ```
4. You may also **add a new thread**: append to `threads`, with `path`/`side`/`line` for an inline comment or
   without them for a general one. Leave out `anchor`: the server computes it from `commit` on its next write.
5. **Don't change existing `id`s.** New comments and threads can leave out `id`: the server assigns one the
   next time it writes the file.
6. **Set `resolved: true` to resolve a thread** (or `false` to reopen it).
7. Keep the file valid YAML. If it fails to parse, the UI shows an error and the server refuses to overwrite
   it until it's fixed, so nothing is lost. Write the whole file at once (or via temp file + rename).

The server watches `~/.local-review/projects/` and pushes changes to the browser over Server-Sent Events (`/api/events`), so
edits appear within about a second. Fields the server doesn't know about are kept. Missing `id`, `created`,
`resolved` or `author` fields are tolerated: an unknown author shows as "unknown".

### Concurrent edits

The UI never sends a whole file. Every UI action (new thread, reply, resolve, edit, delete, viewed) is an
operation that the server applies to a fresh read of the file from disk. Writes are serialised per file and
atomic (temp file + rename). Just before writing, the server re-reads the file; if it changed since it was
read (an agent saved it), the operation is re-applied to the new contents and retried, so an agent's reply
saved a moment before the UI's write is kept. A file that is briefly invalid YAML (caught mid-save) is retried
for a fraction of a second before the server gives up and refuses to write (HTTP 409; the file is left exactly
as it is). The server never deletes or truncates a review file: the only rename is the `.superseded-by-…bak`
one after a rebase re-match, and the only comment deletion is the reviewer deleting their own comment in the UI (see
[the never-delete guarantees](#where-your-data-lives)).

### After an amend or rebase: which file belongs to a commit

When a commit has no file under its own sha, the server looks at the *orphaned* files in the same repo
directory: `<sha>.yaml` files whose sha is no longer in the repo's range. A file whose commit is still in the
range (landed PRs count as in it) is never taken, nor is a prs file with a `landed:` block, and landed PRs never take
a file themselves. Neither is a file taken whose commit is still an ancestor of the range end (it only left the
range because `base`/`from` moved, e.g. it landed upstream; it wasn't rewritten). A file without `patch_id`,
`subject` or `change_id` (hand-written) gets them from git for its sha. A review file whose `repo_path` is a
different repo and whose sha this repo doesn't have is skipped. The assignment is computed for the whole range, deterministically, in this order (the
same for `reviews/` and `prs/`):

1. **Exact sha**: `<repo>/<sha>.yaml` exists. Nothing else is tried.
2. **Same patch-id** (`patch_id`): a pure rebase (e.g. onto a newer main) or a reword.
3. **Same Change-Id trailer** (`change_id`), if the commit has one. This goes before the subject because
   it's an explicit identity.
4. **Same subject**, after stripping leading `fixup!`/`squash!`/`amend!` and collapsing whitespace. Only
   used when the subject is unique among the range's commits (two `WIP` commits never match by subject).
   This is what catches fixups and amends that change the patch.

Each level is tried for every commit (oldest first) before the next level. Each orphan goes to at most one
commit. If several orphans qualify, the most recently modified file wins, then the lowest sha. Until the next
write, the comments are shown from the old file and the Conversation tab says "Comments carried over from
<sha> (rebased; same …)". On the next write the server saves them under the new sha, adds the old sha to
`previous_commits`, sets `matched_by`, and renames the old file to `*.superseded-by-<sha8>.yaml.bak`, so it
isn't matched again. Nothing is deleted.

### Line anchoring: how inline threads follow the code

- When an inline thread is created (by the UI, or found without an `anchor` on the server's next write), the
  server stores `anchor`: the commit, location, exact `text` of the commented lines and up to 3 lines of
  `before`/`after` context, on that side of the file. An agent-written thread without an anchor is anchored
  on the file's `commit`. If that's an old, rebased-away commit that's no longer in the repo, it's anchored on
  the current commit instead.
- `path`/`side`/`line`/`start_line` always mean the location on the file's `commit`. `anchor` keeps the
  original location (like GitHub's `original_line`/`original_commit_id`) and is never rewritten. The one
  exception: if it's anchored on the current commit and you hand-edit `line`, the anchor is recomputed there.
- To place a thread on a commit other than `anchor.commit`, the server finds the file in that commit's diff
  by `path`, then as the old side of a rename, then by `anchor.path`/`anchor.old_path`. It looks for
  `anchor.text` on the same side: exact matches first, then matches that differ only in whitespace. The best
  match is the one where the most `before`/`after` lines still fit, then the one nearest the last known line.
  A blank commented line needs at least one context line to fit. If the file isn't in the diff under any of
  those names (e.g. a newly added file renamed by a fixup), other files are searched too, but only an exact
  match with at least 3 fitting context lines (or all of them, if fewer) is accepted.
- A mixed-side range (`start_side`) is anchored on its last line; its first line's text (`start_text`) is
  then looked up on `start_side` near the same shift. If that line is gone, the thread becomes a single-line
  thread on its last line.
- If it's found, the thread is shown at the new line. The new location is written to `line`/`start_line`/
  `path` on the next write, and `anchor` is left as it was.
- If it isn't found (the line was deleted or rewritten, or the file left the commit), the thread is
  **outdated**: the API returns `outdated: true` and the server writes `outdated: true`, keeping `line` as the
  last known location. The UI shows an "Outdated" label with the original code from `anchor`, in the
  Conversation tab and at the top of the file's card (Conversation only if the file is gone from the
  commit). If the code comes back in a later rebase, the thread is placed again. Threads are never dropped.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/projects` | projects: slug, title, repo names/count, commit count (`commitCount`, without follow-on stacks and merged PRs; `followOnCount`, `mergedCount`), `archived`, unresolved count, last modified |
| GET | `/api/projects/:p` | `description`, repos (range, errors, warnings), `stacks` (title, color, commit shas, warning, `description`, `follow_on: true` on follow-on stacks, `weight`), commits (+/−, `position`, `stack` index, PR `title`, unresolved counts, `branch`, `github`, `status`, `landed` on landed PRs: the record plus `diff`, and `tip`/`parent`: what's diffed) |
| PUT | `/api/projects/:p/description` | `{description: string \| null}`: the project intro (null or blank removes it) |
| PUT | `/api/projects/:p/repos/:r/stacks/:n/description` | `{description, title?}`: stack `n`'s note (1-based in `stacks:`); a `title` that no longer matches is a 409 |
| GET | `/api/projects/:p/repos/:r/commits/:sha` | metadata (incl. `branch`, `github`), message body, files with old/new contents, `stack` (with position/count), project-wide `prev`/`next`, `pr`, review |
| GET | `…/review` | the review: file contents with threads placed on this commit (`outdated`, relocated `line`), plus `file`, `target_file`, `matched_from`, `matched_by`, `carried_over`, `parse_error` |
| GET / PUT | `…/pr` | `{title, body, title_source, body_source: 'commit'\|'override', commit_subject, commit_body, branch, github, file, …}`; PUT `{title?, body?, branch?, github?}` (null clears) |
| GET | `/api/me` | the reviewer: `{id, name}` |
| POST | `…/threads` | `{body, path?, side?, line?, start_line?, start_side?, author?}` |
| POST | `…/threads/:tid/comments` | `{body, author?}` |
| PATCH | `…/threads/:tid` | `{resolved}` |
| PATCH / DELETE | `…/threads/:tid/comments/:cid` | edit `{body}` / delete (only the reviewer's own comments; an agent's are never edited or deleted by the UI) |
| PUT | `…/viewed` | `{path, viewed}` |
| GET | `…/stack.svg`, `…/stack.png` | the stack picture with this PR highlighted: 680px-wide SVG, PNG at 2x (1360px). `?scope=project` (default) `\|repo\|stack`, `?scale=sqrt` (default) `\|linear`, `?title=0` drops the title and summary line, `?download` adds `Content-Disposition: attachment` |
| GET | `/api/projects/:p/stack.svg`, `…/stack.png` | the same for the whole project, nothing highlighted (the homepage) |
| | | `branch`: `{name, status: 'ok'\|'moved'\|'missing'\|'discovered'\|'merged', points_at?, discovered: string[]} \| null`; `github`: `{number, url, branch?, base?, created?, stack?, stacked_on?} \| null` (`url` is `''` if the file gives only a number) |
| GET | `/api/events` | SSE: `{type:"review"\|"pr",project,repo,sha}`, `{type:"project",project,reason}`, `{type:"projects",reason}` |

**Stack pictures** are built in `server/stackviz.ts`: an SVG string (no DOM; text is measured and truncated with
the glyph advances of the bundled fonts, read with `opentype.js`), turned into a PNG by `@resvg/resvg-js`
(prebuilt binaries, no browser). Fonts are bundled in `server/fonts/` (Inter and JetBrains Mono, SIL OFL), and
resvg is given only those, so the output is identical on every machine. Characters they lack (emoji, CJK) draw as
boxes.

## Layout

```
server/   git.ts (read-only git), config.ts (data home, port), safefs.ts (atomic writes, no-clobber renames), backups.ts
          (snapshots + pruning), commits.ts (ranges/diffs/patch-id), projects.ts (project.yaml, stack partitioning),
          reviews.ts (YAML store, rebase re-matching), prs.ts (PR title/description/branch/github/landed), landed.ts
          (landed PRs from project.yaml `landed:`), branches.ts (branch
          discovery + reconciliation), plan.ts + cli.ts (`npm run lr -- plan`), anchors.ts (line anchors
          + relocation), context.ts, events.ts (watch + SSE), index.ts (Hono), security.ts (localhost Host/Origin guard),
          stackviz.ts (stack picture: SVG + PNG), fonts/ (bundled OFL fonts for it)
test/     npm test: projects/stacks/PR overrides, review store, anchors, git wrapper and HTTP API tests against throwaway git repos,
          plus the PR editors' text helpers, the stack picture (aggregation, SVG, PNG endpoints), snapshots/pruning
          (backups.test.ts), branch tagging + the plan command (branches.test.ts), landed PRs (landed.test.ts) and the static never-delete guard
          (fsguard.test.ts)
src/      React UI: App (header, sidebar, SSE, j/k), CommitPage (PR header, Conversation), FilesChanged (tree, cards, @pierre/diffs), Comments
          (threads, Markdown editor), PrEdit (PR title/description editing + copy), prText (their pure text helpers),
          StackTab (the Stack tab, copy/download), ProjectHome (/<project>)
shared/   prText.ts: the full PR body composition, used by both the UI and the plan; totals.ts: aggregate
          stats over stacks (follow-on stacks and merged PRs left out), used by the stack picture and the UI;
          readiness.ts: draft / ready / published / merged
scripts/start.mjs   build-if-needed + serve
AGENTS.md           the guide for agents driving Local Review from other repos
examples/           project.example.yaml, a commented starting point (your projects live in ~/.local-review/projects/)
```

## License

MIT, see [LICENSE](LICENSE).

**Third-party:** the fonts bundled in `server/fonts/` for the stack picture are [Inter](https://github.com/rsms/inter)
and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), both under the SIL Open Font License 1.1
(`server/fonts/*-OFL.txt`). npm dependencies keep their own licenses.
