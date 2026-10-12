// The left sidebar's width: its limits, and reading back what was saved. Pure, for test/sidebar.test.ts; the drag
// handle itself is SidebarResizer in App.tsx.

export const SIDEBAR_DEFAULT = 300;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 600;
/** ← / → move the edge this far; with Shift, four times as far */
export const SIDEBAR_STEP = 16;
/** where the width is kept: one value for every project and page */
export const SIDEBAR_KEY = 'lr.sidebarWidth';

/** The widest the sidebar may be in a window this wide: half of it, up to SIDEBAR_MAX (never under SIDEBAR_MIN). */
export function sidebarMax(viewport: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(viewport / 2)));
}

/** A width within the limits, in whole pixels; anything that isn't a number is the default. */
export function clampSidebar(width: unknown, viewport: number): number {
  const w = typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : SIDEBAR_DEFAULT;
  return Math.min(sidebarMax(viewport), Math.max(SIDEBAR_MIN, w));
}

/** The saved width (localStorage's JSON string, or null), clamped; the default if there's none or it's garbage. */
export function readSidebarWidth(saved: string | null, viewport: number): number {
  let v: unknown = null;
  try {
    v = saved === null ? null : JSON.parse(saved);
  } catch {
    /* not JSON: the default */
  }
  return clampSidebar(v, viewport);
}

/** The width after a key press on the handle, or null if the key doesn't resize. */
export function keyResize(width: number, key: string, shift: boolean, viewport: number): number | null {
  const step = shift ? SIDEBAR_STEP * 4 : SIDEBAR_STEP;
  if (key === 'ArrowLeft') return clampSidebar(width - step, viewport);
  if (key === 'ArrowRight') return clampSidebar(width + step, viewport);
  if (key === 'Home') return SIDEBAR_MIN;
  if (key === 'End') return sidebarMax(viewport);
  return null;
}
