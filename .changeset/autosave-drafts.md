---
"local-review": minor
---

Every text box now keeps a draft as you type, the way GitHub's do: PR titles and descriptions, the project intro, stack
notes, new comments, replies, inline comments (on their line or range) and edits of your comments. Drafts are kept in
the browser's localStorage, so they survive a reload, a closed tab or a crash; the editor reopens with "Restored an
unsaved draft from 10:42" and a Discard button. A draft is cleared when it's saved, cancelled or discarded, or when the
saved text comes to say the same, and never when a save fails. If the saved text changed meanwhile (an agent edited the
prs file or `project.yaml`), the editor offers "Load it" or "Keep mine" instead of overwriting either. A small amber dot
marks the PRs, tabs and stacks with drafts waiting. Drafts follow a rebase like review files do (patch-id, else a
unique subject), expire after 30 days, and are capped in size. Two tabs on the same page share them.

Drafts never leave the browser until you save them. The "Leave site?" prompt is gone, since drafts come back anyway;
it only appears if the browser couldn't keep one (its storage is full or turned off).
