---
title: PR stacks
description: Split a repo's commits into colour-coded stacks of PRs that go up together.
---

Each repo's commits are split into consecutive, colour-coded **PR stacks**: groups that go up to GitHub together, each picked out by the commit it `starts_at`. Stacks are selected by commit subject, so they survive rebases.

```mermaid
flowchart BT
  base[(origin/main)]
  subgraph s1 [Stack 1 · Groundwork]
    direction BT
    c1[PR 1 · Add the config loader] --> c2[PR 2 · Read config at startup]
  end
  subgraph s2 [Stack 2 · The feature itself]
    direction BT
    c3[PR 3 · Add the feature flag] --> c4[PR 4 · Wire the flag into the UI]
  end
  base --> c1
  c2 --> c3
```

:::note[TODO: content]
This page is a stub. Its content will move here from the README's "Stacks" and "Colours" paragraphs.
:::
