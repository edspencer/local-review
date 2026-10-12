# docs-media: screenshots from the demo test bed

Re-runnable screenshots for the docs site, the README and launch posts, all of the demo test bed
([demo/README.md](../../demo/README.md)). A redesign makes every image stale at once, so re-shooting is one command,
not someone re-deriving twenty click paths from memory.

```sh
npx playwright install chromium                  # once
npm run docs:media                               # seed demo/out if needed, boot the rig, take every shot
npm run docs:media -- --only crop-readiness,pr-threads
npm run docs:media -- --base http://localhost:5050   # a rig you started yourself
npm run docs:media:gif                           # the demo GIF and the landing page's video (needs ffmpeg)
npm run docs:media:sync                          # copy what the site and the README use into place (needs ffmpeg)
```

So a full re-shoot is `npm run docs:media && npm run docs:media:gif && npm run docs:media:sync`, then look at the
contact sheet and `git diff --stat`, and commit.

Output goes to `tools/docs-media/out/` (git-ignored): `<shot>.png`, `provenance.json` (each shot's route, viewport,
scale and crop, the app version and a hash of the seed) and `contact-sheet.png` (every shot on one page, labelled).

## Where the images go

`docs:media:sync` copies them into the places they're committed. **What it copies is read from the pages**, so there
is no second list: every `assets/shots/<shot>.png` or `assets/landing/<shot>.png` mentioned anywhere under
`website/src/` is copied from `out/<shot>.png` (and a copy nothing mentions any more is deleted). To use a shot on a
docs page, reference it and re-run the sync; `npm test` fails if a page uses a shot that isn't in `shots.ts`, or whose
copy isn't committed, or if a `SHOT:` placeholder is left anywhere.

| Destination | What | Served |
| --- | --- | --- |
| `website/src/assets/shots/` | docs page images: `![alt](../../../assets/shots/<shot>.png "caption")` | by Astro as webp, 1x and 2x, at half the PNG's size (`website/src/plugins/rehype-shots.mjs`) |
| `website/src/assets/landing/` | the landing page's feature images and the hero video's poster | by Astro, the same way (`ScrollFeatures.astro`, `Hero.astro`) |
| `website/public/demo/demo.mp4` | the landing hero's video | as is |
| `docs/media/demo.gif`, `docs/media/readme-hero.png` | the README's images (the hero is `pr-conversation` scaled to 1600px and palette-quantised) | from `raw.githubusercontent.com/…/main/`, as is, on GitHub and npm |

The README's images are absolute URLs on `main`, so a new one 404s until its PR merges.

## The demo GIF (`gif.ts`)

One review round trip, about 16 seconds: the reviewer drags across five line numbers and comments, the agent's reply
lands in the thread (written into the review's YAML file, as an agent does), the reviewer resolves it and marks the PR
ready, and the sidebar's tally goes from 1/3 to 2/3 ready. It mutates its data, so it seeds a fresh copy of the demo in
the system temp dir every run, never `demo/out`. Frames are 2x screenshots of each beat (with a drawn pointer, since
screenshots have none), held for set times and encoded by ffmpeg: a GIF (1400px wide, 128 colours, under 1 MB) and an
H.264 MP4 the same size. `--skip-shoot` re-encodes the last run's frames.

The browser's clock is pinned to the demo's "now", as for the stills, but the server stamps the new comment with the
real time, which would read as weeks old. So the script re-dates that one comment to the demo's "now" in the YAML
before the next frame. That is the only thing in it that is staged.

## Other rigs

Most shots are of the demo seed itself, but a few states aren't in it: a brand-new install, the example projects, an
image in a description. A shot with `rig:` (`RIGS` in `shots.ts`) is taken on a rig of its own: a throwaway copy of
the seed, or an empty data home, in the system temp dir (never `demo/out`), prepared by the rig's `prepare` step with
the real CLI, served on its own port, and deleted afterwards.

| Rig | What | Staged? |
| --- | --- | --- |
| `empty` | no projects: `/` is the welcome page | no |
| `examples` | an empty home after `local-review examples` | no |
| `image` | the seed, plus a diagram added with `local-review asset add` and put in a stack note, for the lightbox | **yes**: say so in the caption |

## Composed shots

Two of the landing page's pictures put a crop beside something that isn't a page of the app: the project.yaml that
made the sidebar (`landing-project-yaml`), and what `local-review plan` prints for a ready PR (`landing-plan`). A shot
with `compose` instead of a `route` builds its page from earlier shots, seed files and CLI output (`ComposeContext`
in `shots.ts`), all real, then gets cropped and leak-scanned like the rest. They are styled square and borderless,
because the landing page frames them.

## The pieces

| File | Does |
| --- | --- |
| `shots.ts` | The shot list. Each shot has a route, actions to reach the state (click, hover, scroll, wait), and a capture: the viewport, the whole page, or a crop around one or more elements with padding and zoom. Each says what it's for. **Edit this to add a shot.** |
| `capture.ts` | Runs the shots: boots the rig, opens each in a fresh browser context and writes the PNGs. |
| `gif.ts` | The demo GIF and the landing hero's video, from a scripted review round trip. |
| `sync.ts` | Copies the outputs the site and the README use into place. |
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

The UI prints where its files are (the review file, the prs file). It shows paths under the home directory as `~/…`,
and `serve.sh` sets `HOME` to the seed's own home, so the shots show what a real user would see,
`~/.local-review/projects/…`, with nothing rewritten.

Before writing a shot the rig scans the page text and **refuses to write it** if anything looks like it belongs to
the machine: absolute paths (`/tmp/`, `/home/`, `/Users/`, …), loopback and private IPs, a `localhost` port other
than 5622, or an email outside `.example`. Add your own patterns (a hostname, say) as regex alternatives in
`$LR_LEAK_EXTRA`; they're not written in this file because it's public. The scan reads the DOM, not pixels, so look at the images too: the
contact sheet is there for that.

## Gotchas

- **Viewed files are collapsed.** A thread on a file marked Viewed isn't in the Files changed tab until the card
  is expanded; the seed keeps files with open threads unviewed.
- **A crop has to fit in the viewport.** The rig warns when one doesn't; give that shot a taller `viewport`.
- **`page.evaluate` and tsx:** esbuild wraps named functions in `__name()`, which doesn't exist in the page; the
  rig defines a no-op one in an init script. Keep that if you add evaluate calls.
