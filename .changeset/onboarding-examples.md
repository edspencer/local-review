---
"local-review": minor
---

A first-run welcome page, and one-click example projects:

- With no projects, the UI now shows a welcome page instead of a bare "No projects yet": what Local Review is, how to
  create your first project (or a prompt to hand that to your coding agent), and links to the docs.
- **Add the example projects** (on that page, at the bottom of the project switcher, or `local-review examples`)
  creates "Orchard", a made-up app reviewed across four repos, in about a second and with no network: stacked PRs,
  review threads with an agent's replies, and a fully merged stack to click around. They're marked **Example**.
- **Remove examples** hides them again and deletes nothing: each example's `project.yaml` is renamed to a `.bak`, and
  adding them again brings them back as you left them. A project of your own is never touched.
