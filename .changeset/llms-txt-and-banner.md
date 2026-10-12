---
"local-review": minor
---

For coding agents: the server now serves `/llms.txt`, with what an agent needs to create a project for you (the rules,
the steps, the commented `project.yaml` example, and this machine's data directory and existing projects), plus
`/llms-full.txt` (the same, then the whole agent guide) and `/agent-guide.md`. Tell your agent "Read
http://localhost:5622/llms.txt and create a local-review project for my feature-xyz branch on ~/code/my-git-project".
The docs site has copies, and serves every page as Markdown too (`/reference/project-yaml.md`). The agent guide has a
new "Setting up a project" section.

On start, `npx local-review` prints a LOCAL REVIEW banner in plum and amber, then the "Local Review on …" line, then
that hint with the port it's actually on. The banner is only shown on a terminal (not when piped, logged or in CI,
unless `FORCE_COLOR` is set), honours `NO_COLOR`, and becomes a one-line title on terminals narrower than 80 columns.
`--quiet` (`-q`) prints only the "Local Review on …" line.
