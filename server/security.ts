import type { MiddlewareHandler } from 'hono';

// DNS rebinding / CSRF: the server only listens on 127.0.0.1, but a web page could still reach it via a
// DNS name that resolves to 127.0.0.1 (rebinding) or by POSTing a "simple" cross-site request. So:
// - every request must carry a localhost Host header;
// - writes must be JSON (forces a CORS preflight, which we never grant) and, if the browser sends an Origin,
//   it must be localhost too. The one exception is an image upload (POST …/assets), whose body is the image
//   itself: image/png, image/jpeg, image/gif, image/webp or image/svg+xml. None of those is a CORS-safelisted
//   type either, so a cross-site page still can't send one without the preflight we never grant.
export function isLocalHost(host: string | undefined | null): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}
export function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.host);
  } catch {
    return false;
  }
}
const UPLOAD_PATH = /^\/api\/projects\/[^/]+\/assets$/;
const IMAGE_TYPE = /^image\/(?:png|jpeg|gif|webp|svg\+xml)\s*(?:;|$)/i;
export const localOnly: MiddlewareHandler = async (c, next) => {
  if (!isLocalHost(c.req.header('host'))) return c.json({ error: 'forbidden host' }, 403);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin && !isLocalOrigin(origin)) return c.json({ error: 'forbidden origin' }, 403);
    const ct = c.req.header('content-type') ?? '';
    const upload = c.req.method === 'POST' && UPLOAD_PATH.test(c.req.path);
    if (upload ? !IMAGE_TYPE.test(ct) : c.req.method !== 'DELETE' && !/^application\/json\b/i.test(ct))
      return c.json({ error: upload ? 'expected an image Content-Type: image/png, image/jpeg, image/gif, image/webp or image/svg+xml' : 'expected Content-Type: application/json' }, 415);
  }
  await next();
};
