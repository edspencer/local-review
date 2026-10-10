---
"local-review": minor
---

Images in PR descriptions, stack notes and the project intro. Paste, drop or attach an image in any of their editors,
or add one with `local-review asset add <project> <file>`, which prints the markdown (`![alt](assets/<hash>.png)`).
Images live in the project's `assets/` folder, named by their content, and are never replaced or deleted; snapshots
hard-link them instead of copying them. PNG, JPEG, GIF, WebP and SVG up to 5 MB, checked by their contents, and served
with `nosniff` and a Content Security Policy that stops an SVG running script. GitHub can't show a local image, so
`local-review plan` warns about each one, and puts its URL in the body instead once you record where it's published
with `local-review asset url <project> <name> <url>`.
