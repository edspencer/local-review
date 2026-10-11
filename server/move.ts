// `local-review move`: move PRs' review data from one project to another, e.g. when a project is split into linked
// projects (`after:`) and some of its commits now belong to the new one. The data is keyed by commit sha
// (prs/<repo>/<sha>.yaml, reviews/<repo>/<sha>.yaml), so moving it is copying those files into the other project's
// directories and retiring the originals.
//
// Never-delete, as everywhere (website/src/content/docs/guarantees/never-delete.md): each file is written to the
// other project create-only (through safefs; an existing file there is never replaced: the whole move is refused
// first), and only then is the original renamed to `<sha>.moved-to-<project>.yaml.bak`, so it drops out of its old
// project (and out of rebase re-matching) with its contents still there. The images the moved PR descriptions show
// are copied too (content-named, so a copy is the same image); the originals stay, since other text may use them.
// project.yaml is never edited: what's left to do there (ranges, stacks, `landed:` lists) is printed instead.
// A snapshot of projects/ is taken first, when snapshots are on.
import fs from 'node:fs';
import path from 'node:path';
import { BACKUPS_DIR, PROJECTS_DIR, SAFE_NAME } from './config.js';
import { atomicWrite, renameToBak } from './safefs.js';
import { loadProject, loadProjectConfig, repoDirs } from './projects.js';
import { assetFile, assetRecordPath, assetsDir } from './assets.js';
import { takeSnapshot } from './backups.js';

export class MoveError extends Error {}

export interface MoveOpts {
  from: string; // project slugs
  to: string;
  repo: string; // the repo's name in `from`
  toRepo?: string; // its name in `to` (default: the same)
  shas?: string[]; // commit shas or unique prefixes (7+ hex)
  stack?: number; // or: every commit of this declared stack of `repo` in `from` (1-based)
  dryRun?: boolean;
}

export interface MoveStep {
  sha: string;
  kind: 'prs' | 'reviews';
  from: string; // the file moved
  to: string; // its copy in the other project
  bak: string; // where the original goes (planned name; the real one if taken: .2, .3, …)
}

export interface MoveResult {
  steps: MoveStep[];
  assets: string[]; // image files copied into the other project's assets/
  missing: string[]; // shas with no prs or reviews file to move (nothing recorded for them yet)
  notes: string[]; // what's left to do by hand in project.yaml
  snapshot: string | null;
  dryRun: boolean;
}

const SHA_FILE = /^([0-9a-f]{40})\.yaml$/;
const ASSET_REF = /assets\/([0-9a-f]{16}\.(?:png|jpe?g|gif|webp|svg))/g;

function shaFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).flatMap((f) => SHA_FILE.exec(f)?.[1] ?? []);
  } catch {
    return [];
  }
}

