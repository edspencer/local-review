// Projects: projects/<slug>/project.yaml lists repos (each a commit range), and splits each repo's commits
// into consecutive, colour-coded PR stacks. Everything here is re-read on every request, so edits (by the reviewer or
// an agent) show up without a restart.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { PROJECTS_DIR, SAFE_NAME, expandHome, safeName } from './config.js';
import { loadRepo, rangeEnd, type RepoInfo, type RepoRange } from './commits.js';
import { normalizeSubject } from './reviews.js';

// the colours a regular stack can have (auto-assigned in this order, cycling). Yellow isn't one of them: it's
// reserved for follow-on stacks, which are always yellow whatever their `color:` says.
export const PALETTE = ['blue', 'green', 'purple', 'orange', 'pink', 'teal', 'red'] as const;
export const FOLLOW_ON_COLOR = 'yellow';
export const UNSTACKED_COLOR = 'gray';

export interface StackSpec {
  title: string;
  color: string; // a PALETTE name or #hex
  starts_at?: string; // commit selector: sha prefix (>= 7 hex) or commit subject
  description?: string; // optional markdown note: inter-stack context, shown on the homepage and PR pages
  follow_on?: boolean; // parked work: held back from the stacks going up now (advisory; `lr plan` skips it)
}

export interface RepoConfig extends RepoRange {
  index: number; // position in project.yaml's `repos` list (for writing back to the file)
  stacks: StackSpec[]; // empty: one implicit stack named after the branch
  warnings: string[]; // config problems (bad colour, …)
}

export interface ProjectConfig {
  slug: string;
  dir: string;
  file: string;
  title: string;
  description: string | null;
  repos: RepoConfig[];
  error?: string;
}

export interface StackGroup {
  index: number; // position in the repo's `stacks` array
  number: number | null; // 1-based position among the declared stacks; null for an implicit group
  title: string;
  color: string;
  implicit?: 'unstacked' | 'branch';
  shas: string[];
  warning?: string;
  description?: string; // the declared stack's note (markdown), if any
  follow_on?: boolean; // the declared stack is a follow-on (held back); absent otherwise
}

const isHexColor = (s: string) => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(s);

/** A project slug from the URL or the file system: must be a plain directory name. */
export function projectDir(slug: string): string {
  if (!SAFE_NAME.test(slug)) throw new Error(`bad project name: ${slug}`);
  return path.join(PROJECTS_DIR, slug);
}

export function listProjectSlugs(): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && SAFE_NAME.test(e.name) && fs.existsSync(path.join(PROJECTS_DIR, e.name, 'project.yaml')))
    .map((e) => e.name)
    .sort();
}

/** A YAML flag: true/false, or "yes"/"no" (and "true"/"false") as strings, any case. Anything else: undefined. */
export function flag(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase();
  return t === 'yes' || t === 'true' ? true : t === 'no' || t === 'false' ? false : undefined;
}

const text = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : typeof v === 'object' ? undefined : String(v));

