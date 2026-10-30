// Settings for this machine rather than any one project: <home>/config.yaml (optional; every setting has a default).
// For now only the GitHub sync (server/github.ts):
//
//   github:
//     sync: on       # off by default: it's the one thing that talks to the network
//     source: gh     # how to reach GitHub: the gh CLI, logged in (`gh auth login`)
//     max_age: 5m    # how old what's shown may get while a Local Review page is open (30s at least)
//     me: <login>    # whose last word makes a thread "answered" (default: whoever gh is logged in as)
//
// A project can leave its PRs out with `github: {sync: off}` in its project.yaml (server/projects.ts).
import fs from 'node:fs';
import YAML from 'yaml';
import { CONFIG_FILE } from './config.js';
import { onOff } from './projects.js';

export const SOURCES = ['gh'] as const;
export type SourceName = (typeof SOURCES)[number];

export interface GithubSettings {
  sync: boolean;
  source: SourceName;
  maxAgeMs: number;
  me: string | null;
}

export interface Settings {
  file: string;
  github: GithubSettings;
  warnings: string[];
}

export const DEFAULT_MAX_AGE_MS = 5 * 60_000;
export const MIN_MAX_AGE_MS = 30_000;

/** `30s`, `5m`, `1h` (or a bare number of seconds) in ms; null if it's none of those. */
export function duration(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v * 1000);
  const m = typeof v === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*(s|m|h)?\s*$/i.exec(v) : null;
  if (!m) return null;
  const unit = { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's').toLowerCase() as 's' | 'm' | 'h'];
  return Math.round(Number(m[1]) * unit);
}

/** Parse config.yaml's text. Never throws: problems are warnings, and the setting keeps its default. */
export function parseSettings(raw: string | null, file = CONFIG_FILE): Settings {
  const github: GithubSettings = { sync: false, source: 'gh', maxAgeMs: DEFAULT_MAX_AGE_MS, me: null };
  const out: Settings = { file, github, warnings: [] };
  if (raw === null) return out;
  let doc: any;
  try {
    doc = YAML.parse(raw) ?? {};
  } catch (e) {
    out.warnings.push(`invalid YAML in ${file}: ${(e as Error).message}`);
    return out;
  }
  const g = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.github : undefined;
  if (g === undefined || g === null) return out;
  if (typeof g !== 'object' || Array.isArray(g)) {
    out.warnings.push(`${file}: \`github\` must be a mapping (sync:, source:, max_age:)`);
    return out;
  }
  if (g.sync !== undefined) {
    const s = onOff(g.sync);
    if (s === undefined) out.warnings.push(`${file}: github.sync must be on or off, not ${JSON.stringify(g.sync)}`);
    else github.sync = s;
  }
  if (g.source !== undefined) {
    if ((SOURCES as readonly string[]).includes(g.source)) github.source = g.source;
    else out.warnings.push(`${file}: github.source must be ${SOURCES.join(' or ')}, not ${JSON.stringify(g.source)}`);
  }
  if (g.max_age !== undefined) {
    const ms = duration(g.max_age);
    if (ms === null) out.warnings.push(`${file}: github.max_age must be a duration like 5m, 90s or 1h, not ${JSON.stringify(g.max_age)}`);
    else github.maxAgeMs = Math.max(MIN_MAX_AGE_MS, ms);
  }
  if (g.me !== undefined && g.me !== null) {
    if (typeof g.me === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(g.me.trim())) github.me = g.me.trim();
    else out.warnings.push(`${file}: github.me must be a GitHub login, not ${JSON.stringify(g.me)}`);
  }
  return out;
}

let cached: { stamp: string; s: Settings } | null = null;

/** The current settings, re-read whenever config.yaml changes (or appears, or goes). */
export function loadSettings(): Settings {
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(CONFIG_FILE);
  } catch {
    /* no file: the defaults */
  }
  const stamp = st ? `${st.mtimeMs}:${st.size}` : '-';
  if (cached?.stamp === stamp) return cached.s;
  let raw: string | null = null;
  try {
    raw = st ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
  } catch {
    /* unreadable: the defaults */
  }
  const s = parseSettings(raw);
  cached = { stamp, s };
  return s;
}
