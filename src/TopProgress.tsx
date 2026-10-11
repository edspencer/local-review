import { createPortal } from 'react-dom';

/**
 * A thin amber bar along the top of the window while the PR you asked for loads; the page you were on stays as it is
 * underneath. It only appears if the wait is long enough to notice (styles.css).
 */
export function TopProgress() {
  return createPortal(<div className="top-progress" role="progressbar" aria-label="Loading" />, document.body);
}
