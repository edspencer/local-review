import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { LIGHTBOX_ATTR, collectImages, stepIndex, zoomScroll, type ImageSource, type LightboxImage } from './lightboxImages';

const SELECTOR = `.markdown-body img[${LIGHTBOX_ATTR}]`;
type Image = LightboxImage<HTMLImageElement>;

const sourceOf = (img: HTMLImageElement): ImageSource<HTMLImageElement> => {
  const link = img.closest('a');
  return { el: img, src: img.currentSrc || img.src, alt: img.alt, title: img.title, linkHref: link ? link.href : null };
};
/** Where focus goes back to: the image, or the link around it. */
const opener = (img: HTMLImageElement): HTMLElement => img.closest('a') ?? img;

/**
 * Click an image rendered from markdown (descriptions, stack notes, the intro, comments, editor previews) to see it in
 * an overlay; ←/→ step through the other images of the same block. One listener on the document, so every
 * <Markdown> gets it. Mounted once, beside <App>.
 */
export function ImageLightbox() {
  const [view, setView] = useState<{ images: Image[]; index: number } | null>(null);

  useEffect(() => {
    const open = (img: HTMLImageElement) => {
      const block = img.closest('.markdown-body');
      if (!block) return false;
      const images = collectImages(Array.from(block.querySelectorAll('img'), sourceOf), document.baseURI);
      const index = images.findIndex((i) => i.el === img);
      if (index < 0) return false;
      setView({ images, index });
      return true;
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const img = (e.target as Element | null)?.closest?.(SELECTOR);
      if (!(img instanceof HTMLImageElement)) return;
      // an image linked to itself: a modifier-click still opens the link (new tab, download, …)
      if (img.closest('a') && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
      if (open(img)) e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'Enter' && e.key !== ' ') || !(e.target instanceof HTMLImageElement) || !e.target.matches(SELECTOR)) return;
      if (open(e.target)) e.preventDefault();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); };
  }, []);

  if (!view) return null;
  return createPortal(
    <LightboxDialog
      images={view.images}
      start={view.index}
      onClose={(i) => {
        setView(null);
        const el = view.images[i]?.el;
        if (el?.isConnected) opener(el).focus();
      }}
    />,
    document.body,
  );
}

function LightboxDialog({ images, start, onClose }: { images: Image[]; start: number; onClose: (index: number) => void }) {
  const [index, setIndex] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const [zoomable, setZoomable] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // where to scroll once the zoomed image has laid out: the clicked point, as a fraction of the image and an offset
  const zoomAt = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const image = images[index];
  const many = images.length > 1;

  const step = (delta: number) => { setIndex((i) => stepIndex(i, images.length, delta)); setZoomed(false); setZoomable(false); };
  const close = () => onClose(index);
  const indexRef = useRef(index);
  indexRef.current = index;

  // fit-to-screen shows it smaller than it is: only then is there a 100% to zoom to
  const measure = () => {
    const img = imgRef.current;
    if (img && !zoomed && img.complete) setZoomable(img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1);
  };
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  const toggleZoom = (at?: { clientX: number; clientY: number }) => {
    const img = imgRef.current, stage = stageRef.current;
    if (!img || !stage || (!zoomed && !zoomable)) return;
    if (!zoomed) {
      const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
      const x = at?.clientX ?? r.left + r.width / 2, y = at?.clientY ?? r.top + r.height / 2;
      zoomAt.current = { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, px: x - s.left, py: y - s.top };
    }
    setZoomed(!zoomed);
  };
  useLayoutEffect(() => {
    const img = imgRef.current, stage = stageRef.current, at = zoomAt.current;
    if (!zoomed || !img || !stage || !at) return;
    zoomAt.current = null;
    stage.scrollLeft = zoomScroll(at.fx, img.naturalWidth, stage.clientWidth, at.px);
    stage.scrollTop = zoomScroll(at.fy, img.naturalHeight, stage.clientHeight, at.py);
  }, [zoomed]);

  // Keys: nothing behind the lightbox sees one while it's open (no j/k/n/p, and an editor's Esc doesn't cancel it).
  // Capturing on window runs before every other listener, React's included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); onClose(indexRef.current); }
      else if (many && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); }
      else if (e.key === 'Tab') {
        // focus trap: cycle through the dialog's buttons
        e.preventDefault();
        const els = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []);
        if (!els.length) return;
        const i = els.indexOf(document.activeElement as HTMLElement);
        els[i < 0 ? 0 : stepIndex(i, els.length, e.shiftKey ? -1 : 1)].focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  useEffect(() => {
    closeRef.current?.focus();
    const root = document.documentElement, overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => { root.style.overflow = overflow; };
  }, []);

  // drag to pan the zoomed image (mouse; touch scrolls natively). A drag isn't a click: it neither unzooms nor closes.
  const onPointerDown = (e: ReactPointerEvent) => {
    const stage = stageRef.current;
    if (!zoomed || !stage || e.pointerType !== 'mouse' || e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false };
    const move = (m: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (Math.abs(m.clientX - d.x) + Math.abs(m.clientY - d.y) > 4) d.moved = true;
      stage.scrollLeft = d.left - (m.clientX - d.x);
      stage.scrollTop = d.top - (m.clientY - d.y);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onStageClick = (e: ReactMouseEvent) => {
    const dragged = drag.current?.moved;
    drag.current = null;
    if (dragged) return;
    if (e.target === imgRef.current) toggleZoom(e);
    else if (e.target === stageRef.current) close();
  };

  const zoomLabel = zoomed ? 'Fit to screen' : zoomable ? 'Zoom to 100%' : 'Shown at full size';
  return (
    <div className={`lightbox ${image.caption ? 'has-caption' : ''}`} role="dialog" aria-modal="true" aria-label={image.caption ? `Image: ${image.caption}` : 'Image'} ref={dialogRef}>
      <div className={`lightbox-stage ${zoomed ? 'is-zoomed' : ''}`} ref={stageRef} onPointerDown={onPointerDown} onClick={onStageClick}>
        <img
          key={image.src}
          ref={imgRef}
          className={zoomed ? 'zoom-out' : zoomable ? 'zoom-in' : ''}
          src={image.src}
          alt={image.alt}
          draggable={false}
          onLoad={measure}
        />
      </div>
      <div className="lightbox-bar">
        {many && <span className="lightbox-count" aria-live="polite">{index + 1} / {images.length}</span>}
        <button type="button" className="lightbox-btn" onClick={() => toggleZoom()} disabled={!zoomed && !zoomable} aria-label={zoomLabel} title={zoomLabel}>
          {zoomed ? <ZoomIcon minus /> : <ZoomIcon />}
        </button>
        <button type="button" className="lightbox-btn" ref={closeRef} onClick={close} aria-label="Close" title="Close (Esc)">×</button>
      </div>
      {many && (
        <>
          <button type="button" className="lightbox-btn lightbox-prev" onClick={() => step(-1)} aria-label="Previous image" title="Previous (←)">‹</button>
          <button type="button" className="lightbox-btn lightbox-next" onClick={() => step(1)} aria-label="Next image" title="Next (→)">›</button>
        </>
      )}
      {image.caption && <div className="lightbox-caption">{image.caption}</div>}
    </div>
  );
}

function ZoomIcon({ minus }: { minus?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="6.75" cy="6.75" r="4.75" />
      <path d={minus ? 'M4.5 6.75h4.5M10.25 10.25 14 14' : 'M4.5 6.75h4.5M6.75 4.5v4.5M10.25 10.25 14 14'} />
    </svg>
  );
}
