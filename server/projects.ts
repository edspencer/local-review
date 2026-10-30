// Projects: projects/<slug>/project.yaml lists repos (each a commit range), and splits each repo's commits
// into consecutive, colour-coded PR stacks. A loaded project is reused only while everything it was built from is
// unchanged (project.yaml, the prs/ files, each range's git state: see stamps.ts), so edits (by the reviewer or an
// agent) and rebases show up without a restart.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { PROJECTS_DIR, SAFE_NAME, expandHome, safeName } from './config.js';
import { loadRepo, rangeEnd, type RepoInfo, type RepoRange } from './commits.js';
import { normalizeSubject } from './reviews.js';
import { loadLanded } from './landed.js';
import { loadPrs, type LoadedPr } from './prs.js';
import { inspectOrphan, liveCommits } from './context.js';
import { foldFollowUps } from './followups.js';
import type { RefIndex } from './branches.js';
import { dirStamp, repoState, type RepoState } from './stamps.js';

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
  follow_on?: boolean; // parked work: held back from the stacks going up now (advisory; `local-review plan` skips it)
}

export interface RepoConfig extends RepoRange {
  index: number; // position in project.yaml's `repos` list (for writing back to the file)
  stacks: StackSpec[]; // empty: one implicit stack named after the branch
  warnings: string[]; // config problems (bad colour, …)
  landed: unknown[]; // `landed:` keys of prs files (sha or prefix), bottom to top, as written; resolved in loadProject
  github_stack?: number; // the GitHub stack the repo's PRs went up as (informational only)
  pr_model?: 'follow-ups'; // a PR is its commit plus the follow-up commits up to its branch's head (followups.ts)
}

export interface ProjectConfig {
  slug: string;
  dir: string;
  file: string;
  title: string;
  description: string | null;
  repos: RepoConfig[];
  error?: string;
  example?: boolean; // `example: true`: one of the example projects (server/examples.ts); the UI labels it and offers to remove it
  hidden?: boolean; // `hidden: true`: kept off the root page, the switcher and linked projects' "Next" links; its URL still opens it
  after?: string; // `after: <slug>`: the project this one builds on (linked projects; see resolveLink)
  github_sync?: false; // `github: {sync: off}`: leave this project's PRs out of the GitHub sync (server/github.ts)
  warnings: string[]; // project-level problems that aren't errors (a bad `after:`)
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

/** A switch: flag()'s yes / no, plus on / off. */
export function onOff(v: unknown): boolean | undefined {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : undefined;
  return t === 'on' ? true : t === 'off' ? false : flag(v);
}

const text = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : typeof v === 'object' ? undefined : String(v));

