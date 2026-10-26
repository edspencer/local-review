---
"local-review": minor
---

New per-repo `pr_model: follow-ups` in project.yaml: commits added on top of a published PR's branch (to address review without rewriting it) are folded into that PR instead of showing as PRs of their own. The PR's diff covers them all, its header lists its commits, and its branch shows as `ok` rather than `moved`. Without it, nothing changes.
