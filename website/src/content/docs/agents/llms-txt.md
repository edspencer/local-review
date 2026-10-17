---
title: "llms.txt: setting up a project"
description: Point a coding agent at /llms.txt and it can create a Local Review project for you.
---

Instead of writing a `project.yaml` yourself, ask your coding agent to do it. Start Local Review, then tell the agent
(Claude Code, Codex, pi or any other) where to read about it:

```text
Read http://localhost:5622/llms.txt and create a local-review project for my feature-xyz branch on ~/code/my-git-project
```

`npx local-review` prints this hint when it starts, with the port it's actually on. The agent reads the repo's
history (read-only), picks a slug, writes `~/.local-review/projects/<slug>/project.yaml`, checks it with
`local-review plan` and gives you the URL. The project shows up in the UI straight away.

## What's served where

| URL | What it is |
| --- | --- |
| `http://localhost:5622/llms.txt` | The running Local Review's copy, for the version you run. Use this one. |
| `http://localhost:5622/llms-full.txt` | The same, followed by the whole [agent guide](/agents/agent-guide/). |
| `http://localhost:5622/agent-guide.md` | The agent guide on its own, as `npx local-review guide` prints it. |
| [`/llms.txt`](/llms.txt) on this site | The same file without the live facts, for an agent that hasn't got Local Review running yet. It says to read the local one once it is. |
| [`/llms-full.txt`](/llms-full.txt) on this site | The same, followed by the agent guide. |
| Every page of this site, with `.md` | The page as Markdown: `/reference/project-yaml/` is also [`/reference/project-yaml.md`](/reference/project-yaml.md). Each page's `<head>` links its copy (`rel="alternate" type="text/markdown"`) and `/llms.txt` (`rel="describedby"`). |

All of them follow the [llms.txt proposal](https://llmstxt.org/): a title, a one-paragraph summary, the details, then
lists of links (here, to the pages' Markdown copies).

## What's in it

One fetch has what an agent needs to create a project:

- **The rules.** Reviewed repos are read-only; comments are never imported from GitHub, nor sent there; nothing in
  the data directory is deleted or replaced; nothing is pushed while setting up.
- **The recipe**: the agent guide's [Setting up a project](/agents/agent-guide/#setting-up-a-project) section,
  word for word.
- **The commented example `project.yaml`**, the one [`local-review init`](/reference/cli/#local-review-init-project)
  writes.
- **Links** to the agent guide and the reference pages (the full `project.yaml` schema, the data directory, prs and
  comment files, the HTTP API, the CLI).

The local copy adds **live facts**: the URL and version it's serving, the data directory and projects directory, the
reviewer's id, and the existing projects (slug, title, repos with their paths and branches; [hidden](/concepts/linked-projects/#hidden-projects) ones are listed too, and marked), so the agent can pick a
slug that isn't taken and spot a project that already covers the branch. Its URLs use the host and port the agent
reached it on, so `--port`, `PORT` and `npm run dev` all work.

## Safety

The local endpoints are read-only `GET`s, behind the same [localhost-only checks](/guarantees/localhost-security/) as
the rest of the server: a request with a `Host` that isn't localhost is refused. They show nothing the UI doesn't
already show to localhost: the same facts come from `GET /api/projects` and `GET /api/me`. They're served with
`Cache-Control: no-store`.

## Fetching from localhost

The server only listens on 127.0.0.1, and some agents' web-fetch tools won't fetch `http://localhost` (or upgrade
it to `https`). An agent with a shell fetches it with `curl -s http://localhost:5622/llms.txt` instead; the file says
so. One without either can read the same guide with `npx local-review guide`.

## Keeping it in step

The files are generated, never written by hand: `shared/llms.ts` builds them from `AGENT-GUIDE.md` and
`examples/project.example.yaml`, the server on every request and `npm run docs:llms` for this site's copies (committed
in `website/public/`). `npm test` fails while those are stale.
