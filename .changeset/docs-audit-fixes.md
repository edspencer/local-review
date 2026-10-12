---
"local-review": patch
---

Fixes from the docs audit:

- **Rebased reviews say so.** When a PR's review came over from an earlier commit after a rebase, its Conversation tab now shows "Review carried over from <sha> after a rebase (matched by patch-id / Change-Id / subject)".
- **`local-review move` after a rebase** now moves a commit's data that's still in its old sha's file (before anything was written under the new sha), instead of reporting "nothing recorded" and leaving the threads behind.
- **A `repos:` entry without a `path`** (or that isn't a mapping) is now a project warning, on the project page, in the sidebar and in `local-review plan`, instead of being dropped silently. `plan` now prints the other project warnings too (e.g. a bad `after:`).
- **A ref Local Review won't pass to git** (say a `branch` with a space) is reported as such, instead of "not found".
- **The example projects:** running `local-review examples` while the UI's Add is building them no longer makes a second set of repos (`orchard-<id>-2`). The welcome page counts them right: four, not three.
- **The root page:** a card's readiness tally wraps instead of hiding its merged count at some widths, and thumbnails are drawn at the card's width, so their repo labels are the same size on every card.
- **The header** shows only the keyboard shortcuts the page you're on has, and the Archived section's tooltip says what makes a project archived (some repo has landed PRs and none has a live commit).
