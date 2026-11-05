---
'local-review': patch
---

**`service install` checks linger on Linux** (cli-contract SPEC §7) instead of always printing a reminder. It asks
`loginctl show-user <user> -p Linger`, and only when linger is off does it say why it matters (the service stops when
you log out) and print `sudo loginctl enable-linger <user>`, the same line `doctor` gives. It never runs `sudo`. When
linger is on, or `loginctl` can't answer (no logind, a container), it says nothing about it. With `--json`, the
advice is in the document's `warnings`. The old reminder line, `loginctl enable-linger $USER` without `sudo`, has
gone from the install output.
