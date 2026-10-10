# website/CLAUDE.md

Astro + Starlight documentation site for Local Review, deployed to **https://local-review.edspencer.net** by
**Cloudflare Pages**. Its stack and structure deliberately match Paddock's docs site (`edspencer/paddock`,
`website/`), with much less content.

This package is **standalone**: it is NOT part of the root `local-review` package, so it never touches the app's
build, install, tests or npm tarball. Build it on its own from `website/`.

## Build & preview

```bash
cd website
npm install
npm run dev                        # local dev server
npm run build && npm run preview   # build + preview the built site
```

`rehype-mermaid` runs with `strategy: 'pre-mermaid'`, which only tags the `<pre>`; all rendering happens client-side
(`public/mermaid-init.js`, from the CDN), identically in dev and in the built output. Check diagrams in **both**
colour themes: Mermaid re-renders on every change to `<html data-theme>`.

The build deps (astro, starlight, tailwind) are intentionally in `dependencies`, not `devDependencies`, so a plain
`npm install` under `NODE_ENV=production` still installs them. That is what Cloudflare's build does, and what the
projects box exports. No `--include=dev` needed here.

## Content

Docs pages are `.md` / `.mdx` files under `src/content/docs/`. Every page needs Starlight frontmatter (at minimum
`title:`; quote values that contain a colon). Use Mermaid code fences for diagrams.

Most pages are **stubs** (a summary plus a "TODO: content" note naming the README section the content will come
from). The README is still the working source; migrating it here is a separate piece of work.

**The default port.** Never type the port number into a page. It is `DEFAULT_PORT` in `src/site.mjs` (it is going to
change from 5000); MDX pages import it from there (see `getting-started/quickstart.mdx`).

## Sidebar

The sidebar is maintained **by hand** in `astro.config.mjs` under `sidebar`. Starlight does NOT auto-discover pages:
add new pages there explicitly. Never point a sidebar entry at `/` (the landing page is outside Starlight; see below).

## Landing page

`src/pages/index.astro` is a custom marketing page, outside Starlight (a file route wins `/` over Starlight's injected
routes). It has its own layout (`src/components/landing/LandingLayout.astro`), its own unconditionally dark styles
(`src/styles/landing.css`), and its own small script (`src/scripts/landing.ts`). All of its copy lives in
`src/components/landing/copy.ts`.

Because it is outside Starlight it inherits nothing: head tags, analytics and the nav are re-provided by
`LandingLayout.astro`. Change a site-wide head tag in `astro.config.mjs` and check whether the layout needs it too.

**Placeholders.** Every screenshot slot on the landing page is a `<Placeholder>` (dashed, labelled "Screenshot
placeholder", saying what the shot should show). Replace them with real captures from the demo test bed: tight crops
of one feature each, at close to 1:1, put in `src/assets/landing/` and rendered with `astro:assets` `<Image>`.

## Brand assets

Plum `#4a1942` and amber `#e8a33d`, from the app's header. The logo, favicons, Apple touch icon and social card are
**copied** from the repo's `brand/` kit by `npm run sync-brand` (`scripts/sync-brand.mjs`), and the copies are
committed. Cloudflare builds with `website/` as its root, so nothing under `../brand` is reachable at build time.
Don't hand-edit the copies: change `brand/`, re-run the script, commit.

- `public/favicon.svg`, `public/favicon.ico`, `public/apple-touch-icon.png`: icons (linked by both
  `astro.config.mjs` and `LandingLayout.astro`)
- `public/og-image.png`: the 1200×630 social card, for every page
- `src/assets/lockup-on-plum.svg`: `brand/lockup-dark.svg` plus a faint tile edge. The docs header logo
  (`replacesTitle`) and the landing nav. One lockup for both themes on purpose: the header is plum in both, and
  `brand/README.md` picks the lockup by background, not by theme.

Follow `brand/README.md`'s usage rules. In particular, **amber is not a text colour on white** (about 2:1): that is
why the light theme's accent is plum, and amber appears only on plum or near-black.

## Analytics

PostHog, **off unless `PUBLIC_POSTHOG_KEY` is set at build time** (a Cloudflare Pages variable, or a local `.env`).
With it unset, no analytics code is emitted anywhere. The snippet is built by `posthogSnippet()` in `src/site.mjs`,
used both by `astro.config.mjs` (Starlight pages) and by `LandingLayout.astro` (the landing page).

When on, `api_host` is `https://local-review.edspencer.net/ingest`, and `functions/ingest/[[path]].ts`, a Cloudflare
Pages Function, forwards it to PostHog's US cloud. Change the region in one and you must change it in the other.

`functions/` is the only part of this directory that Cloudflare runs rather than serves. It is invisible to
`astro build`, so a broken proxy will not fail the build or show up in `npm run preview`. Verify it against a deploy
preview.

## Deploy (Cloudflare Pages)

Cloudflare Pages builds this directory directly from the GitHub repo (git integration; no GitHub Actions):

- Root directory: `website`
- Build command: `npm install && npm run build`
- Build output directory: `dist` (i.e. `website/dist`)
- Custom domain: `local-review.edspencer.net`
- Optional variable: `PUBLIC_POSTHOG_KEY`
