// A project's images: projects/<slug>/assets/<sha256 prefix>.<ext>, added by `local-review asset add` or an upload
// in the UI, and referred to from markdown as `assets/<name>` (shared/assets.ts). Files are named by their content,
// so adding the same bytes twice is a no-op, and an asset file is never replaced or removed: it's written once,
// create-only, through safefs. Beside one may sit `<name>.yaml` with a `url:` where the image is published, which
// `plan` uses in place of the local reference (GitHub can't show a file on this machine).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ASSET_HASH_LENGTH, ASSET_NAME, MAX_ASSET_BYTES, assetMarkdown, assetRefs, rewriteAssetRefs, type AssetType } from '../shared/assets.js';
import { ExistsError, atomicWrite } from './safefs.js';

export class AssetError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const assetsDir = (projectDir: string) => path.join(projectDir, 'assets');

const startsWith = (b: Uint8Array, bytes: number[], at = 0) => b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Whether `b` is an SVG document: UTF-8 text whose root element (after any prolog) is `<svg`. */
function isSvg(b: Uint8Array): boolean {
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return false;
  }
  if (s.includes('\0')) return false;
  s = s.replace(/^﻿/, '');
  // the prolog: an XML declaration, comments, processing instructions and a DOCTYPE without an internal subset
  // (entity declarations have no business in an image)
  const prolog = /^\s*(?:<\?xml\b[^>]*\?>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE\s+svg\b[^[>]*>)/i;
  for (let m = prolog.exec(s); m; m = prolog.exec(s)) s = s.slice(m[0].length);
  return /^\s*<svg[\s>/]/.test(s) && /<\/svg\s*>\s*(?:<!--[\s\S]*?-->\s*)*$|^\s*<svg\b[^>]*\/>\s*$/.test(s);
}

/** The image type `bytes` actually are, by their magic numbers (SVG: by parsing the start), or null. */
export function sniff(bytes: Uint8Array): AssetType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  return isSvg(bytes) ? 'svg' : null;
}

export interface AddedAsset {
  name: string;
  file: string;
  markdown: string;
  created: boolean; // false: the same image was already there
}

/**
 * Add an image to the project's assets folder, named by its content. `claimed` is the type the caller says it is
 * (from a Content-Type or a file extension); the bytes must really be that type. Re-adding the same bytes is a
 * no-op. Never replaces a file.
 */
export function addAsset(projectDir: string, bytes: Uint8Array, claimed: AssetType | null, alt?: string): AddedAsset {
  if (!claimed) throw new AssetError(415, 'not an image type Local Review takes: PNG, JPEG, GIF, WebP or SVG');
  if (bytes.length === 0) throw new AssetError(400, 'the image is empty');
  if (bytes.length > MAX_ASSET_BYTES) throw new AssetError(413, `the image is ${mb(bytes.length)}; the limit is ${mb(MAX_ASSET_BYTES)}`);
  const actual = sniff(bytes);
  if (!actual) throw new AssetError(415, `the file isn't a ${claimed.toUpperCase()} image (its contents don't match any image type Local Review takes)`);
  if (actual !== claimed) throw new AssetError(415, `the file says it's ${claimed.toUpperCase()} but its contents are ${actual.toUpperCase()}`);
  const name = `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, ASSET_HASH_LENGTH)}.${actual}`;
  const file = path.join(assetsDir(projectDir), name);
  let created = true;
  try {
    atomicWrite(file, bytes, { createOnly: true });
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    // the same name: the same image, unless the file was changed by hand (then it's left alone, and we say so)
    if (!Buffer.from(bytes).equals(fs.readFileSync(file))) throw new AssetError(409, `${file} already exists with different contents; not replacing it`);
    created = false;
  }
  return { name, file, markdown: assetMarkdown(name, alt), created };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;

/** An asset's file, if `name` is a valid asset name and it's a regular file (not a symlink) in the folder. */
export function assetFile(projectDir: string, name: string): string | null {
  if (!ASSET_NAME.test(name)) return null;
  const file = path.join(assetsDir(projectDir), name);
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? file : null;
  } catch {
    return null;
  }
}

/** `<name>.yaml` beside an asset: where it's published. Only `url:` is read; anything else in it is kept. */
export const assetRecordPath = (projectDir: string, name: string) => path.join(assetsDir(projectDir), `${name}.yaml`);

/** The published URL recorded for an asset, or null (no record, no url:, or a record that doesn't parse). */
export function publishedUrl(projectDir: string, name: string): string | null {
  let doc: unknown;
  try {
    doc = YAML.parse(fs.readFileSync(assetRecordPath(projectDir, name), 'utf8'));
  } catch {
    return null;
  }
  const url = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).url : null;
  return typeof url === 'string' && isHttpUrl(url) ? url : null;
}

export const isHttpUrl = (u: string) => /^https?:\/\/[^\s]+$/.test(u) && u.length <= 2000;

/**
 * Record (or change) where an asset is published, in `<name>.yaml`, keeping anything else a person or agent wrote
 * there. The asset must exist. A record that doesn't parse is never overwritten.
 */
export function setPublishedUrl(projectDir: string, name: string, url: string) {
  if (!ASSET_NAME.test(name)) throw new AssetError(400, `bad asset name '${name}' (expected <16 hex digits>.<png|jpg|gif|webp|svg>)`);
  if (!assetFile(projectDir, name)) throw new AssetError(404, `no asset ${name} in ${assetsDir(projectDir)}`);
  if (!isHttpUrl(url)) throw new AssetError(400, `not an http(s) URL: ${url}`);
  const file = assetRecordPath(projectDir, name);
  let doc = new YAML.Document({});
  if (fs.existsSync(file)) {
    doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    if (doc.errors.length || (doc.contents !== null && !YAML.isMap(doc.contents))) throw new AssetError(409, `${file} doesn't parse as a YAML mapping; not overwriting it`);
    if (doc.contents === null) doc = new YAML.Document({});
  }
  doc.set('url', url);
  atomicWrite(file, doc.toString({ lineWidth: 0 }));
  return file;
}

export interface AssetUse {
  name: string;
  file: string | null; // where it is on this machine (null: referenced, but not in the assets folder)
  url: string | null; // where it's published (from <name>.yaml), if recorded
}

/**
 * For `plan`: the assets a body refers to, and the body with each reference that has a published URL rewritten
 * to it. References without one are left as `assets/<name>` (the plan warns about them).
 */
export function resolveAssetRefs(projectDir: string, body: string): { body: string; assets: AssetUse[] } {
  const assets = assetRefs(body).map((name) => ({ name, file: assetFile(projectDir, name), url: publishedUrl(projectDir, name) }));
  const urls = new Map(assets.map((a) => [a.name, a.url]));
  return { body: rewriteAssetRefs(body, (n) => urls.get(n) ?? null), assets };
}
