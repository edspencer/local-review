// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import rehypePreMermaid from './src/plugins/rehype-pre-mermaid.mjs';
import rehypeShots from './src/plugins/rehype-shots.mjs';
import { SITE_URL, REPO_URL, TITLE, TAGLINE, posthogSnippet } from './src/site.mjs';

// PUBLIC_POSTHOG_KEY comes from the build environment (Cloudflare Pages
// variables) or a local .env. Unset — the default — means no analytics at all.
// See src/site.mjs and website/README.md.
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), 'PUBLIC_');
const posthog = posthogSnippet(env.PUBLIC_POSTHOG_KEY);

// https://astro.build/config
export default defineConfig({
	site: SITE_URL,
	// Astro 7's default, 'jsx', strips whitespace between elements, which glues inline
	// text together ("Edit pagePrevious…"). `true` keeps Astro 5/6's HTML-aware rules.
	compressHTML: true,
	vite: {
		plugins: [tailwindcss()],
	},
	markdown: {
		// Astro 7 renders Markdown with Sätteri by default, which doesn't run rehype
		// plugins; the unified (remark/rehype) processor does. Mermaid code fences are
		// pre-processed here and rendered client-side (see head script). Screenshots get
		// their 2x sizing and, with a title, a caption (src/plugins/rehype-shots.mjs).
		processor: unified({ rehypePlugins: [rehypePreMermaid, rehypeShots] }),
	},
	integrations: [
		sitemap(),
		starlight({
			title: TITLE,
			customCss: ['./src/styles/tailwind.css', './src/styles/custom.css'],
			// Brand assets are COPIED from ../brand by `npm run sync-brand` (Cloudflare
			// builds with website/ as its root, so ../brand is out of reach). One logo
			// for both themes, on purpose: the header is plum in both, and brand/README.md
			// picks the lockup by background, so it is always the white wordmark.
			logo: {
				src: './src/assets/lockup-on-plum.svg',
				alt: TITLE,
				replacesTitle: true,
			},
			favicon: '/favicon.svg',
			// Each page's <head> links its Markdown copy and /llms.txt, for agents (src/routeData.ts).
			routeMiddleware: './src/routeData.ts',
			head: [
				// .ico fallback for the browsers and crawlers that ignore SVG icons.
				{ tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '32x32' } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
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
						{ label: 'Linked projects', slug: 'concepts/linked-projects' },
						{ label: 'Branches', slug: 'concepts/branches' },
						{ label: 'Following rebases', slug: 'concepts/following-rebases' },
						{ label: 'Works with your stacking tool', slug: 'concepts/stacking-tools' },
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
						{ label: 'llms.txt: setting up a project', slug: 'agents/llms-txt' },
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
						{ label: 'Where your data lives', slug: 'reference/data-directory' },
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