/** Work out the move (nothing written), then do it unless `dryRun`. Throws MoveError on anything that'd clobber. */
export async function movePrs(o: MoveOpts): Promise<MoveResult> {
  if (!SAFE_NAME.test(o.from) || !SAFE_NAME.test(o.to)) throw new MoveError('project names are directory names under projects/');
  if (o.from === o.to) throw new MoveError('the two projects are the same');
  const fromCfg = loadProjectConfig(o.from);
  const toCfg = loadProjectConfig(o.to);
  if (!fromCfg) throw new MoveError(`no project '${o.from}' in ${PROJECTS_DIR}`);
  if (!toCfg) throw new MoveError(`no project '${o.to}' in ${PROJECTS_DIR} (create its project.yaml first: local-review init ${o.to})`);
  const repoCfg = fromCfg.repos.find((r) => r.name === o.repo);
  if (!repoCfg) throw new MoveError(`no repo '${o.repo}' in project '${o.from}' (repos: ${fromCfg.repos.map((r) => r.name).join(', ') || 'none'})`);
  const toRepo = o.toRepo ?? o.repo;
  if (!toCfg.repos.some((r) => r.name === toRepo)) throw new MoveError(`no repo '${toRepo}' in project '${o.to}'; add it to its project.yaml first (or pass --to-repo)`);
  if (!o.shas?.length && o.stack === undefined) throw new MoveError('say which PRs: commit shas, or --stack <n>');
  const src = repoDirs(fromCfg, o.repo);
  const dst = repoDirs(toCfg, toRepo);

  // which commits: a stack of the loaded range, or shas / prefixes among the range and the files on disk (after a
  // split the commits may already be in the other project's range, and only the files are left here)
  let shas: string[];
  if (o.stack !== undefined) {
    const p = await loadProject(o.from);
    const r = p?.repos.find((x) => x.cfg.name === o.repo);
    const g = r?.stacks.find((s) => s.number === o.stack);
    if (!g) throw new MoveError(`no stack ${o.stack} in ${o.from}/${o.repo}`);
    if (!g.shas.length) throw new MoveError(`stack ${o.stack} "${g.title}" in ${o.from}/${o.repo} has no commits`);
    shas = g.shas;
  } else {
    const p = await loadProject(o.from).catch(() => null);
    const known = new Set([...(p?.repos.find((x) => x.cfg.name === o.repo)?.info.commits.map((c) => c.sha) ?? []), ...shaFiles(src.prsDir), ...shaFiles(src.reviewsDir)]);
    shas = o.shas!.map((q) => {
      const s = q.toLowerCase();
      if (!/^[0-9a-f]{7,40}$/.test(s)) throw new MoveError(`'${q}' isn't a commit sha (7 to 40 hex digits)`);
      const m = [...known].filter((k) => k.startsWith(s));
      if (!m.length) throw new MoveError(`no commit or prs / reviews file '${q}' in ${o.from}/${o.repo}`);
      if (m.length > 1) throw new MoveError(`'${q}' is ambiguous in ${o.from}/${o.repo} (${m.map((x) => x.slice(0, 12)).join(', ')})`);
      return m[0];
    });
  }
  shas = [...new Set(shas)];

  const res: MoveResult = { steps: [], assets: [], missing: [], notes: [], snapshot: null, dryRun: !!o.dryRun };
  for (const sha of shas) {
    let any = false;
    for (const [kind, from, to] of [['prs', src.prsDir, dst.prsDir], ['reviews', src.reviewsDir, dst.reviewsDir]] as const) {
      const f = path.join(from, `${sha}.yaml`);
      if (!fs.existsSync(f)) continue;
      any = true;
      const t = path.join(to, `${sha}.yaml`);
      if (fs.existsSync(t)) throw new MoveError(`${t} already exists; not replacing it (nothing was moved). Compare the two and merge them by hand, or rename one to .bak`);
      res.steps.push({ sha, kind, from: f, to: t, bak: f.replace(/\.yaml$/, `.moved-to-${o.to}.yaml.bak`) });
    }
    if (!any) res.missing.push(sha);
  }
  // the images the moved files show (in a prs file's description), copied unless the other project has them
  const names = new Set<string>();
  for (const s of res.steps) for (const m of fs.readFileSync(s.from, 'utf8').matchAll(ASSET_REF)) names.add(m[1]);
  const assetCopies: [string, string][] = [];
  for (const n of [...names].sort()) {
    const file = assetFile(fromCfg.dir, n);
    if (!file || assetFile(toCfg.dir, n)) continue;
    assetCopies.push([file, path.join(assetsDir(toCfg.dir), n)]);
    const rec = assetRecordPath(fromCfg.dir, n);
    if (fs.existsSync(rec) && !fs.existsSync(assetRecordPath(toCfg.dir, n))) assetCopies.push([rec, assetRecordPath(toCfg.dir, n)]);
  }
  res.assets = assetCopies.map(([, t]) => t);

  // what project.yaml still needs (it's never edited here)
  const landed = new Set(repoCfg.landed.map(String));
  const listed = shas.filter((s) => [...landed].some((k) => k.length >= 7 && s.startsWith(k.toLowerCase())));
  if (listed.length)
    res.notes.push(`${listed.length} of these ${listed.length === 1 ? 'is a landed PR' : 'are landed PRs'} (${listed.map((s) => s.slice(0, 8)).join(', ')}): move ${listed.length === 1 ? 'its key' : 'their keys'} from ${o.from}'s \`landed:\` list for ${o.repo} to ${o.to}'s for ${toRepo}`);
  res.notes.push(`check both project.yaml files: each repo's range (branch / to, base / from, or \`after: ${o.from}\` in ${o.to}) and its stacks' starts_at should now cover the commits that are in that project`);

  if (o.dryRun) return res;
  if (BACKUPS_DIR) res.snapshot = takeSnapshot(PROJECTS_DIR, BACKUPS_DIR);
  for (const [from, to] of assetCopies) atomicWrite(to, fs.readFileSync(from), { createOnly: true });
  // every copy first, then the renames: an interruption leaves at worst both copies, never neither
  for (const s of res.steps) atomicWrite(s.to, fs.readFileSync(s.from), { createOnly: true });
  for (const s of res.steps) s.bak = renameToBak(s.from, `moved-to-${o.to}`);
  return res;
}

export function moveReport(r: MoveResult, o: MoveOpts): string {
  const out: string[] = [];
  const rel = (p: string) => path.relative(PROJECTS_DIR, p);
  out.push(r.dryRun ? `Dry run: nothing written. Moving from ${o.from} to ${o.to} would:` : `Moved from ${o.from} to ${o.to}:`);
  if (r.snapshot) out.push(`  (snapshot first: backups/${r.snapshot})`);
  for (const s of r.steps) out.push(`  ${s.sha.slice(0, 8)} ${s.kind}: ${rel(s.from)} → ${rel(s.to)}; the original renamed to ${path.basename(s.bak)}`);
  for (const a of r.assets) out.push(`  image ${path.basename(a)} copied to ${rel(a)}`);
  if (!r.steps.length) out.push('  (no prs or reviews files to move)');
  if (r.missing.length) out.push(`Nothing recorded yet for ${r.missing.map((s) => s.slice(0, 8)).join(', ')} (no prs or reviews file): nothing to move.`);
  for (const n of r.notes) out.push(`Then: ${n}.`);
  return out.join('\n');
}