/** Parse a project.yaml. Never throws: problems are reported as `error` (whole file) or repo `warnings`. */
export function parseProject(slug: string, dir: string, raw: string): ProjectConfig {
  const file = path.join(dir, 'project.yaml');
  const out: ProjectConfig = { slug, dir, file, title: slug, description: null, repos: [] };
  let doc: any;
  try {
    doc = YAML.parse(raw) ?? {};
  } catch (e) {
    out.error = `invalid YAML in ${file}: ${(e as Error).message}`;
    return out;
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    out.error = `${file}: the top level must be a mapping (title:, repos: …)`;
    return out;
  }
  out.title = text(doc.title)?.trim() || slug;
  out.description = text(doc.description) ?? null;
  const list: any[] = Array.isArray(doc.repos) ? doc.repos : [];
  if (doc.repos != null && !Array.isArray(doc.repos)) out.error = `${file}: \`repos\` must be a list`;
  const used = new Set<string>();
  for (const [index, r] of list.entries()) {
    if (!r || typeof r !== 'object' || typeof r.path !== 'string') continue;
    const repoPath = path.resolve(expandHome(r.path));
    const wanted = safeName(text(r.name) ?? path.basename(repoPath), 'repo');
    let name = wanted;
    for (let n = 2; used.has(name); n++) name = `${wanted}-${n}`;
    used.add(name);
    const warnings: string[] = [];
    // the suffix depends on the order of `repos`, and the name is the reviews/ and prs/ directory: reordering
    // or removing a repo would silently switch which comments a repo shows
    if (name !== wanted)
      warnings.push(`another repo is already named "${wanted}", so this one is "${name}" (its reviews/ and prs/ directories use that name; reordering the repos would change it). Give it a unique \`name\`.`);
    const stacks: StackSpec[] = [];
    if (r.stacks != null && !Array.isArray(r.stacks)) warnings.push('`stacks` must be a list; ignored');
    for (const [i, s] of (Array.isArray(r.stacks) ? r.stacks : []).entries()) {
      const spec: any = s && typeof s === 'object' ? s : { title: text(s) };
      const title = text(spec.title)?.trim() || `Stack ${i + 1}`;
      let followOn = false;
      if (spec.follow_on != null) {
        const f = flag(spec.follow_on);
        if (f === undefined) warnings.push(`stack "${title}": follow_on must be true or false (or yes / no), not ${JSON.stringify(spec.follow_on)}; ignored`);
        else followOn = f;
      }
      // a follow-on stack is always yellow (its `color:` is ignored); a regular one never is
      let color: string = followOn ? FOLLOW_ON_COLOR : PALETTE[i % PALETTE.length];
      const c = text(spec.color)?.trim();
      if (c && !followOn) {
        if ((PALETTE as readonly string[]).includes(c.toLowerCase())) color = c.toLowerCase();
        else if (c.toLowerCase() === FOLLOW_ON_COLOR) warnings.push(`stack "${title}": yellow is reserved for follow-on stacks; using ${color} (pick another colour, or mark it follow_on: true)`);
        else if (isHexColor(c)) color = c;
        else warnings.push(`stack "${title}": unknown colour '${c}' (use ${PALETTE.join(', ')} or #hex)`);
      }
      const startsAt = text(spec.starts_at)?.trim();
      const description = text(spec.description)?.replace(/\r\n/g, '\n').trim();
      stacks.push({ title, color, ...(startsAt ? { starts_at: startsAt } : {}), ...(description ? { description } : {}), ...(followOn ? { follow_on: true } : {}) });
    }
    out.repos.push({
      index,
      name,
      path: repoPath,
      branch: text(r.branch),
      to: text(r.to),
      base: text(r.base),
      from: text(r.from),
      stacks,
      warnings,
    });
  }
  return out;
}

export function loadProjectConfig(slug: string): ProjectConfig | null {
  const dir = projectDir(slug);
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, 'project.yaml'), 'utf8');
  } catch {
    return null;
  }
  return parseProject(slug, dir, raw);
}

/**
 * Split a repo's commits (oldest first) into consecutive stacks. Each declared stack starts at the commit its
 * `starts_at` selects and runs up to the next stack's start. Commits before the first start form an implicit
 * "Unstacked" group. A selector that matches nothing, or only commits at or before the previous stack's start
 * (out of order), gives a warning and an empty stack; it never throws.
 */
