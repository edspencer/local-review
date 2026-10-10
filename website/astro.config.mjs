// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import rehypeMermaid from 'rehype-mermaid';
import tailwindcss from '@tailwindcss/vite';
import { SITE_URL, REPO_URL, TITLE, TAGLINE, posthogSnippet } from './src/site.mjs';

// PUBLIC_POSTHOG_KEY comes from the build environment (Cloudflare Pages
// variables) or a local .env. Unset — the default — means no analytics at all.
// See src/site.mjs and website/README.md.
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), 'PUBLIC_');
const posthog = posthogSnippet(env.PUBLIC_POSTHOG_KEY);

// https://astro.build/config
export default defineConfig({
	site: SITE_URL,
	vite: {
		plugins: [tailwindcss()],
	},
	markdown: {
		// Mermaid code fences are pre-processed here and rendered client-side (see head script).
		rehypePlugins: [[rehypeMermaid, { strategy: 'pre-mermaid' }]],
	},
	integrations: [
		sitemap(),
		starlight({
			title: TITLE,
			tagline: TAGLINE,
			customCss: ['./src/styles/tailwind.css', './src/styles/custom.css'],
			// PLACEHOLDER brand assets: logo.svg, public/favicon.svg, public/favicon.ico
			// and public/og-image.png are stand-ins until the branding work lands.
			// Swap the files in place; nothing here needs to change.
			logo: {
				src: './src/assets/logo.svg',
				alt: TITLE,
			},
			favicon: '/favicon.svg',
			head: [
				// .ico fallback for the browsers and crawlers that ignore SVG icons.
				{ tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '32x32' } },
				// Mermaid: themed from Starlight, and kept legible rather than scaled
				// down to fit. Lives in public/mermaid-init.js (copied from Paddock's site).
				{ tag: 'script', attrs: { type: 'module', src: '/mermaid-init.js' } },
				// PostHog, only when PUBLIC_POSTHOG_KEY is set at build time. The landing
				// page (outside Starlight) emits the same snippet from the same helper.
				...(posthog ? [{ tag: /** @type {const} */ ('script'), content: posthog }] : []),
				// Social-share image. Starlight already emits per-page og:title,
				// og:description, og:url and twitter:card=summary_large_image, and a user
				// `head` entry OVERRIDES those, so we must not restate them here. The one
				// thing Starlight has no default for is the image.
				{ tag: 'meta', attrs: { property: 'og:image', content: `${SITE_URL}/og-image.png` } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: `${TITLE}: ${TAGLINE.toLowerCase()}` } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: `${SITE_URL}/og-image.png` } },
			],
			social: [{ icon: 'github', label: 'GitHub', href: REPO_URL }],
			editLink: {
				baseUrl: `${REPO_URL}/edit/main/website/`,
			},
			// Hand-maintained: Starlight does NOT auto-discover pages. Add new ones here.
			sidebar: [
				{
					label: 'Getting Started',
					collapsed: false,
					items: [
						// NOT `link: '/'`: `/` is the marketing landing page, which renders
						// outside Starlight with no sidebar and no way back.
						{ label: 'Introduction', slug: 'introduction' },
						{ label: 'Quickstart', slug: 'getting-started/quickstart', badge: { text: 'npx', variant: 'tip' } },
						{ label: 'Installation', slug: 'getting-started/installation' },
					],
				},
				{
					label: 'Concepts',
					collapsed: false,
					items: [
						{ label: 'Projects & repos', slug: 'concepts/projects-and-repos' },
						{ label: 'PR stacks', slug: 'concepts/pr-stacks' },
						{ label: 'Commits as PRs', slug: 'concepts/commits-as-prs' },
						{ label: 'Readiness', slug: 'concepts/readiness' },
						{ label: 'Landed PRs', slug: 'concepts/landed-prs' },
						{ label: 'Follow-on stacks', slug: 'concepts/follow-on-stacks' },
					],
				},
				{
					label: 'Using Local Review',
					collapsed: false,
					items: [
						{ label: 'A tour of the UI', slug: 'using/ui-tour' },
						{ label: 'Reviewing & comments', slug: 'using/reviewing-and-comments' },
						{ label: 'Editing PR titles & descriptions', slug: 'using/editing-pr-text' },
						{ label: 'Stack pictures', slug: 'using/stack-pictures' },
						{ label: 'Keyboard shortcuts', slug: 'using/keyboard-shortcuts' },
					],
				},
				{
					label: 'Working with agents',
					collapsed: false,
					items: [
						{ label: 'Agent guide', slug: 'agents/agent-guide' },
						{ label: 'Comment files', slug: 'agents/comment-files' },
						{ label: 'The plan command', slug: 'agents/plan-command' },
						{ label: 'Publishing as GitHub stacked PRs', slug: 'agents/publishing-stacked-prs' },
						{ label: 'Hand-off prompt', slug: 'agents/hand-off-prompt' },
					],
				},
				{
					label: 'Reference',
					collapsed: true,
					items: [
						{ label: 'CLI', slug: 'reference/cli' },
						{ label: 'project.yaml', slug: 'reference/project-yaml' },
						{ label: 'Comment files schema', slug: 'reference/comment-files' },
						{ label: 'PR files schema', slug: 'reference/pr-files' },
						{ label: 'HTTP API', slug: 'reference/http-api' },
						{ label: 'Environment variables', slug: 'reference/environment' },
					],
				},
				{
					label: 'Guarantees & security',
					collapsed: false,
					items: [
						{ label: 'Read-only guarantee', slug: 'guarantees/read-only' },
						{ label: 'Never-delete guarantee', slug: 'guarantees/never-delete' },
						{ label: 'Localhost security', slug: 'guarantees/localhost-security' },
					],
				},
				{ label: 'Contributing', slug: 'contributing' },
				{ label: "What's new", slug: 'whats-new' },
			],
		}),
	],
});
