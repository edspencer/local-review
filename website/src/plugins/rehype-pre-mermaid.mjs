// @ts-check
/**
 * Turns ```mermaid code fences into `<pre class="mermaid">diagram source</pre>`, for
 * `public/mermaid-init.js` to render in the browser.
 *
 * This is exactly what `rehype-mermaid` does with `strategy: 'pre-mermaid'` (and the
 * output is byte-for-byte the same), without its dependencies: rehype-mermaid imports
 * mermaid-isomorphic, which needs Playwright (and pulls in mermaid and KaTeX) just to
 * load, although the pre-mermaid strategy never renders anything at build time.
 *
 * Like rehype-mermaid, a `<code class="language-mermaid">` is only converted when it is
 * the sole non-whitespace child of its `<pre>`.
 */

/** @typedef {{ type: string, tagName?: string, value?: string, properties?: Record<string, unknown>, children?: Node[] }} Node */

/** @param {Node} node */
const isMermaidCode = (node) => {
	if (node.type !== 'element' || node.tagName !== 'code') return false;
	let className = node.properties?.className;
	if (typeof className === 'string') className = className.split(/\s+/);
	return Array.isArray(className) && className.includes('language-mermaid');
};

/** @param {Node} node @returns {string} */
const textOf = (node) =>
	node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('');

/** @param {Node} node */
const visit = (node) => {
	const children = node.children ?? [];
	children.forEach((child, i) => {
		const code = child.type === 'element' && child.tagName === 'pre' ? mermaidCodeIn(child) : undefined;
		if (code) {
			children[i] = {
				type: 'element',
				tagName: 'pre',
				properties: { className: ['mermaid'] },
				children: [{ type: 'text', value: textOf(code) }],
			};
		} else {
			visit(child);
		}
	});
};

/** The `<pre>`'s mermaid `<code>`, if that's all it contains (whitespace aside). @param {Node} pre */
const mermaidCodeIn = (pre) => {
	const children = pre.children ?? [];
	const code = children.find(isMermaidCode);
	if (!code) return undefined;
	const others = children.filter((c) => c !== code);
	return others.every((c) => c.type === 'text' && !/\w/.test(c.value ?? '')) ? code : undefined;
};

export default function rehypePreMermaid() {
	/** @param {Node} tree */
	return (tree) => visit(tree);
}
