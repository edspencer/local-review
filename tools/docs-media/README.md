# docs-media: screenshots from the demo test bed

Re-runnable screenshots for the docs site, the README and launch posts, all of the demo test bed
([demo/README.md](../../demo/README.md)). A redesign makes every image stale at once, so re-shooting is one command,
not someone re-deriving twenty click paths from memory.

```sh
npx playwright install chromium                  # once
npm run docs:media                               # seed demo/out if needed, boot the rig, take every shot
npm run docs:media -- --only crop-readiness,pr-threads
npm run docs:media -- --base http://localhost:5050   # a rig you started yourself
```

Output goes to `tools/docs-media/out/` (git-ignored): `<shot>.png`, `provenance.json` (each shot's route, viewport,
scale and crop, the app version and a hash of the seed) and `contact-sheet.png` (every shot on one page, labelled).
What gets copied into `website/` or the README is decided there, not here.

## The pieces

| File | Does |
| --- | --- |
| `shots.ts` | The shot list. Each shot has a route, actions to reach the state (click, hover, scroll, wait), and a capture: the viewport, the whole page, or a crop around one or more elements with padding and zoom. Each says what it's for. **Edit this to add a shot.** |
| `capture.ts` | Runs the shots: boots the rig, opens each in a fresh browser context and writes the PNGs. |
| `serve.sh` | Runs Local Review on a seed with a scrubbed environment. **The one place that says how the rig launches the app**: from source today (`scripts/start.mjs`, the compiled CLI); point `LAUNCH` at an installed `local-review` to shoot a release. |

## What makes the shots deterministic

- **The data:** the seed is byte-for-byte reproducible (`npm run demo:check`).
- **The clock:** relative times ("2 days ago") come from `Date.now()`, so the browser's clock is fixed at the
  demo's "now" (`DEMO_NOW` in `demo/world/people.ts`) with `page.clock`. Timers still run.
- **The browser:** a fresh context per shot, 1440×900 unless the shot says otherwise, light colour scheme, device
  scale factor 2 (a crop's `zoom` multiplies it), reduced motion, `en-GB`, UTC, and a stylesheet that turns off
  animations, transitions, carets and scrollbars. The mouse is parked in a corner before each shot.
- **Waiting:** for "Loading…" to go, fonts to load and images to decode, and for whatever the shot's own `waitFor`
  names, never a bare sleep. (Network idle never comes: the page holds an SSE connection open.)

## What the shots must not show

The UI prints where its files are (the review file, the prs file), and those are in the seed's scratch directory.
Before each shot the rig rewrites the seed's home to `~` and its own port to the default one (5622) in the page's
text, so the shots show what a real user would see: `~/.local-review/projects/…`. That's the only thing it changes.

Then it scans the page text and **refuses to write the shot** if anything looks like it belongs to the machine:
absolute paths (`/tmp/`, `/home/`, `/Users/`, …), loopback and private IPs, a `localhost` port other than 5622, or an
email outside `.example`. Add your own patterns (a hostname, say) as regex alternatives in `$LR_LEAK_EXTRA`; they're
not written in this file because it's public. The scan reads the DOM, not pixels, so look at the images too: the
contact sheet is there for that.

## Gotchas

- **Viewed files are collapsed.** A thread on a file marked Viewed isn't in the Files changed tab until the card
  is expanded; the seed keeps files with open threads unviewed.
- **A crop has to fit in the viewport.** The rig warns when one doesn't; give that shot a taller `viewport`.
- **`page.evaluate` and tsx:** esbuild wraps named functions in `__name()`, which doesn't exist in the page; the
  rig defines a no-op one in an init script. Keep that if you add evaluate calls.
