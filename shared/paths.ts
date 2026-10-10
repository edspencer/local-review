// Paths as the UI shows them. No imports: it's bundled by Vite and run by tsx.

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` (a path, or a message that mentions some) with the home directory written as `~`, the way people write
 * paths: `/Users/ada/.local-review/projects/x` → `~/.local-review/projects/x`. Only whole path prefixes are
 * replaced (`/home/ada` isn't the start of `/home/adam` or `/srv/home/ada`). Unchanged without a usable home.
 */
export function tildify(text: string, home: string | null | undefined): string {
  const h = home?.replace(/\/+$/, '');
  if (!h || !text.includes(h)) return text;
  return text.replace(new RegExp(`(?<![\\w.~/-])${esc(h)}(?=/|$|[\\s'"\`:,;)\\]])`, 'g'), '~');
}
