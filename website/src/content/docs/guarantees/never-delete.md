---
title: Never-delete guarantee
description: Your reviews are never deleted, and are snapshotted automatically.
---

Local Review never deletes your comment or PR files. Writes are atomic, files are renamed rather than overwritten, and the whole `projects/` directory is snapshotted hourly into `backups/` whenever it changes.

:::note[TODO: content]
This page is a stub. Its content will move here from the README's "Where your data lives" and "Comment files" sections.
:::
