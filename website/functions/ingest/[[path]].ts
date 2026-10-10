/**
 * PostHog reverse proxy.
 *
 * Analytics is OFF unless PUBLIC_POSTHOG_KEY is set at build time (see
 * src/site.mjs). With no key, no page ever calls /ingest and this function sits
 * idle; it is kept so that turning analytics on is a single Cloudflare variable,
 * not a code change.
 *
 * When it is on, the snippet points `api_host` at
 * https://local-review.edspencer.net/ingest rather than at PostHog directly, so
 * analytics requests are same-origin and are not dropped by the tracker
 * blocklists that ship in most browsers and extensions. This function is the
 * other half of that: it forwards /ingest/* on to PostHog's US cloud.
 *
 * Cloudflare Pages picks this up automatically from `functions/` under the
 * project root directory (`website/`). There is no build step or wrangler
 * config to keep in sync.
 *
 * The two-host split matters. PostHog serves the SDK bundles from a separate
 * assets host, and the install snippet's built-in
 * `api_host.replace('.i.posthog.com', '-assets.i.posthog.com')` is a no-op once
 * api_host is our own domain, so the routing has to happen here instead.
 *
 * Checked against PostHog (2026-10-10): /static/array.js comes back from the
 * assets host, /e/ events are accepted, and the SDK's /array/<key>/config(.js)
 * remote-config request is served by the API host as well as the assets host,
 * so it needs no route of its own.
 */
export const onRequest: PagesFunction = async ({ request }) => {
	const url = new URL(request.url);
	const path = url.pathname.replace(/^\/ingest/, '');

	const origin = path.startsWith('/static/')
		? 'https://us-assets.i.posthog.com'
		: 'https://us.i.posthog.com';

	// Drop Host: it still says local-review.edspencer.net here, and forwarding
	// that upstream makes PostHog serve (or reject) against the wrong vhost.
	const headers = new Headers(request.headers);
	headers.delete('host');

	return fetch(`${origin}${path}${url.search}`, {
		method: request.method,
		headers,
		body: request.body,
	});
};
