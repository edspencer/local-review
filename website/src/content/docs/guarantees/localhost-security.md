---
title: Localhost security
description: The server only listens on, and only answers, localhost.
---

The server binds to 127.0.0.1 only, answers only requests whose `Host` is localhost (against DNS rebinding), and only accepts JSON writes from a localhost origin (against cross-site requests).

:::note[TODO: content]
This page is a stub. Its content will move here from the README's "Run" section.
:::
