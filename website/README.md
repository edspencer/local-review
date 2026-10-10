# Local Review documentation site

The [Astro](https://astro.build) + [Starlight](https://starlight.astro.build) documentation site for Local Review,
served at **https://local-review.edspencer.net**.

A standalone package: it is not part of the root `local-review` package, so it never affects the app's build, tests
or npm tarball.

## Develop

```bash
cd website
npm install
npm run dev                       # local dev server
npm run build && npm run preview  # build + preview the built site
```

## Structure

- `src/pages/index.astro` and `src/components/landing/`: the marketing landing page at `/` (outside Starlight). Its
  copy is all in `src/components/landing/copy.ts`.
- `src/content/docs/`: the documentation pages (`.md` / `.mdx`, Starlight frontmatter).
- `astro.config.mjs`: site config and the hand-maintained sidebar.
- `src/site.mjs`: site constants (URL, repo, tagline, **the default port**) and the analytics snippet.
- `src/assets/`, `public/`, `src/styles/`: logo, favicons, social card, theme.
- `functions/ingest/[[path]].ts`: the Cloudflare Pages Function that proxies analytics (idle unless analytics is on).

`npm run build` writes the static site to `dist/`, including the Pagefind search index (`dist/pagefind/`) and the
sitemap (`dist/sitemap-index.xml`).

## Brand assets

The logo, favicons, Apple touch icon and social card are **copied** from the repo's [`brand/`](../brand) kit, not
referenced from it: Cloudflare builds with `website/` as its root directory and can't see `../brand`. To refresh
them after `brand/` changes, run this and commit the result:

```bash
npm run sync-brand
```

| From `brand/` | To | Used as |
| --- | --- | --- |
| `favicon.svg`, `favicon.ico` | `public/` | favicons |
| `apple-touch-icon.png` | `public/` | `<link rel="apple-touch-icon">` |
| `og-image.png` | `public/` | `og:image` / `twitter:image` |
| `lockup-dark.svg`, plus a faint tile edge | `src/assets/lockup-on-plum.svg` | the docs header logo and the landing nav |

The docs header is plum in both themes, so it always uses the white-wordmark lockup (`brand/README.md`: pick the
lockup by background, and give the tile a faint edge on plum).

## Deploy

Built and served by **Cloudflare Pages** from the GitHub repo (git integration, no Actions):

| Setting | Value |
| --- | --- |
| Framework preset | Astro (or None) |
| Production branch | `main` |
| Root directory | `website` |
| Build command | `npm install && npm run build` |
| Build output directory | `dist` |
| Custom domain | `local-review.edspencer.net` |

Every PR that touches the repo also gets a preview deployment.

## Analytics (off by default)

PostHog analytics loads **only if `PUBLIC_POSTHOG_KEY` is set when the site is built**. To turn it on, add it in
Cloudflare Pages → the project → Settings → Variables and Secrets (as a plain-text variable, for Production and,
if wanted, Preview), then redeploy. The key is a public `phc_…` project key; it ends up in every page's HTML either
way. To try it locally, put `PUBLIC_POSTHOG_KEY=phc_…` in `website/.env` (git-ignored).

Requests go to `/ingest` on the site's own domain and are forwarded to PostHog's US cloud by
`functions/ingest/[[path]].ts`. See `website/CLAUDE.md`.
