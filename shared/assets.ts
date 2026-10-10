// Images in PR descriptions, stack notes and the project intro: a project's assets/ folder holds content-addressed
// files, and markdown refers to them as `assets/<name>`. Shared by the UI (rendering, uploads) and the server (the
// asset routes, `local-review asset`, `plan`). No imports: it's bundled by Vite and run by tsx.

/** Hex digits of the sha256 in an asset's name. */
export const ASSET_HASH_LENGTH = 16;
/** The only names an asset can have: `<16 hex>.<ext>`, no separators, nothing else. */
export const ASSET_NAME = /^[0-9a-f]{16}\.(png|jpe?g|gif|webp|svg)$/;
/** The largest asset accepted, in bytes. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

export type AssetType = 'png' | 'jpg' | 'gif' | 'webp' | 'svg';
export const ASSET_MIME: Record<AssetType, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** An asset's type from its name (or a file name's extension): null if it isn't an image type we take. */
export function typeOfName(name: string): AssetType | null {
  const ext = /\.([A-Za-z]+)$/.exec(name)?.[1].toLowerCase();
  if (ext === 'jpeg' || ext === 'jpg') return 'jpg';
  return ext === 'png' || ext === 'gif' || ext === 'webp' || ext === 'svg' ? ext : null;
}

/** An asset's type from a Content-Type (parameters ignored): null if it isn't one we take. */
export function typeOfMime(mime: string): AssetType | null {
  const m = mime.split(';')[0].trim().toLowerCase();
  return (Object.keys(ASSET_MIME) as AssetType[]).find((t) => ASSET_MIME[t] === m) ?? null;
}

/** `assets/<name>` (optionally `./assets/<name>`) as an image source or link target: the asset's name, else null. */
export function assetNameOf(src: string): string | null {
  const m = /^(?:\.\/)?assets\/([^/?#]+)$/.exec(src);
  return m && ASSET_NAME.test(m[1]) ? m[1] : null;
}

/** The URL the server serves an asset at. */
export const assetUrl = (project: string, name: string) => `/api/projects/${encodeURIComponent(project)}/assets/${name}`;

/** The markdown that shows an asset: `![alt](assets/<name>)`, with the alt text made safe for the brackets. */
export function assetMarkdown(name: string, alt = 'image') {
  const a = alt.replace(/[\[\]\\\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'image';
  return `![${a}](assets/${name})`;
}

// An asset reference in markdown text: as a link or image destination `](assets/…`, a reference definition
// `[x]: assets/…`, or an HTML `src=` / `href=` attribute. Prose that merely mentions assets/… isn't one.
const REF = /(\]\(\s*<?|^ {0,3}\[[^\]\n]+\]:[ \t]*<?|\b(?:src|href)\s*=\s*["']?)(?:\.\/)?assets\/([0-9a-f]{16}\.(?:png|jpe?g|gif|webp|svg))(?![\w.-])/gm;

/** The asset names a markdown text refers to, each once, in order of first use. */
export function assetRefs(md: string): string[] {
  return [...new Set([...md.matchAll(REF)].map((m) => m[2]))];
}

/** Replace each asset reference with `url(name)`, or leave it as it is where that returns null. */
export function rewriteAssetRefs(md: string, url: (name: string) => string | null): string {
  return md.replace(REF, (all, lead: string, name: string) => {
    const u = url(name);
    return u === null ? all : lead + u;
  });
}