export function partitionStacks(commits: { sha: string; subject: string }[], specs: StackSpec[], defaultTitle = 'Stack'): { stacks: StackGroup[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!specs.length) {
    return { stacks: [{ index: 0, number: null, title: defaultTitle, color: PALETTE[0], implicit: 'branch', shas: commits.map((c) => c.sha) }], warnings };
  }
  // nothing to place (e.g. the branch has no commits yet): empty stacks, no warnings
  const declared = (s: StackSpec, i: number, index: number, shas: string[]): StackGroup => ({ index, number: i + 1, title: s.title, color: s.follow_on ? FOLLOW_ON_COLOR : s.color, shas, ...(s.description ? { description: s.description } : {}), ...(s.follow_on ? { follow_on: true } : {}) });
  if (!commits.length) return { stacks: specs.map((s, i) => declared(s, i, i, [])), warnings };
  const subjects = commits.map((c) => normalizeSubject(c.subject));
  const starts: (number | null)[] = [];
  const specWarnings: (string | undefined)[] = [];
  let last = -1;
  for (const [i, spec] of specs.entries()) {
    const label = `stack ${i + 1} "${spec.title}"`;
    let cands: number[];
    const sel = spec.starts_at;
    if (sel === undefined) {
      if (i === 0) cands = [0];
      else {
        specWarnings.push(`${label} has no starts_at, so it is empty`);
        starts.push(null);
        continue;
      }
    } else {
      cands = [];
      if (/^[0-9a-f]{7,40}$/i.test(sel)) cands = commits.flatMap((c, j) => (c.sha.startsWith(sel.toLowerCase()) ? [j] : []));
      if (!cands.length) {
        const n = normalizeSubject(sel);
        cands = subjects.flatMap((s, j) => (s === n ? [j] : []));
      }
    }
    if (!cands.length) {
      specWarnings.push(`${label}: starts_at "${sel}" doesn't match any commit (sha prefix or subject), so it is empty`);
      starts.push(null);
      continue;
    }
    const pick = cands.find((j) => j > last);
    if (pick === undefined) {
      specWarnings.push(`${label}: starts_at "${sel}" is at or before the previous stack's start (out of order), so it is empty`);
      starts.push(null);
      continue;
    }
    starts.push(pick);
    specWarnings.push(undefined);
    last = pick;
  }
  // follow-on stacks are parked at the end: a regular stack after one would be stacked on held-back work
  const firstFollowOn = specs.findIndex((s) => s.follow_on);
  if (firstFollowOn >= 0)
    for (const [i, spec] of specs.entries()) {
      if (i <= firstFollowOn || spec.follow_on) continue;
      const w = `stack ${i + 1} "${spec.title}" comes after follow-on stack ${firstFollowOn + 1} "${specs[firstFollowOn].title}" but isn't a follow-on itself: its PRs would be stacked on held-back work (move follow-on stacks to the end, or mark this one follow_on: true)`;
      specWarnings[i] = specWarnings[i] ? `${specWarnings[i]}\n${w}` : w;
    }
  const valid = starts.map((s, i) => ({ s, i })).filter((x): x is { s: number; i: number } => x.s !== null);
  const groups: StackGroup[] = [];
  const firstStart = valid.length ? valid[0].s : commits.length;
  if (firstStart > 0) {
    groups.push({ index: 0, number: null, title: 'Unstacked', color: UNSTACKED_COLOR, implicit: 'unstacked', shas: commits.slice(0, firstStart).map((c) => c.sha) });
  }
  for (const [i, spec] of specs.entries()) {
    const s = starts[i];
    let shas: string[] = [];
    if (s !== null) {
      const k = valid.findIndex((v) => v.i === i);
      const end = valid[k + 1]?.s ?? commits.length;
      shas = commits.slice(s, end).map((c) => c.sha);
    }
    const g = declared(spec, i, groups.length, shas);
    if (specWarnings[i]) {
      g.warning = specWarnings[i];
      warnings.push(...specWarnings[i]!.split('\n'));
    }
    groups.push(g);
  }
  return { stacks: groups, warnings };
}

export interface LoadedRepo {
  cfg: RepoConfig;
  info: RepoInfo;
  stacks: StackGroup[];
  warnings: string[];
  stackOf: Map<string, number>; // sha -> index into stacks
  reviewsDir: string;
  prsDir: string;
}

export interface LoadedProject {
  cfg: ProjectConfig;
  repos: LoadedRepo[];
}

export function repoDirs(project: ProjectConfig, repo: string) {
  if (!SAFE_NAME.test(repo)) throw new Error(`bad repo name: ${repo}`);
  return { reviewsDir: path.join(project.dir, 'reviews', repo), prsDir: path.join(project.dir, 'prs', repo) };
}

export async function loadProject(slug: string): Promise<LoadedProject | null> {
  const cfg = loadProjectConfig(slug);
  if (!cfg) return null;
  const repos = await Promise.all(
    cfg.repos.map(async (rc): Promise<LoadedRepo> => {
      const info = await loadRepo(rc);
      const { stacks, warnings } = partitionStacks(info.commits, rc.stacks, rc.branch ?? rangeEnd(rc) ?? rc.name);
      const stackOf = new Map<string, number>();
      for (const g of stacks) for (const sha of g.shas) stackOf.set(sha, g.index);
      return { cfg: rc, info, stacks, warnings: [...rc.warnings, ...warnings], stackOf, ...repoDirs(cfg, rc.name) };
    }),
  );
  return { cfg, repos };
}

/** Newest mtime of anything in the project directory (project.yaml, prs/, reviews/), for "most recent". */
export function projectModified(dir: string): number {
  let max = 0;
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else {
        try {
          max = Math.max(max, fs.statSync(p).mtimeMs);
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(dir, 0);
  return max;
}
