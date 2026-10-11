# The demo test bed

A reproducible world to run Local Review on, for screenshots, GIFs, manual testing and demos. Everything in it is
made up: **Orchard**, a booking app for fitness studios, its four repos, its team (Maya, Theo, Sam and June, all
`@orchard.example`), and a GitHub org (`orchard-studio-demo`) whose PR links go nowhere.

`lib/` and `world/` also ship in the npm package (compiled to `dist/demo`): they're the **example projects** a new
user can add from the first-run page or with `local-review examples` (`server/examples.ts`, which puts the repos in
the data home and prefixes the slugs with `example-`). So that code runs in the app: `test/fsguard.test.ts` scans it,
and it may only create files. The seed script, the lock and the capture rig don't ship.

```sh
npm run demo:seed                    # → demo/out (git-ignored); --force replaces an earlier seed
npm run demo:seed -- /tmp/demo       # anywhere else
npm run demo:check                   # seed into a temp dir and compare with demo/shas.json
tools/docs-media/serve.sh            # run Local Review on demo/out, isolated (see tools/docs-media/README.md)
```

It takes about a second. `demo/out/manifest.json` has every commit's sha and the exact environment to run the
server with:

```sh
HOME=demo/out/home LOCAL_REVIEW_HOME=demo/out/home/.local-review LOCAL_REVIEW_USER=maya npm start -- --port 5050
```

`HOME` matters: `project.yaml` says `path: ~/code/orchard-api`, so the repos are found under the seed's own home and
the same data works wherever the seed is.

## What's in it

```
demo/out/
  home/
    code/
      orchard-api/      Go: the HTTP API (chi, pgx), migrations, tests            49 commits
      orchard-sdk/      TypeScript: the API client                                 12 commits
      orchard-web/      React + TypeScript: the members' web app                   13 commits
      orchard-infra/    Terraform, Kubernetes manifests, a feature flags file       8 commits
    .local-review/projects/
      waitlists/        the flagship: four repos, eight stacks
      calendar-feed/    one repo, no `stacks:` (one stack named after the branch)
      calendar-reminders/  builds on calendar-feed (`after:`): linked projects
      webhook-retries/  everything merged: archived
  manifest.json
```

Each repo has a believable history on `main` (May to September 2026, several authors), an `origin` remote that's
never contacted, remote-tracking refs, and Maya's `maya/waitlists` branch checked out.

**Class waitlists** (`/waitlists`) exercises as much of Local Review as one project can:

| Feature | Where |
| --- | --- |
| Project intro, stack notes (and stacks without one) | `project.yaml` |
| Several colour-coded stacks per repo; an implicit **Unstacked** group | orchard-api (4 stacks), orchard-web (Unstacked + 2) |
| A follow-on stack | orchard-api "Studio controls" |
| Landed PRs, squash-merged, with `landed:` records and GitHub's diff | orchard-api #1, #2 (GitHub PRs #112, #113; #113 was rebased by GitHub after #112 merged, as for real stacked PRs) |
| Every readiness state: draft, ready, published, merged | orchard-api #1–#8, orchard-sdk |
| Recorded branches: `ok`, `moved` (left behind by a rebase), `merged`, `discovered`, none | orchard-api #7 is `moved`; #10 is the discovered tip branch; #9 has none |
| `github:` records, with `stack` and `stacked_on` | orchard-api #1–#5, orchard-sdk #1 |
| PR title and description overrides ("edited") | orchard-api #5 (title), #6 (description), orchard-sdk #2 (title) |
| General and inline threads, single- and multi-line, resolved and open | throughout; orchard-api #6 has four |
| An **outdated** thread, after an amend | orchard-api #6: made on the first version of the commit (still in the repo, under `maya/promotion-expiry`), on lines the fix removed; `previous_commits` / `matched_by: subject` as the server writes them |
| Agent replies (`author: claude`), including one asking the reviewer a question | orchard-api #6, orchard-sdk #3, orchard-web #2, orchard-infra #1 |
| Viewed marks, some files viewed and some not | throughout |

**Calendar reminders** builds on **Calendar feed** ([linked projects](https://local-review.edspencer.net/concepts/linked-projects/)):
`after: calendar-feed`, and its branch, `theo/calendar-reminders`, sits on top of `theo/calendar-feed` in orchard-api, so
its range starts where the feed's ends. Two stacks, a ready PR, a draft and one open thread.

**Payment webhook retries** is a three-PR stack merged with merge commits (GitHub stack #87), recorded as landed PRs
with no branch left: the project switcher files it under **Archived**.

The story, if you need to talk over a screenshot: full classes get a waitlist. Joining and leaving shipped (stack 2
is published); automatic promotion is in review, where Maya asked for the class lock to be taken on cancel, Claude
amended the commit (outdating one thread), and a second issue (offered spots still look free) is waiting for her
answer; the SDK, web and infra pieces follow.

## Determinism

The same shas and the same data files, on every run and every machine: commits are written with `git fast-import`
from in-memory trees, with fixed authors and dates, no signing, and git's configuration isolated from the
machine's (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, no inherited `GIT_*` variables, `TZ=UTC`).
`demo/shas.json` is the lock: every commit's sha and a hash of every data file. `test/demo.test.ts` (part of
`npm test`) checks the seed against it, then runs the server on a fresh seed and checks that every project loads
with no warnings, every thread lands on its line (one outdated, by design), and the readiness states, branch statuses
and stacks are what they're meant to be.

File times in the data home are set too: `/` opens the most recently modified project, which is Class waitlists.

## Changing it

- `world/people.ts`: the team, the org, "now" (`DEMO_NOW`, where the capture rig freezes the clock).
- `world/api.ts`, `sdk.ts`, `web.ts`, `infra.ts`: each repo's history. A commit is a set of file changes: whole
  contents, `null` to delete, or an edit (`replace`, `edits`, `after`) that fails loudly if its text isn't there,
  so content can't drift silently. Go files are written with four spaces and get tabs on disk. Rebases are
  `replay()`: same message and author, new parent and committer date.
- `world/review.ts`: the Local Review data, as YAML following the schemas on the docs site
  (`website/src/content/docs/reference/`: project.yaml, PR files, comment files). Inline threads name the text of the line they're on, not a number, so they stay put when the
  code above them changes.
- `lib/gitworld.ts`: the history builder.

Then `npm run demo:check -- --update`, look at the result in the UI (and re-shoot, `npm run docs:media`), and commit
`demo/shas.json` with the change. Keep it fictional: no real names, emails, hosts or orgs, since all of it ends up in
public screenshots.
