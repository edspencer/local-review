---
title: Follow-on stacks
description: Park work for later without taking it out of review.
---

A stack marked `follow_on: true` is **parked work**: PRs to get to later, not part of the stacks going up now. They're
reviewed like any other stack but held back from publishing, always drawn in yellow, kept at the end of the repo, and
left out of every total.

```yaml
stacks:
  - title: The feature itself
    starts_at: "Add the feature flag"
  - title: Later
    starts_at: "Polish the feature"
    follow_on: true             # parked: held back from the stacks going up now
```

<!-- SHOT: crop-follow-on — the sidebar's dashed yellow FOLLOW-ON · HELD BACK divider and a faded, hatched follow-on stack below it; crop to the sidebar -->

## What it does, and doesn't

- **It's purely advisory.** The PRs keep their numbers and position, and review, comments, Viewed and Draft/Ready all
  work as usual.
- **There's no promote action.** When it's time for the stack to go up, delete the `follow_on:` line.
- **`local-review plan` leaves them out** unless asked (`--include-follow-on`, or `--stack <n>` naming one). See
  [The plan command](/agents/plan-command/). Agents don't publish them unless the reviewer asks.
- **Values.** `follow_on: true` or `yes`. `false`, `no` or absent: a regular stack. Any other value is ignored, with a
  warning.
- **Put them last.** Follow-on stacks belong at the end of a repo's `stacks:`. A regular stack after one gets a warning,
  since its PRs would sit on held-back work.
- **Always yellow.** A follow-on stack is yellow whatever its `color:` says, and yellow is reserved for them
  ([Colours](/concepts/pr-stacks/#colours)).
- **Left out of totals,** and mentioned beside them: `+1 follow-on stack (2 PRs)`. The API's `GET /api/projects` gives
  `commitCount` without them, and `followOnCount`. See [Totals](/concepts/pr-stacks/#totals).

## How the UI shows them

They use GitHub's attention colours: `#9a6700` text and `#bf8700` lines in light mode, `#d29922` in dark.

- **Sidebar:** a dashed yellow `FOLLOW-ON · HELD BACK` divider above the first one, then their boxes with a yellow
  border, faint yellow hatching and slightly faded rows (the text at 72%; full strength on hover and for the open PR;
  readiness badges and branch warnings never fade), and a dashed yellow `follow-on` badge on the stack title (not on
  each row, where it would squeeze the branch name).
- **The repo heading's viewed count** leaves them out and shows their PRs beside it in a dashed yellow pill
  (`0/11 (+2)`; the tooltip says how many of them are viewed). The open-threads counter still counts every PR.
- **The commit page's stepper** shows the badge, with its pills in yellow.
- **The project homepage:** a dashed yellow left border, and the divider.
- **The stack picture:** a yellow border and label with a yellow `follow-on` tag. Its border and rows are drawn at
  72% opacity (the label, the tag and a highlighted PR at full strength).
