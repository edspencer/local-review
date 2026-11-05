---
'local-review': minor
---

**`--json` on `service install`, `uninstall`, `start`, `stop` and `restart`** (cli-contract SPEC §1), as `service
status` already had. With it, stdout carries exactly one JSON document, `{ ok, action, error?, … }` followed by every
field of `service status --json` as it is afterwards, and the messages that used to go to stdout go to stderr. The
exit code is the one without `--json`. `error` is `busy` on exit 75, `not installed` on exit 4, and the reason on exit
1, including an install that's refused (npx's cache, a checkout, a port in use). Each command adds what it found:
`install` `dryRun` (and `definition`, the file it would write), `refreshed` and `changed`; `start` and `stop`
`wasRunning`; `restart` `rewritten`; `uninstall` `wasInstalled`. It's the same shape as Hallway's.

Scripts that passed `--json` to these commands used to get a usage error (exit 2); now they get the document.
`service logs --json` is still a usage error.
