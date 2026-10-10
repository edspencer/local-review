---
'local-review': minor
---

Moving between PRs is instant. A PR you've opened before, the PRs either side of the one you're on, and a sidebar
row you rest the pointer on are loaded in the background and open at once; anything else keeps the PR you were on in
view, with a thin amber bar along the top of the window, instead of a blank "Loading…" page. The server is much faster
too: it now works out a project's stacks, branches and comments only when something changed (a file, a branch, a
rebase), so a page that took 150–500 ms takes a few. Branches are polled every 2 seconds (was 3), and a moved base or a
new branch now shows up live as well.
