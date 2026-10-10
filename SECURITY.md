# Security policy

## Supported versions

Fixes go into the latest minor release only. Upgrade with `npm i -g local-review@latest`, or just run
`npx local-review@latest`.

## Reporting a vulnerability

Please report it privately through GitHub's private vulnerability reporting:
**https://github.com/edspencer/local-review/security/advisories/new**. Don't open a public issue or pull request for
it.

Say what you found, which version, and how to reproduce it. You'll get an acknowledgement, and we'll agree on a fix
and a disclosure date with you before anything is published. Local Review is maintained by one person, so allow a
few days for a first response.

## What Local Review protects

Local Review runs on your machine, reads git repos you point it at and keeps your review comments in
`~/.local-review`. What it's built to guarantee, and so what counts as a vulnerability if broken:

- **Only you can reach it.** The server binds 127.0.0.1 only, never a public interface. It answers only requests
  whose `Host` is `localhost`, `127.0.0.1` or `[::1]`, which stops DNS-rebinding attacks from a web page you visit.
  It accepts writes only as JSON and, when the browser sends an `Origin`, only from localhost, which stops
  cross-site request forgery. (`server/security.ts`; README ["Run"](README.md#run).)
- **Reviewed repos are never modified.** All git access goes through one module with a read-only allow-list of
  subcommands, no shell, no options that write files or run programs, and only refs from your `project.yaml` or shas
  git itself returned. (`server/git.ts`; README ["Read-only guarantee"](README.md#read-only-guarantee).)
- **Your data is never irreparably deleted.** Writes are atomic and never clobber, nothing is unlinked or truncated
  except guarded snapshot pruning, and paths are validated so nothing can leave `~/.local-review/projects/`. A test
  fails the build if any other code gains a way to delete or overwrite files. (`server/safefs.ts`,
  `server/backups.ts`; README ["Where your data lives"](README.md#where-your-data-lives).)

Out of scope: anything that needs an attacker who can already run code as you, or write to your `~/.local-review`
or your repos. Local Review trusts its own config and data files the way your shell trusts your dotfiles.
