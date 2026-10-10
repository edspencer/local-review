---
version: "0.1.2"
level: copilot
processes:
  design: pair
  implementation: copilot
  testing: copilot
  documentation: copilot
  review: pair
  deployment: assist
---

This format is based on [AI-DECLARATION.md](https://ai-declaration.md/en/0.1.2).

## Notes

Local Review is a tool for reviewing what coding agents write, and it was built the same way: by me, working with
Claude Code agents. Its whole premise is that a human reads every change before it goes anywhere, and that's how it
was developed too.

- **Design is mine.** What the tool is for and its guarantees are decisions I made: stacks of local commits shown
  as PRs, comments as plain YAML files an agent replies to, reviewed repos strictly read-only, user data never
  deleted, localhost only, and a UI that must never be mistaken for GitHub. I argued them through with Claude rather
  than delegating them.
- **Implementation and tests are largely generated under review.** I prompt, an agent writes the code and the
  tests, and I read the diff. Commits an agent helped write carry a `Co-Authored-By: Claude` trailer. (The history
  before the first public commit was squashed into it, so the trailers start after that.)
- **The guarantees are tested, not just promised.** A static test (`test/fsguard.test.ts`) fails the build if any
  code outside two audited modules gains a way to delete or overwrite files, all git access goes through a
  read-only allow-list, and CI runs the typecheck, the test suite, the build and a packed-install smoke test on
  Linux and macOS before anything merges.
- **Releases are automated, never from a laptop.** npm releases come from GitHub Actions with trusted publishing
  and provenance, after CI has passed on the exact commit.

### Why this file exists

Because "was this vibe-coded?" is a fair question to ask of a tool you're going to point at your own work, and the
useful answer is a specific one. If you're sceptical of generated code, this tells you where to look: the guarantees
above, and the tests that hold them.
