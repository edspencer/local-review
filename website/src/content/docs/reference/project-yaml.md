---
title: project.yaml
description: The full schema of a project's project.yaml.
---

A project is a directory under `~/.local-review/projects/`, and `project.yaml` in it says which repos and commits the
project covers and how they split into [PR stacks](/concepts/pr-stacks/). `local-review init <slug>` creates one from
[`examples/project.example.yaml`](https://github.com/edspencer/local-review/blob/main/examples/project.example.yaml),
a commented starting point. Edits are picked up live.

## Example

```yaml title="~/.local-review/projects/my-feature/project.yaml"
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
    # landed: ["0a1b2c3d", …]       # optional: merged PRs, bottom to top: keys of prs/<repo>/<sha>.yaml files
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
        follow_on: true             # optional: parked work, held back from the stacks going up now
```

## Top level

| Field | | |
| --- | --- | --- |
| `title` | string | The project's name in the header, the project switcher and the homepage. |
| `description` | markdown, optional | The **project intro**: context for the whole effort. Shown on the homepage and in each PR's Project context box, and first in every [full PR body](/using/editing-pr-text/#copying-text-for-the-real-pr). Editable in the UI; can show [images](/using/editing-pr-text/#images). |
| `repos` | list | One entry per repo, below. |

The project's **slug** is its directory name (not a field): it's used in URLs, `/<slug>/<repo>/<sha>`.

## `repos[]`

| Field | | |
| --- | --- | --- |
| `path` | path | A local clone. `~` is expanded. It is only ever read, never modified ([read-only guarantee](/guarantees/read-only/)). |
| `name` | optional | Used in URLs and as the directory name under `prs/` and `reviews/`. Default: the path's basename. Two repos with the same name get `-2`, `-3`, … by position, with a warning: name them. Letters, digits, `.`, `_`, `-`, no leading dot. |
| `branch` | ref | The range **end**: this branch's head. Optional once the repo has `landed:`. |
| `to` | sha or ref | Instead of `branch`: the range end, inclusive. |
| `base` | ref | The range **start**: `merge-base(base, end)`, exclusive. Default: `origin/HEAD`, else `main`, else `master`. |
| `from` | sha or ref | Instead of `base`: the first commit included. Overrides `base`. |
| `landed` | list, optional | The repo's merged PRs, bottom to top: the keys (file names) of their `prs/<repo>/<sha>.yaml` files, a full sha or a unique prefix (quote prefixes). See [Landed PRs](/concepts/landed-prs/). |
| `github_stack` | number, optional | Informational: the GitHub stack these PRs went up as. |
| `stacks` | list, optional | Consecutive groups of the range's commits, in order, below. No `stacks:` means one stack named after the branch. |

Refs must not start with `-` or contain `..`; they're passed to git after `--end-of-options`.

## `stacks[]`

| Field | | |
| --- | --- | --- |
| `title` | string | The stack's name (`STACK 1 · GROUNDWORK` in the sidebar). A stack can also be written as just `- Title`. |
| `starts_at` | selector | The commit the stack starts at: a commit **subject**, a hex **sha prefix** (7+ characters; quote it), or a PR title. The first stack may leave it out. [The rules](/concepts/pr-stacks/#how-starts_at-picks-a-commit). |
| `color` | optional | `blue`, `green`, `purple`, `orange`, `pink`, `teal`, `red`, or a `"#hex"`. Default: cycles through that list in order. `yellow` is reserved for follow-on stacks. [Colours](/concepts/pr-stacks/#colours). |
| `description` | markdown, optional | The **stack note**: how this stack relates to the others. After the intro in this stack's full PR bodies. Editable in the UI; can show [images](/using/editing-pr-text/#images). |
| `follow_on` | `true`/`yes`, optional | Marks the stack as [parked work](/concepts/follow-on-stacks/). `false`, `no` or absent: a regular stack. Any other value is ignored, with a warning. |

## How the UI edits it

The UI writes to `project.yaml` in exactly two places: the project intro and the stack notes (the `description:`
fields), when you edit them on the homepage or in a PR's **Project context** box. It never writes anything you didn't
type: no text is generated.

- Saving writes just that one field (as a `|` block; saving it empty removes the key), through the `yaml` package's
  Document API, so comments, key order and quoting elsewhere in the file are kept. Only the spacing before a trailing
  `# comment` is normalised to one space.
- The write is atomic, re-reads the file just before writing and re-applies the change if it moved (an agent saved
  it), and is refused (HTTP 409) while the file doesn't parse.
- A stack is addressed by its position in `stacks:`, with its title as a guard, so a note never lands on a stack that
  was reordered meanwhile. A `- Title` shorthand stack becomes `- title: Title` to hold one.

## Errors and warnings

Problems show on the repo in the sidebar:

- **Errors** (an error card): a missing repo, or a missing branch. A missing branch isn't an error in a repo with
  landed PRs; there, other range problems are only warnings.
- **Warnings**: a `starts_at` that matches nothing, or matches only commits at or before the previous stack's start
  (that stack is then empty); `color: yellow` on a regular stack; a regular stack after a follow-on one; an invalid
  `follow_on` value; duplicate repo names; `landed:` keys that match no prs file, several, or one without a usable
  `landed:` block, and duplicates.
