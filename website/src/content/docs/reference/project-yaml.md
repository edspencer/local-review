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
| `title` | string | The project's name in the header, the project switcher, the sidebar, the root page and the project page. Default: the slug. |
| `description` | markdown, optional | The **project intro**: context for the whole effort. Shown on the project page and in the Project context box of each stack and PR page, and first in every [full PR body](/using/editing-pr-text/#copying-text-for-the-real-pr). Editable in the UI; can show [images](/using/editing-pr-text/#images). |
| `repos` | list | One entry per repo, below. |
| `after` | slug, optional | The project this one **builds on** ([linked projects](/concepts/linked-projects/)): another project's slug. In a repo both have, this project's range starts where that one's ends, while that's an ancestor of this branch. Matched by `path`, else by repo `name`; a repo with `from:` ignores the link. No such project, this project itself, a cycle or a value that isn't a slug is a warning, and no link. |
| `example` | boolean, optional | Marks one of the [example projects](/reference/cli/#local-review-examples-remove): the UI labels it **Example** and offers to remove it. Set by `local-review examples`; you don't need it. |

The project's **slug** is its directory name (not a field): it's used in URLs, `/<slug>/<repo>/<sha>`.

## `repos[]`

| Field | | |
| --- | --- | --- |
| `path` | path | A local clone. `~` is expanded. It is only ever read, never modified ([read-only guarantee](/guarantees/read-only/)). |
| `name` | optional | Used in URLs and as the directory name under `prs/` and `reviews/`. Default: the path's basename. Two repos with the same name get `-2`, `-3`, … by position, with a warning: name them. Letters, digits, `.`, `_`, `-`: any other character becomes `-`, and a leading dot `_`. |
| `branch` | ref | The range **end**: this branch's head. Optional once the repo has `landed:`. |
| `to` | sha or ref | Instead of `branch`: the range end, inclusive. |
| `base` | ref | The range **start**: `merge-base(base, end)`, exclusive. Default: `origin/HEAD`, else `main`, else `master`. In a project with `after:`, a repo the predecessor also has starts at the predecessor's range end instead while that's an ancestor of `end` ([linked projects](/concepts/linked-projects/#the-ranges)). |
| `from` | sha or ref | Instead of `base`: the first commit included. Overrides `base`. |
| `landed` | list, optional | The repo's merged PRs, bottom to top: the keys (file names) of their `prs/<repo>/<sha>.yaml` files, a full sha or a unique prefix (quote prefixes). See [Landed PRs](/concepts/landed-prs/). |
| `github_stack` | number, optional | Informational: the GitHub stack these PRs went up as. |
| `stacks` | list, optional | Consecutive groups of the range's commits, in order, below. No `stacks:` means one stack named after the branch. |

Refs may only use letters, digits and `. _ / @ { } ^ ~ + -`, must not start with `-` and must not contain `..`
(one that breaks this is reported as not found). Git is given them as data, on its standard input or after
`--end-of-options`, never as options.

## `stacks[]`

| Field | | |
| --- | --- | --- |
| `title` | string | The stack's name (`STACK 1 · GROUNDWORK` in the sidebar), and part of its [stack page](/using/ui-tour/#the-stack-page)'s URL. A stack can also be written as just `- Title`. Default: `Stack n`. |
| `starts_at` | selector | The commit the stack starts at: a commit **subject**, a hex **sha prefix** (7+ characters; quote it), or a PR title. The first stack may leave it out. [The rules](/concepts/pr-stacks/#how-starts_at-picks-a-commit). |
| `color` | optional | `blue`, `green`, `purple`, `orange`, `pink`, `teal`, `red`, or a `"#hex"`. Default: cycles through that list in order. `yellow` is reserved for follow-on stacks. [Colours](/concepts/pr-stacks/#colours). |
| `description` | markdown, optional | The **stack note**: how this stack relates to the others. Shown on the stack's page and in the Stack context box of each of its PRs, and after the intro in its full PR bodies. Editable in the UI; can show [images](/using/editing-pr-text/#images). |
| `follow_on` | `true`/`yes`, optional | Marks the stack as [parked work](/concepts/follow-on-stacks/). `false`, `no` or absent: a regular stack. Any other value is ignored, with a warning. |

## How the UI edits it

The UI writes to `project.yaml` in exactly two places: the project intro and the stack notes (the `description:`
fields), when you edit them on the project or stack page, or in the **Project context** and **Stack context** boxes. It never writes anything you didn't
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

- **Project errors** (the project can't be read; ⚠ on its card): invalid YAML, a top level that isn't a mapping, or
  `repos:` that isn't a list.
- **Errors** (an error card): a missing repo, a missing branch, or a range that can't be worked out (no `branch` or
  `to`, a `to`, `from` or `base` that doesn't exist, a `from` that isn't an ancestor of the end, no common ancestor). A missing branch isn't an error in a repo with
  landed PRs; there, other range problems are only warnings.
- **Project warnings** (on the project page and at the top of the sidebar): a bad `after:` (not a slug, no such
  project, the project itself, a cycle).
- **Warnings**: a range that includes the commits of the project it builds on, or whose predecessor's branch is gone
  ([when the link doesn't hold](/concepts/linked-projects/#when-the-link-doesnt-hold)); a `starts_at` that matches nothing, or matches only commits at or before the previous stack's start
  (that stack is then empty); a later stack with no `starts_at` (also empty); an unknown colour; `color: yellow` on a regular stack; a regular stack after a follow-on one; an invalid
  `follow_on` value; `stacks:` or `landed:` that isn't a list; duplicate repo names; `landed:` keys that match no prs file, several, or one without a usable
  `landed:` block, and duplicates.
