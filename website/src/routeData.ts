// Starlight route middleware: each docs page's <head> links its Markdown copy (src/pages/[...slug].md.ts) and the
// llms.txt that describes the site, the two link relations the llms.txt proposal asks for (https://llmstxt.org).
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute;
	// the 404 page has no Markdown copy
	if (route.id !== '404') route.head.push({ tag: 'link', attrs: { rel: 'alternate', type: 'text/markdown', href: `/${route.id}.md` } });
	route.head.push({ tag: 'link', attrs: { rel: 'describedby', type: 'text/plain', href: '/llms.txt' } });
});
