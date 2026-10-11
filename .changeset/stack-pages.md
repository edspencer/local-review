---
"local-review": minor
---

Stack pages, and a project page laid out like a PR page.

- **Stack pages** (`/<project>/<repo>/stacks/<n>-<title>`): one stack with its header (STACK n in its colour, readiness tally or Merged, repo and branches, PRs and +/−), a Conversation tab with the project context and the stack note (editable in place, with images) and a Stack tab with the picture of just that stack. Open one from a stack's title in the sidebar, its name in a PR's stepper, or the breadcrumbs. The URL follows a stack that was reordered or renamed in `project.yaml`.
- **The project page** (`/<project>`) now has Conversation (the project intro) and Stack (the whole picture) tabs. The list of repos, stacks and PRs beside the picture is gone: the sidebar shows the same, and stack notes are now edited on stack pages (or from a PR page).
- **Easier to reach:** a link to the project page at the top of the sidebar, and breadcrumbs (Project › repo · Stack n › PR #m) on stack and PR pages.
- **Context on PR pages** is two separate, collapsible boxes, **Project context** and **Stack context**, each linking to its page and editable in place. Images in them show as thumbnails and open in the lightbox.
- New endpoint: `GET /api/projects/:p/repos/:r/stacks/:ref/stack.svg|png`.