/** Parse a project.yaml. Never throws: problems are reported as `error` (whole file) or repo `warnings`. */
export function parseProject(slug: string, dir: string, raw: string): ProjectConfig {
  const file = path.join(dir, 'project.yaml');
  const out: ProjectConfig = { slug, dir, file, title: slug, description: null, repos: [], warnings: [] };
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
  if (flag(doc.example)) out.example = true;
  if (flag(doc.hidden)) out.hidden = true;
  if (doc.github != null) {
    const sync = onOff(typeof doc.github === 'object' && !Array.isArray(doc.github) ? doc.github.sync : doc.github);
    if (sync === false) out.github_sync = false;
    else if (sync === undefined) out.warnings.push(`\`github\` must be \`{sync: off}\` (or \`{sync: on}\`, the default), not ${JSON.stringify(doc.github)}; ignored`);
  }
  if (doc.after != null) {
    const a = text(doc.after)?.trim();
    if (a && SAFE_NAME.test(a)) out.after = a;
    else out.warnings.push(`\`after\` must be the slug of another project (its directory name under projects/), not ${JSON.stringify(doc.after)}; ignored`);
  }
  const list: any[] = Array.isArray(doc.repos) ? doc.repos : [];
  if (doc.repos != null && !Array.isArray(doc.repos)) out.error = `${file}: \`repos\` must be a list`;
  const used = new Set<string>();
  for (const [index, r] of list.entries()) {
    // a config mistake, said so (the sidebar, the project page and `plan` show project warnings), never dropped silently
    const preview = () => { const j = JSON.stringify(r) ?? String(r); return j.length > 60 ? `${j.slice(0, 57)}…` : j; };
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      out.warnings.push(`repo ${index + 1} in \`repos\` (${preview()}) isn't a mapping (path:, branch: …), so it's skipped.`);
      continue;
    }
    if (typeof r.path !== 'string' || !r.path.trim()) {
      out.warnings.push(`repo ${index + 1} in \`repos\` (${preview()}) has no \`path\`, so it's skipped. Give it the path of a git checkout.`);
      continue;
    }
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
    let landed: unknown[] = [];
    if (Array.isArray(r.landed)) landed = r.landed;
    else if (r.landed != null) warnings.push('`landed` must be a list of prs file keys (sha prefixes); ignored');
    const ghStack = Number(text(r.github_stack)?.replace(/^#/, ''));
    const model = text(r.pr_model)?.trim().toLowerCase();
    if (model && model !== 'follow-ups' && model !== 'commit') warnings.push(`\`pr_model\` must be follow-ups or commit, not ${JSON.stringify(r.pr_model)}; ignored`);
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
      landed,
      ...(Number.isSafeInteger(ghStack) && ghStack > 0 ? { github_stack: ghStack } : {}),
      ...(model === 'follow-ups' ? { pr_model: 'follow-ups' as const } : {}),
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
export function partitionStacks(commits: { sha: string; subject: string; title?: string }[], specs: StackSpec[], defaultTitle = 'Stack'): { stacks: StackGroup[]; warnings: string[]; unmatched?: boolean } {
  const warnings: string[] = [];
  let unmatched = false;
  if (!specs.length) {
    return { stacks: [{ index: 0, number: null, title: defaultTitle, color: PALETTE[0], implicit: 'branch', shas: commits.map((c) => c.sha) }], warnings };
  }
  // nothing to place (e.g. the branch has no commits yet): empty stacks, no warnings
  const declared = (s: StackSpec, i: number, index: number, shas: string[]): StackGroup => ({ index, number: i + 1, title: s.title, color: s.follow_on ? FOLLOW_ON_COLOR : s.color, shas, ...(s.description ? { description: s.description } : {}), ...(s.follow_on ? { follow_on: true } : {}) });
  if (!commits.length) return { stacks: specs.map((s, i) => declared(s, i, i, [])), warnings };
  const subjects = commits.map((c) => normalizeSubject(c.subject));
  // a PR's title (override) is tried after the subjects: a landed multi-commit PR has no meaningful single subject
  const titles = commits.map((c) => (c.title ? normalizeSubject(c.title) : ''));
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
        if (!cands.length) cands = titles.flatMap((t, j) => (t && t === n ? [j] : []));
      }
    }
    if (!cands.length) {
      unmatched = true;
      specWarnings.push(`${label}: starts_at "${sel}" doesn't match any commit (sha prefix, subject or PR title), so it is empty`);
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
  return { stacks: groups, warnings, ...(unmatched ? { unmatched } : {}) };
}

export interface LoadedRepo {
  cfg: RepoConfig;
  info: RepoInfo;
  stacks: StackGroup[];
  warnings: string[];
  stackOf: Map<string, number>; // sha -> index into stacks
  reviewsDir: string;
  prsDir: string;
  refIndex: RefIndex; // the repo's branches, as of the git state the range was read at
}

/** Shared between requests while nothing it depends on changes: treat it as read-only. */
export interface LoadedProject {
  cfg: ProjectConfig;
  repos: LoadedRepo[];
  /** linked projects: the predecessor (`after:`), if it's valid, and the project-level warnings (config and link) */
  after: { slug: string; title: string } | null;
  warnings: string[];
}

/**
 * A project's predecessor (`after: <slug>`), if it names another existing project without a cycle; else a warning
 * and no link. Reads configs only (no git, no loading), so following a chain is cheap.
 */
export function resolveLink(cfg: ProjectConfig): { pred: ProjectConfig | null; warnings: string[] } {
  if (!cfg.after) return { pred: null, warnings: [] };
  if (cfg.after === cfg.slug) return { pred: null, warnings: ['`after` names this project itself; ignored'] };
  const pred = projectConfig(cfg.after)?.cfg ?? null;
  if (!pred) return { pred: null, warnings: [`\`after: ${cfg.after}\`: there's no project '${cfg.after}' (a directory under projects/ with a project.yaml); ignored`] };
  // a cycle (a after b after a) would make every one of them start where another ends: refuse the link
  const seen = new Set([cfg.slug]);
  for (let c: ProjectConfig | null = pred; c?.after; c = projectConfig(c.after)?.cfg ?? null) {
    if (seen.has(c.slug) || seen.size > 100) return { pred: null, warnings: [`\`after: ${cfg.after}\` makes a cycle (${[...seen, c.slug].join(' → ')}); ignored`] };
    seen.add(c.slug);
    if (c.after === cfg.slug) return { pred: null, warnings: [`\`after: ${cfg.after}\` makes a cycle (${[...seen, cfg.slug].join(' → ')}); ignored`] };
  }
  return { pred, warnings: [] };
}

/** The predecessor's repo that this one continues: the same clone (path), else the same name. */
export function sharedRepo(pred: ProjectConfig, rc: RepoConfig): RepoConfig | null {
  return pred.repos.find((p) => p.path === rc.path) ?? pred.repos.find((p) => p.name === rc.name) ?? null;
}

/**
 * The project's repos with each one's `after` set (the predecessor's range end in that repo) where it continues the
 * predecessor's range: the ranges as they're actually read. The branch poll (events.ts) watches these too.
 */
export function linkedRepos(cfg: ProjectConfig, pred = resolveLink(cfg).pred): RepoConfig[] {
  return cfg.repos.map((rc): RepoConfig => {
    const shared = pred && !rc.from ? sharedRepo(pred, rc) : null;
    const end = shared ? rangeEnd(shared) : '';
    return end ? { ...rc, after: end } : rc;
  });
}

/** Each successor project of `slug`: the projects whose valid `after:` names it, by title; `hidden` if it's hidden. */
export function successorsOf(slug: string): { slug: string; title: string; hidden?: true }[] {
  return listProjectSlugs()
    .map((s) => (s === slug ? null : projectConfig(s)?.cfg ?? null))
    .filter((c): c is ProjectConfig => !!c && c.after === slug && resolveLink(c).pred?.slug === slug)
    .map((c) => (c.hidden ? { slug: c.slug, title: c.title, hidden: true as const } : { slug: c.slug, title: c.title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function repoDirs(project: ProjectConfig, repo: string) {
  if (!SAFE_NAME.test(repo)) throw new Error(`bad repo name: ${repo}`);
  return { reviewsDir: path.join(project.dir, 'reviews', repo), prsDir: path.join(project.dir, 'prs', repo) };
}

// the last parse of each project.yaml (by its text), and the last load of each project with the stamps it was made at
let parses = 0;
const configs = new Map<string, { raw: string; cfg: ProjectConfig; version: number }>();
const loaded = new Map<string, { key: string; p: Promise<LoadedProject | null> }>();

/** loadProjectConfig, reparsed only when project.yaml's text changes. Shared: treat it as read-only. */
function projectConfig(slug: string): { cfg: ProjectConfig; version: number } | null {
  const dir = projectDir(slug);
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, 'project.yaml'), 'utf8');
  } catch {
    configs.delete(slug);
    return null;
  }
  const hit = configs.get(slug);
  if (hit?.raw === raw) return hit;
  const e = { raw, cfg: parseProject(slug, dir, raw), version: ++parses };
  configs.set(slug, e);
  return e;
}

/** A project with each repo's range and stacks; the last one loaded if nothing it's built from has changed since. */
export async function loadProject(slug: string): Promise<LoadedProject | null> {
  const c = projectConfig(slug);
  if (!c) {
    loaded.delete(slug);
    return null;
  }
  const { cfg } = c;
  // linked projects: a repo the predecessor also has starts where the predecessor's range there ends (its branch or
  // `to:`), while that's an ancestor; `from:` still wins (commits.ts loadRepo)
  const link = resolveLink(cfg);
  const repos = linkedRepos(cfg, link.pred);
  const states = await Promise.all(repos.map((rc) => repoState(rc)));
  const predPrs = link.pred ? repos.map((rc) => (rc.after ? dirStamp(repoDirs(link.pred!, sharedRepo(link.pred!, rc)!.name).prsDir) : '')) : [];
  const key = JSON.stringify([c.version, link.pred?.slug ?? null, link.pred?.title ?? null, link.warnings, predPrs, repos.map((rc, i) => [rc.after ?? null, states[i].stamp, dirStamp(repoDirs(cfg, rc.name).prsDir)])]);
  const hit = loaded.get(slug);
  if (hit?.key === key) return hit.p;
  const p = buildProject({ ...cfg, repos }, states, link);
  loaded.set(slug, { key, p });
  p.catch(() => {
    if (loaded.get(slug)?.p === p) loaded.delete(slug);
  });
  return p;
}

async function buildProject(cfg: ProjectConfig, states: RepoState[], link: { pred: ProjectConfig | null; warnings: string[] }): Promise<LoadedProject> {
  const repos = await Promise.all(
    cfg.repos.map(async (rc, ri): Promise<LoadedRepo> => {
      const dirs = repoDirs(cfg, rc.name);
      // with landed PRs, a missing / deleted branch or an empty live range is fine: they still show
      const info = await loadRepo(rc, { optional: rc.landed.length > 0, refs: states[ri].refs });
      const extra: string[] = info.warning ? [info.warning] : [];
      let titles = new Map<string, string>();
      if (rc.landed.length && !info.error) {
        const landed = await loadLanded(rc.path, dirs.prsDir, rc.landed);
        extra.push(...landed.warnings);
        titles = landed.titles;
        // a frozen PR whose commit is still in the live range (frozen before the rebase) is shown once, as landed
        const keys = new Set(landed.commits.map((c) => c.sha));
        info.commits = [...landed.commits, ...info.commits.filter((c) => !keys.has(c.sha))];
      }
      // follow-up commits on a PR's branch are part of that PR, not PRs of their own
      if (rc.pr_model === 'follow-ups' && !info.error && info.commits.some((c) => !c.landed)) {
        const prs = await loadPrs(dirs.prsDir, liveCommits(rc, info), inspectOrphan(rc, info)).catch(() => new Map<string, LoadedPr>());
        info.commits = await foldFollowUps(rc.path, info.commits, prs, states[ri].refIndex).catch(() => info.commits);
      }
      const defaultTitle = rc.branch || rangeEnd(rc) || rc.name;
      let part = partitionStacks(info.commits.map((c) => ({ sha: c.sha, subject: c.subject, title: titles.get(c.sha) })), rc.stacks, defaultTitle);
      // a selector that's no sha or subject may be a live PR's title: only then read the prs files for titles
      if (part.unmatched && info.commits.some((c) => !c.landed)) {
        const prs = await loadPrs(dirs.prsDir, liveCommits(rc, info), inspectOrphan(rc, info)).catch(() => new Map<string, LoadedPr>());
        part = partitionStacks(info.commits.map((c) => ({ sha: c.sha, subject: c.subject, title: titles.get(c.sha) ?? prs.get(c.sha)?.override.title })), rc.stacks, defaultTitle);
      }
      const { stacks, warnings } = part;
      if (rc.after && link.pred && !info.error) extra.push(...linkWarnings(link.pred, rc, info, states[ri].refs.after ?? null));
      const stackOf = new Map<string, number>();
      for (const g of stacks) for (const sha of g.shas) stackOf.set(sha, g.index);
      return { cfg: rc, info, stacks, warnings: [...rc.warnings, ...extra, ...warnings], stackOf, ...dirs, refIndex: states[ri].refIndex };
    }),
  );
  return { cfg, repos, after: link.pred ? { slug: link.pred.slug, title: link.pred.title } : null, warnings: [...cfg.warnings, ...link.warnings] };
}

/**
 * Linked projects: when a shared repo's range doesn't start at the predecessor's end, check it hasn't picked up the
 * predecessor's own commits. That happens when the predecessor was squash-merged (its commits never reach the base)
 * and this branch hasn't been rebased onto the base yet, with the predecessor's branch gone: the range then runs from
 * the merge-base with the base and includes them. They're recognised by sha: the predecessor's prs files are named
 * after its commits. Never drops or hides them; it says what to do.
 */
function linkWarnings(pred: ProjectConfig, rc: RepoConfig, info: RepoInfo, afterSha: string | null): string[] {
  if (info.startsAfter) return [];
  const shared = sharedRepo(pred, rc)!;
  const out: string[] = [];
  const predPrs = repoDirs(pred, shared.name).prsDir;
  let keys = new Set<string>();
  try {
    keys = new Set(fs.readdirSync(predPrs).filter((f) => /^[0-9a-f]{40}\.yaml$/.test(f)).map((f) => f.slice(0, 40)));
  } catch {
    /* none */
  }
  const theirs = info.commits.filter((c) => keys.has(c.sha));
  if (theirs.length)
    out.push(
      `includes ${theirs.length} commit${theirs.length === 1 ? '' : 's'} of the project it builds on, ${pred.slug} (${theirs.map((c) => c.short).join(', ')}): ` +
        (afterSha
          ? `its range end '${rc.after}' isn't an ancestor of this branch any more, so this range starts at ${info.base ?? 'the base'} instead. If ${pred.slug} was squash-merged, rebase this branch onto ${info.base ?? 'the base'}`
          : `its range end '${rc.after}' doesn't exist (a deleted branch?). Restore it, or rebase this branch onto ${info.base ?? 'the base'} once ${pred.slug} has merged`),
    );
  else if (!afterSha && !shared.landed.length)
    out.push(`builds on ${pred.slug}, whose range end here, '${rc.after}', doesn't exist, and none of its PRs have landed: this range starts at ${info.base ?? 'the base'} instead`);
  return out;
}

/**
 * Archived: everything in the project has landed. Some repo has landed PRs, and no repo has a live (unmerged) commit
 * or an error. The project switcher lists these in a separate, collapsed section.
 */
export function isArchived(p: LoadedProject): boolean {
  if (p.cfg.error || !p.repos.length) return false;
  return p.repos.some((r) => r.info.commits.some((c) => c.landed)) && p.repos.every((r) => !r.info.error && r.info.commits.every((c) => c.landed));
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
