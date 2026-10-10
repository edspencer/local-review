// @ts-check
/**
 * Site-wide constants, in one place.
 *
 * Plain .mjs rather than .ts because astro.config.mjs imports it too, and the
 * config is loaded before any TypeScript tooling is in play.
 */

export const SITE_URL = 'https://local-review.edspencer.net';
export const REPO_URL = 'https://github.com/edspencer/local-review';
export const TITLE = 'Local Review';
export const TAGLINE = 'Review your PR stacks before you create them';

/**
 * The port Local Review serves on by default.
 *
 * NOT FINAL. 5000 clashes with macOS's AirPlay Receiver and is going to change;
 * the new number has not been picked yet. Every mention of the default port on
 * this site comes from this constant (MDX pages import it), so the switch is one
 * edit here. Do not type the number into a page by hand.
 */
export const DEFAULT_PORT = 5000;
export const LOCAL_URL = `http://localhost:${DEFAULT_PORT}`;

/**
 * PostHog, OFF unless a key is supplied at build time.
 *
 * Paddock's site commits its public phc_ key. This one deliberately does not:
 * nothing analytics-related loads at all unless PUBLIC_POSTHOG_KEY is set in the
 * build environment (Cloudflare Pages → Settings → Variables). With it unset the
 * snippet below is never emitted, on the docs pages or the landing page.
 *
 * `api_host` is our own /ingest path, proxied to PostHog's US cloud by
 * functions/ingest/[[path]].ts, so requests are same-origin and survive tracker
 * blocklists. Change the region in one and you must change it in the other.
 *
 * @param {string | undefined} key
 * @returns {string | null} the inline script body, or null when analytics is off
 */
export function posthogSnippet(key) {
	if (!key) return null;
	// Verbatim from PostHog's install snippet (a minified stub that queues calls
	// until array.js loads). Vendor code: do not hand-maintain it.
	const stub = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group identify setPersonProperties setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags resetGroups onFeatureFlags addFeatureFlagsHandler onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`;
	const config = {
		api_host: `${SITE_URL}/ingest`,
		ui_host: 'https://us.posthog.com',
		person_profiles: 'identified_only',
	};
	return `${stub}posthog.init(${JSON.stringify(key)},${JSON.stringify(config)});`;
}
