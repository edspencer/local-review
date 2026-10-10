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
| Writes must be JSON (`Content-Type: application/json`, else 415), which forces a CORS preflight it never grants. The one exception, an image upload, must be an image type (`image/png` and so on), and those force the preflight too. | **Cross-site requests**: a page POSTing a form or a "simple" request. |
| If the browser sends an `Origin` on a write, it must be localhost (else 403). | Cross-site requests from browsers that do send it. |

These live in `server/security.ts`.

## Images

Images are user content, so they get a few more checks of their own (`server/assets.ts`, and the routes in
`server/index.ts`):

- **Only image names.** An image is served only by a name of 16 hex digits and an image extension, from the project's
  `assets/` folder, and only if it's a regular file (not a symlink). Anything else, including `..` in any encoding, is
  a 404.
- **Only real images.** An upload, or `local-review asset add`, must be PNG, JPEG, GIF, WebP or SVG, and its bytes
  must match the type it claims: magic numbers, and for SVG, UTF-8 text with an `<svg` root element (a DOCTYPE with
  entity declarations is refused). Up to 5 MB, enforced before the body is buffered.
- **Served inert.** Every image is sent with its type from an allow-list, `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Resource-Policy: same-origin`, and the same Content Security Policy as the stack picture,
  `default-src 'none'; style-src 'unsafe-inline'`. In a page, browsers never run script in an `<img>` SVG; opened
  directly, the policy stops it there too.
- **Sanitised markdown.** The UI renders descriptions with DOMPurify as before; it only rewrites `assets/<name>` image
  sources and links to the image route after sanitising, and only ever to that route. There is **no `--host` flag** and no other way to expose it, on purpose.

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
