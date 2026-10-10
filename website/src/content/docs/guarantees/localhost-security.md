---
title: Localhost security
description: The server only listens on, and only answers, localhost.
---

**Only you can reach Local Review.** The server binds to `127.0.0.1` only, never a public interface, and it checks every
request, so that a web page you happen to visit can't reach it through your browser either.

| Check | Stops |
| --- | --- |
| It listens on `127.0.0.1` only. | Anyone else on your network. |
| It answers only requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]` (else 403). | **DNS rebinding**: a page on a domain that resolves to 127.0.0.1. |
| Writes must be JSON (`Content-Type: application/json`, else 415), which forces a CORS preflight it never grants. | **Cross-site requests**: a page POSTing a form or a "simple" request. |
| If the browser sends an `Origin` on a write, it must be localhost (else 403). | Cross-site requests from browsers that do send it. |

These live in `server/security.ts`. There is **no `--host` flag** and no other way to expose it, on purpose.

## Using it from somewhere else

Because it only answers localhost, you can't open it from another machine, a phone, or a container through a forwarded
hostname. Run it where you review, or use an SSH tunnel that arrives as localhost:

```sh
ssh -L 5622:localhost:5622 devbox      # then open http://localhost:5622 on your laptop
```

## What's in scope

What counts as a vulnerability, and how to report one privately, is in
[SECURITY.md](https://github.com/edspencer/local-review/blob/main/SECURITY.md). Out of scope: anything that needs an
attacker who can already run code as you, or write to your `~/.local-review` or your repos. Local Review trusts its
own config and data files the way your shell trusts your dotfiles.
