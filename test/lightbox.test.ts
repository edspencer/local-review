// The image lightbox's pure parts: which images open it, collecting a block's images, captions, ←/→ wrap, zoom scroll.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { captionOf, collectImages, opensLightbox, sameUrl, stepIndex, zoomScroll, type ImageSource } from '../src/lightboxImages.ts';

const BASE = 'http://localhost:5622/waitlists/orchard-api/abc12345';
const ASSET = '/api/projects/waitlists/assets/0123456789abcdef.png';

describe('which images open the lightbox', () => {
  test('a plain image does', () => {
    assert.equal(opensLightbox(ASSET, null, BASE), true);
    assert.equal(opensLightbox('https://example.com/a.png', null, BASE), true);
  });
  test('an image linked elsewhere keeps its link', () => {
    assert.equal(opensLightbox(ASSET, 'https://example.com/design-doc', BASE), false);
    assert.equal(opensLightbox(ASSET, '', BASE), false);
  });
  test('an image linked to itself does, relative or absolute, fragment aside', () => {
    assert.equal(opensLightbox(ASSET, ASSET, BASE), true);
    assert.equal(opensLightbox(ASSET, `http://localhost:5622${ASSET}#full`, BASE), true);
    assert.equal(sameUrl('a.png', './a.png', BASE), true);
    assert.equal(sameUrl('a.png', 'b.png', BASE), false);
  });
  test('no src, no lightbox; a bad URL never matches', () => {
    assert.equal(opensLightbox('', null, BASE), false);
    assert.equal(sameUrl('http://[', ASSET, BASE), false);
  });
});

describe('collecting a block', () => {
  const img = (el: string, src: string, more: Partial<ImageSource<string>> = {}): ImageSource<string> => ({ el, src, alt: '', title: '', linkHref: null, ...more });
  test('keeps document order, skips linked images, captions each', () => {
    const got = collectImages(
      [
        img('one', '/1.png', { alt: 'Schema' }),
        img('badge', '/badge.svg', { linkHref: 'https://ci.example/build' }),
        img('two', '/2.png', { linkHref: '/2.png', title: 'Full-size diagram', alt: 'diagram' }),
        img('three', '/3.png'),
      ],
      BASE,
    );
    assert.deepEqual(got.map((i) => i.el), ['one', 'two', 'three']);
    assert.deepEqual(got.map((i) => i.caption), ['Schema', 'Full-size diagram', null]);
  });
  test('a block with no images, or none that qualify, is empty', () => {
    assert.deepEqual(collectImages([], BASE), []);
    assert.deepEqual(collectImages([img('x', '/x.png', { linkHref: 'https://elsewhere' })], BASE), []);
  });
});

describe('captions', () => {
  test('title first, then alt, blank is none', () => {
    assert.equal(captionOf({ alt: 'alt', title: 'title' }), 'title');
    assert.equal(captionOf({ alt: ' alt ', title: '  ' }), 'alt');
    assert.equal(captionOf({ alt: '', title: null }), null);
  });
});

describe('stepping', () => {
  test('wraps at both ends', () => {
    assert.equal(stepIndex(0, 4, 1), 1);
    assert.equal(stepIndex(3, 4, 1), 0);
    assert.equal(stepIndex(0, 4, -1), 3);
    assert.equal(stepIndex(2, 4, -7), 3);
  });
  test('one image, or none, stays put', () => {
    assert.equal(stepIndex(0, 1, 1), 0);
    assert.equal(stepIndex(0, 1, -1), 0);
    assert.equal(stepIndex(0, 0, 1), 0);
  });
});

describe('zooming to 100%', () => {
  test('keeps the clicked point under the pointer', () => {
    // clicked 3/4 of the way across a 4000px image, 600px into a 1200px viewport
    assert.equal(zoomScroll(0.75, 4000, 1200, 600), 2400);
  });
  test('clamps to the scrollable range', () => {
    assert.equal(zoomScroll(0.01, 4000, 1200, 600), 0);
    assert.equal(zoomScroll(1, 4000, 1200, 100), 2800);
    // smaller than the viewport on this axis: nothing to scroll
    assert.equal(zoomScroll(0.5, 800, 1200, 600), 0);
  });
});
