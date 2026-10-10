// The image lightbox's pure parts (Lightbox.tsx is the overlay): which markdown images open it, the images one
// rendered block steps through, the caption, wrapping ←/→ and where to scroll so a zoom keeps the clicked point put.

/** Set by the sanitiser on every `<img>` that opens the lightbox; Lightbox.tsx looks for it. */
export const LIGHTBOX_ATTR = 'data-lightbox';

/** Two URLs, resolved against `base`, are the same resource (the fragment aside). */
export function sameUrl(a: string, b: string, base: string): boolean {
  try {
    const u = new URL(a, base), v = new URL(b, base);
    u.hash = v.hash = '';
    return u.href === v.href;
  } catch {
    return false;
  }
}

/**
 * A plain image opens the lightbox. One wrapped in a link keeps the link: unless the link points at the image itself
 * (`[![alt](x.png)](x.png)`, as GitHub writes them), when a plain click opens the lightbox and a modifier-click still
 * follows the link.
 */
export function opensLightbox(src: string, linkHref: string | null, base: string): boolean {
  if (!src) return false;
  return linkHref === null || sameUrl(linkHref, src, base);
}

/** The caption: the title if there is one, else the alt text; null when both are blank. */
export function captionOf(img: { alt?: string | null; title?: string | null }): string | null {
  return img.title?.trim() || img.alt?.trim() || null;
}

/** What the lightbox needs of an `<img>`: its resolved `src`, alt and title, and the link around it (if any). */
export type ImageSource<T> = { el: T; src: string; alt: string; title: string; linkHref: string | null };
export type LightboxImage<T> = { el: T; src: string; alt: string; caption: string | null };

/** The images of one rendered block that the lightbox steps through, in document order. */
export function collectImages<T>(imgs: Iterable<ImageSource<T>>, base: string): LightboxImage<T>[] {
  const out: LightboxImage<T>[] = [];
  for (const i of imgs) if (opensLightbox(i.src, i.linkHref, base)) out.push({ el: i.el, src: i.src, alt: i.alt, caption: captionOf(i) });
  return out;
}

/** The index `delta` steps from `i` among `n` images, wrapping at both ends. */
export function stepIndex(i: number, n: number, delta: number): number {
  if (n <= 0) return 0;
  return (((i + delta) % n) + n) % n;
}

/**
 * Where to scroll, on one axis, after zooming to natural size so the point that was clicked stays under the pointer.
 * `frac` is where the click landed across the fitted image (0–1), `natural` the image's natural size, `viewport` the
 * scroller's size and `pointer` the click's offset into the scroller.
 */
export function zoomScroll(frac: number, natural: number, viewport: number, pointer: number): number {
  const max = Math.max(0, natural - viewport);
  return Math.round(Math.min(max, Math.max(0, frac * natural - pointer)));
}
