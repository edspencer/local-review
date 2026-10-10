# Local Review brand kit

The mark is a stack of PRs, and the front one has been reviewed: three offset cards with an amber card and a check in
front. It sits on a deep plum tile, the same plum and amber as the app header, which is deliberately not GitHub (README
"The deliberate 'not GitHub' difference").

## Files

| File | What it is | Use it for |
|---|---|---|
| `mark.svg` | The mark: 32×32, hand-authored. **The source of everything else.** | Anywhere a square icon is needed |
| `lockup-light.svg` | The mark + "Local Review" in plum (Inter Bold, as paths) | Light backgrounds (Starlight `logo.light`) |
| `lockup-dark.svg` | The mark + "Local Review" in white | Dark backgrounds (Starlight `logo.dark`) |
| `favicon.svg` | A copy of `mark.svg` | `<link rel="icon" type="image/svg+xml">` |
| `favicon.ico` | 16, 32 and 48px PNGs in one ICO | `<link rel="icon" sizes="32x32">`, old browsers, `/favicon.ico` |
| `apple-touch-icon.png` | 180×180, full-bleed (iOS rounds the corners) | `<link rel="apple-touch-icon">` |
| `icon-192.png`, `icon-512.png` | Web manifest icons | `manifest.webmanifest` |
| `og-image.png` | 1200×630 card | `og:image` / `twitter:image` on the docs site |
| `social-preview.png` | 1280×640 card | GitHub repo Settings → Social preview |
| `generate.mjs` | Builds every file above except `mark.svg` | See "Regenerating" |

The SVGs need no fonts: the wordmark is converted to outlines. Inter is under the SIL Open Font Licence
(`server/fonts/Inter-OFL.txt`), which allows that.

## Colours

| Name | Hex | Where |
|---|---|---|
| Plum | `#4a1942` | The tile, the light-background wordmark, the app header (`--plum`) |
| Plum, light end | `#5c1f52` | The far end of the header and card gradients |
| Amber | `#e8a33d` | The front card, the header underline, the "not on GitHub" pill |
| Ink | `#2b0f27` | The check, and any text on amber |
| Mauve | `#a8749d` | The back card |
| Lilac | `#ead6e5` | The middle card, and light text on plum |

## Usage rules

- **Keep the tile.** The mark is the plum tile with its cards. Don't recolour it or set the cards on another
  background, except as the faint watermark the social cards use.
- **Pick the lockup by background**, not by theme name: `lockup-light.svg` on white or pale backgrounds,
  `lockup-dark.svg` on dark ones. On plum, use the white wordmark and give the tile a faint edge, as the social cards do.
- **Clear space** around the mark is at least a quarter of its width. Don't place it smaller than 16px; at 16px use
  `favicon.ico` or `favicon.svg` unchanged (the mark is drawn on a pixel grid for that size).
- **Amber isn't a text colour on white.** It fails contrast (about 2:1). Use it for fills, lines and text on plum.
- The app header keeps its letter-spaced **LOCAL REVIEW** wordmark. The title-case lockup is for the docs, README and
  social cards.

## Regenerating

```sh
node brand/generate.mjs
```

It needs only the repo's own dependencies (`@resvg/resvg-js` and `opentype.js`) and the fonts in `server/fonts/`.
The output is deterministic, so commit what it writes. Edit `mark.svg` for the mark, and the constants at the top of
`generate.mjs` for the colours, tagline and URL.

The app's `index.html` links `favicon.ico`, `favicon.svg` and `apple-touch-icon.png` from here; Vite copies them into
`dist/assets/` with hashed names.
