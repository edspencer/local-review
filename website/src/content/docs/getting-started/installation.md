---
title: Installation
description: Run Local Review with npx, install it globally, or run it from a clone.
---

Local Review is a Node.js app that runs on your own machine. It needs **Node.js 22 or later** and **git**, and supports
**macOS and Linux**. Windows is untested: it may work, but nothing is promised.

## Run it with npx

No install step; npx fetches it on first use:

```sh
npx local-review                   # serve the UI + API on http://localhost:5622
npx local-review init my-feature   # create a project to review
```

`npx local-review@latest` makes sure you're on the newest release.

## Install it globally

```sh
npm i -g local-review
local-review                       # the same commands, without npx
```

Every command and flag: [CLI](/reference/cli/).

## Ports

It serves on `http://localhost:5622`, bound to 127.0.0.1 only. If that port is in use, it says so and exits: pick
another with `--port <n>` or `PORT=<n>`:

```sh
npx local-review --port 5050
```

:::caution[Upgrading from before 0.2.0?]
The default port was 5000 until 0.2.0, which clashes with AirPlay on macOS. If you have bookmarks, scripts or agent
prompts with `localhost:5000`, update them, or keep the old port with `--port 5000`. See [What's new](/whats-new/).
:::

## Run it from a checkout

To work on Local Review itself:

```sh
git clone https://github.com/edspencer/local-review.git
cd local-review
npm install
npm start                          # build what's stale, then run the compiled CLI (npm start -- --port 5050)
npm run lr -- plan my-feature      # any local-review command, from source
```

`npm run dev` runs Vite with hot reload. The rest (tests, the build, conventions) is in
[Contributing](/contributing/).

## Your data

Whichever way you run it, your projects and reviews live in `~/.local-review/`, never in the package or the repos you
review, so upgrading or reinstalling never touches them. See [Where your data lives](/reference/data-directory/).
