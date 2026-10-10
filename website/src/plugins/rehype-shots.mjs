// Screenshots in Markdown (the PNGs in src/assets/shots/, from the capture rig: see tools/docs-media/README.md).
//
// 1. Sizing. The rig captures at 2x (more for a zoomed crop), and Astro sizes a Markdown image by its pixels, so a
//    capture would show at twice its size and soft. This sets each one's width and height to half its pixels and asks
//    for 1x and 2x variants (`densities`): crisp on a retina screen, and no bigger than it was on the page it came from
//    (a zoomed crop shows magnified, which is what the zoom is for). A full window is capped at the column's width.
// 2. Captions. A screenshot with a title, on a line of its own, becomes a figure:
//
//      ![What it shows, for screen readers](../../assets/shots/stack-tab.png "The caption under it")
//
//    → <figure class="shot"><img alt="What it shows…" …><figcaption>The caption under it</figcaption></figure>
//
// It runs before Astro's own image step (user rehype plugins do), which still finds the <img> and optimises it (webp),
// keeping the width, height and densities set here.
import fs from 'node:fs';
import path from 'node:path';

const SHOT = /(^|\/)assets\/shots\/[\w-]+\.png$/;
const MAX_WIDTH = 800;

/** A PNG's pixel size, from its IHDR chunk. */
function pngSize(/** @type {string} */ file) {
	const b = Buffer.alloc(24);
	const fd = fs.openSync(file, 'r');
	try {
		fs.readSync(fd, b, 0, 24, 0);
	} finally {
		fs.closeSync(fd);
	}
	return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** @param {any} node */
const isWhitespace = (node) => node.type === 'text' && !node.value.trim();

export default function rehypeShots() {
	/** @param {any} tree @param {any} file */
	return (tree, file) => {
		/** @param {any} img */
		const size = (img) => {
			const src = img.properties?.src;
			if (typeof src !== 'string' || !SHOT.test(src) || !file.path) return;
			const abs = path.resolve(path.dirname(file.path), decodeURI(src));
			if (!fs.existsSync(abs)) throw new Error(`${file.path}: no screenshot at ${src} (npm run docs:media:sync)`);
			const px = pngSize(abs);
			// no wider than the content column (--sl-content-width), so a full window isn't shipped at 2880px
			const width = Math.min(Math.round(px.width / 2), MAX_WIDTH);
			img.properties.width = width;
			img.properties.height = Math.round((px.height * width) / px.width);
			img.properties.densities = [1, 2];
		};
		/** @param {any} parent */
		const walk = (parent) => {
			if (!parent.children) return;
			parent.children = parent.children.map((/** @type {any} */ node) => {
				if (node.type !== 'element') return node;
				if (node.tagName === 'img') {
					size(node);
					return node;
				}
				if (node.tagName === 'p') {
					const kids = node.children.filter((/** @type {any} */ c) => !isWhitespace(c));
					const img = kids.length === 1 && kids[0].type === 'element' && kids[0].tagName === 'img' ? kids[0] : null;
					const title = img?.properties?.title;
					if (img && typeof title === 'string' && title.trim()) {
						size(img);
						delete img.properties.title;
						return {
							type: 'element',
							tagName: 'figure',
							properties: { className: ['shot'] },
							children: [img, { type: 'element', tagName: 'figcaption', properties: {}, children: [{ type: 'text', value: title }] }],
						};
					}
				}
				walk(node);
				return node;
			});
		};
		walk(tree);
	};
}
