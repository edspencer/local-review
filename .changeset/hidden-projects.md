---
"local-review": minor
---

A project can be hidden: `hidden: true` in its `project.yaml` leaves it off the root page (its cards and the section
counts) and out of the project switcher, without deleting or moving anything. Its URL still opens it, and the switcher
lists it while it's the open one. `after:` links to and from it still hold, so no range changes. In a chain of linked
projects, the card closes over a hidden one: the next project shown is labelled as building on the nearest one shown,
and a predecessor's "Next" links leave it out. `/api/projects` has a `hidden` field, and `/llms.txt` marks hidden
projects in its list (their slugs are still taken).
