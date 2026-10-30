---
title: config.yaml
description: Settings for this machine rather than any one project; for now, the GitHub sync.
---

`~/.local-review/config.yaml` (in `$LOCAL_REVIEW_HOME` if that's set) holds settings for this machine rather than any
one project. It's optional, and so is every setting in it. Edits take effect without a restart.

For now its only section is `github:`, for [GitHub status](/using/github-status/):

```yaml
github:
  sync: on        # fetch what GitHub says about published PRs (default: off)
  source: gh      # how to reach GitHub (default, and for now the only one: gh)
  max_age: 5m     # how old it may get while a Local Review page is open (default 5m)
  me: edspencer   # whose last comment makes a thread "answered" (default: who gh is logged in as)
```

| Setting | | |
| --- | --- | --- |
| `github.sync` | `on` / `off` (or `true` / `false`, `yes` / `no`) | Whether the server fetches by itself, while a page is open and when you come back to it. Off by default: it's the only thing that talks to the network. Off, the **Refresh** button and `local-review github refresh` still fetch when you ask, and what they fetched is shown. |
| `github.source` | `gh` | The [GitHub CLI](https://cli.github.com), logged in (`gh auth login`, with `--hostname` for GitHub Enterprise). It holds the token; Local Review never sees it. |
| `github.max_age` | `30s`, `5m`, `1h`, … or a number of seconds | The cache's maximum age while a Local Review page is open: a GitHub repo whose last fetch is older is fetched again. At least 30 seconds. |
| `github.me` | a GitHub login | Whose last word makes a thread **answered** rather than open. Set it if gh is logged in as another account than the one you reply as. |

A project leaves the sync with `github: {sync: off}` in its [project.yaml](/reference/project-yaml/#top-level); its
PRs are never fetched, by the server or by `local-review github refresh`.

A setting that isn't valid keeps its default, and `local-review github status` and `refresh` print a warning saying
which and why.
