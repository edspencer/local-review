// The read-only materialization plan: for each candidate PR (commit) in scope, in order, what the real GitHub PR
// would be: branch, base, title and the exact full body (the same composition as the UI's "Full body" button).
// Never writes anything and never talks to GitHub; `local-review plan` prints it, an agent follows it after the reviewer says go.
import fs from 'node:fs';
import YAML from 'yaml';
import { fullPrBody } from '../shared/prText.js';
import { baseSha, commitBody, isAncestor } from './commits.js';
import { contextFor, inspectOrphan, liveCommits } from './context.js';
import { viewReview, type Published, type Thread } from './reviews.js';
import { loadRefs, reconcileBranch, stripRemote, type BranchInfo } from './branches.js';
import { loadPrs, prPath, prView, readPrFile, type GithubPr, type LoadedPr } from './prs.js';
import { loadProject, type LoadedProject, type LoadedRepo } from './projects.js';
import { prStatus, type PrStatus } from '../shared/readiness.js';
import { assetsDir, resolveAssetRefs, type AssetUse } from './assets.js';

export interface PlanPr {
  repo: string;
  stack: { number: number | null; title: string; position: number; count: number; follow_on: boolean };
  number: number; // PR number within the repo's range ("PR 3"), oldest first
  commit: string;
  short: string;
  subject: string;
  branch: BranchInfo | null;
  base: string | null;
  base_from: 'previous-pr' | 'repo-base' | 'predecessor'; // predecessor: the top PR of the project this one builds on (`after:`)
  title: string;
  title_source: 'commit' | 'override';
  body: string; // the full PR body: intro, stack note, ---, PR description (images with a published URL point at it)
  images: AssetUse[]; // the project assets the body shows: each one's file here, and its published URL if recorded
  github: GithubPr | null;
  status: PrStatus; // draft / ready (the reviewer's call, prs/ `status:`), or published once `github` is recorded
  publish_threads: PlanThread[]; // threads the reviewer marked for the GitHub PR (`publish: true`), posted or not
  warnings: string[];
}

/**
 * A review thread meant for the GitHub PR: the agent posts it as part of the PR's review when it publishes the stack
 * (an inline one at its line, a general one in the review's body), then records `published:`.
 */
export interface PlanThread {
  id: string;
  path: string | null; // null: a general comment, for the review's body
  line: number | null; // null with a path: a comment on the whole file
  side: 'left' | 'right' | null; // GitHub's LEFT (the old file) / RIGHT (the new one)
  start_line: number | null; // a multi-line comment's first line
  start_side: 'left' | 'right' | null;
  outdated: boolean; // the commented lines aren't in the PR's diff any more: there's no line to post it on
  resolved: boolean;
  comments: { id: string; author: string; created: string | null; body: string }[]; // bodies as for GitHub (published image URLs in place)
  published: Published | null; // the agent's record of the posted comment; null: not posted yet
}

export interface Plan {
  project: string;
  title: string;
  scope: { repo: string | null; stack: number | null; include_follow_on: boolean };
  prs: PlanPr[];
  // follow-on stacks (project.yaml `follow_on: true`) left out because neither --include-follow-on nor --stack named them
  excluded_follow_on: { repo: string; stack: number; title: string; prs: number[] }[];
  // landed (merged) PRs: never planned, whatever the options
  excluded_landed: { repo: string; prs: number[] }[];
  notes: string[]; // informational, not problems: excluded follow-on stacks, a follow-on stack named by --stack
  warnings: string[]; // everything that needs attention before materializing, prefixed with where it is
}

export class PlanError extends Error {}

export interface PlanOpts {
  repo?: string;
  stack?: number;
  includeFollowOn?: boolean; // also plan follow-on stacks (parked work); default: leave them out
}

export async function buildPlan(project: LoadedProject, opts: PlanOpts = {}): Promise<Plan> {
  let repos = project.repos;
  if (opts.repo !== undefined) {
    repos = repos.filter((r) => r.cfg.name === opts.repo);
    if (!repos.length) throw new PlanError(`no repo '${opts.repo}' in project '${project.cfg.slug}' (repos: ${project.repos.map((r) => r.cfg.name).join(', ')})`);
  }
  if (opts.stack !== undefined) {
    const has = repos.filter((r) => r.stacks.some((g) => g.number === opts.stack));
    if (!has.length) throw new PlanError(`no stack ${opts.stack} in ${opts.repo ? `repo '${opts.repo}'` : `project '${project.cfg.slug}'`}`);
    if (has.length > 1) throw new PlanError(`stack ${opts.stack} exists in several repos (${has.map((r) => r.cfg.name).join(', ')}); pick one with --repo`);
    repos = has;
  }
  const includeFollowOn = !!opts.includeFollowOn;
  const plan: Plan = { project: project.cfg.slug, title: project.cfg.title, scope: { repo: opts.repo ?? null, stack: opts.stack ?? null, include_follow_on: includeFollowOn }, prs: [], excluded_follow_on: [], excluded_landed: [], notes: [], warnings: [] };
  if (project.cfg.error) plan.warnings.push(`project: ${project.cfg.error}`);
  for (const w of project.warnings) plan.warnings.push(`project: ${w}`);
  for (const r of repos) {
    // an explicitly named stack is always planned; otherwise follow-on stacks only with --include-follow-on
    const skip = new Set<number>();
    for (const g of r.stacks) {
      if (!g.follow_on || g.number === null) continue;
      if (opts.stack !== undefined) {
        if (g.number === opts.stack) plan.notes.push(`${r.cfg.name} stack ${g.number} "${g.title}" is a follow-on stack (parked work, held back from the stacks going up now)`);
      } else if (!includeFollowOn) {
        skip.add(g.number);
        if (g.shas.length) plan.excluded_follow_on.push({ repo: r.cfg.name, stack: g.number, title: g.title, prs: g.shas.map((s) => r.info.commits.findIndex((c) => c.sha === s) + 1) });
      }
    }
    const { prs, warnings, landed } = await repoPlan(project, r, opts.stack, skip);
    plan.prs.push(...prs);
    plan.warnings.push(...warnings);
    if (landed.length) {
      plan.excluded_landed.push({ repo: r.cfg.name, prs: landed });
      plan.notes.push(`Skipped ${landed.length} landed (merged) PR${landed.length === 1 ? '' : 's'} in ${r.cfg.name}: ${landed.map((n) => `PR #${n}`).join(', ')}`);
    }
  }
  const ex = plan.excluded_follow_on;
  if (ex.length) {
    const n = ex.reduce((a, x) => a + x.prs.length, 0);
    plan.notes.unshift(
      `Excluded ${ex.length} follow-on stack${ex.length === 1 ? '' : 's'} (${n} PR${n === 1 ? '' : 's'}: ${ex.map((x) => `${x.repo} stack ${x.stack} "${x.title}"`).join(', ')}); use --include-follow-on`,
    );
  }
  return plan;
}

async function repoPlan(project: LoadedProject, r: LoadedRepo, onlyStack?: number, skip = new Set<number>()): Promise<{ prs: PlanPr[]; warnings: string[]; landed: number[] }> {
  const name = r.cfg.name;
  const warnings: string[] = [];
  const landed: number[] = [];
  if (r.info.error) return { prs: [], warnings: [`${name}: ${r.info.error}`], landed };
  for (const w of r.warnings) warnings.push(`${name}: ${w}`);
  const [loaded, refs] = await Promise.all([
    loadPrs(r.prsDir, liveCommits(r.cfg, r.info), inspectOrphan(r.cfg, r.info)).catch(() => new Map<string, LoadedPr>()),
    loadRefs(r.info.path),
  ]);
  const tip = r.cfg.branch ?? r.info.end ?? null;
  const position = new Map(r.info.commits.map((c, i) => [c.sha, i + 1]));
  const repoBase = r.info.base ? stripRemote(refs, r.info.base) : null;
  // linked projects: a range that starts at the predecessor's end goes up on top of the predecessor's top PR
  const pred = r.info.startsAfter ? await predecessorTop(project, r) : null;
  const out: PlanPr[] = [];
  let prevBranch: string | null = null;
  let first = true; // the first live (unmerged) PR goes onto the repo base
  for (const [i, c] of r.info.commits.entries()) {
    const g = r.stacks[r.stackOf.get(c.sha) ?? 0];
    if (c.landed) {
      // merged: history, never planned (and no warnings); the PRs above it go onto the repo base
      if (onlyStack === undefined || g?.number === onlyStack) landed.push(i + 1);
      continue;
    }
    const l = loaded.get(c.sha);
    const branch = reconcileBranch(refs, c.sha, l?.override, tip);
    const isFirst = first;
    first = false;
    const base = isFirst ? (pred ? pred.base : repoBase) : prevBranch;
    const inScope = (onlyStack === undefined || g?.number === onlyStack) && !(g?.number != null && skip.has(g.number));
    if (inScope) {
      const view = prView(l, { subject: c.subject, body: await commitBody(r.info.path, c.sha) });
      const w: string[] = [];
      if (!branch) w.push('no branch: the agent must choose one (git branch <name> <sha>) and record it');
      else if (branch.status === 'missing') w.push(`branch '${branch.name}' is recorded but doesn't exist in git`);
      else if (branch.status === 'moved') {
        const at = branch.points_at && position.get(branch.points_at);
        w.push(`branch '${branch.name}' points at ${branch.points_at?.slice(0, 8)}${at ? ` (PR #${at})` : ', not in the range'}, not this commit (rebased without --update-refs?)`);
      }
      // (no base because the previous PR has no branch is that PR's warning, not another one)
      if (isFirst && pred) w.push(...pred.warnings);
      else if (base === null && isFirst) w.push(r.info.from ? 'no base: the range starts with `from:`; give the repo a `base:`' : 'no base branch');
      const gb = l?.override.github?.base;
      if (gb && base && gb !== base) w.push(`its GitHub PR #${l!.override.github!.number} has base '${gb}', but the plan's base is '${base}' (retarget the PR, or check the order)`);
      if (l?.parseError) w.push(`prs file doesn't parse: ${l.parseError}`);
      // images: GitHub can't show a file on this machine, so each needs a published URL (or a manual upload)
      const { body, assets: images } = resolveAssetRefs(project.cfg.dir, fullPrBody({ intro: project.cfg.description, stackNote: g?.description, body: view.body }));
      const nBodyImages = images.length;
      for (const a of images) {
        if (a.url) continue;
        if (!a.file) w.push(`image assets/${a.name} isn't in the project's assets folder (${assetsDir(project.cfg.dir)}); add it with \`local-review asset add\`, or fix the reference`);
        else w.push(`image assets/${a.name} has no published URL, so GitHub can't show it: drag ${a.file} into the PR on GitHub (which replaces the reference), or record a URL with \`local-review asset url ${project.cfg.slug} ${a.name} <url>\``);
      }
      // threads marked for the GitHub PR: each one's comments, as they'd be posted
      const publish: PlanThread[] = [];
      const rv = await viewReview(contextFor(r.reviewsDir, r.cfg, r.info, c)).catch(() => null);
      if (rv?.parseError) w.push(`review file doesn't parse, so any comments marked for GitHub aren't listed: ${rv.parseError}`);
      for (const t of rv && !rv.parseError ? rv.review.threads.filter((x) => x.publish && x.comments.length) : []) {
        const pt = planThread(project.cfg.dir, t, images);
        publish.push(pt);
        if (pt.published) continue;
        const where = pt.path ? `${pt.path}${pt.line ? `:${pt.line}` : ''}` : 'general';
        if (pt.outdated) w.push(`comment for GitHub ${t.id} (${where}) is outdated: its lines aren't in this diff any more, so post it in the review's body (or ask the reviewer)`);
      }
      const unposted = publish.filter((x) => !x.published).length;
      if (unposted && l?.override.github) w.push(`${unposted} comment${unposted === 1 ? '' : 's'} marked for GitHub ${unposted === 1 ? "isn't" : "aren't"} posted on PR #${l.override.github.number} yet`);
      for (const a of images.slice(nBodyImages)) {
        if (a.url) continue;
        w.push(a.file
          ? `image assets/${a.name} in a comment for GitHub has no published URL, so GitHub can't show it: record one with \`local-review asset url ${project.cfg.slug} ${a.name} <url>\`, or leave it to the reviewer`
          : `image assets/${a.name} in a comment for GitHub isn't in the project's assets folder`);
      }
      const pr: PlanPr = {
        repo: name,
        stack: { number: g?.number ?? null, title: g?.title ?? '', position: (g?.shas.indexOf(c.sha) ?? 0) + 1, count: g?.shas.length ?? 0, follow_on: !!g?.follow_on },
        number: i + 1,
        commit: c.sha,
        short: c.short,
        subject: c.subject,
        branch,
        base,
        base_from: isFirst ? (pred ? 'predecessor' : 'repo-base') : 'previous-pr',
        title: view.title,
        title_source: view.title_source,
        body,
        images,
        github: l?.override.github ?? null,
        status: prStatus(l?.override),
        publish_threads: publish,
        warnings: w,
      };
      out.push(pr);
      for (const x of w) warnings.push(`${name} ${stackLabel(pr)} PR #${pr.number} (${c.short} ${c.subject}): ${x}`);
    }
    prevBranch = branch?.name ?? null;
  }
  if (onlyStack !== undefined && !out.length && !landed.length) warnings.push(`${name} stack ${onlyStack}: empty (no commits)`);
  warnings.push(...(await unfrozen(r)).map((w) => `${name}: ${w}`));
  // drafts, per stack: only the reviewer marks a PR ready, so a stack with drafts isn't ready to publish
  const stacks = new Map<string, PlanPr[]>();
  for (const p of out) {
    const k = `${p.stack.number}\0${p.stack.title}`;
    stacks.set(k, [...(stacks.get(k) ?? []), p]);
  }
  for (const ps of stacks.values()) {
    const drafts = ps.filter((p) => p.status === 'draft');
    if (drafts.length)
      warnings.push(`${name} ${stackLabel(ps[0])}: ${drafts.length} of ${ps.length} PR${ps.length === 1 ? ' is' : 's are'} still draft (${drafts.map((p) => `PR #${p.number}`).join(', ')}); only the reviewer marks PRs ready`);
  }
  return { prs: out, warnings, landed };
}

/** One `publish: true` thread for the plan; any images its comments show are added to `images` (once each). */
function planThread(projectDir: string, t: Thread, images: AssetUse[]): PlanThread {
  const inline = !!(t.path && t.line);
  return {
    id: t.id,
    path: t.path ?? null,
    line: inline ? t.line! : null,
    side: inline ? (t.side ?? 'right') : null,
    start_line: inline ? (t.start_line ?? null) : null,
    start_side: inline && t.start_line ? (t.start_side ?? t.side ?? 'right') : null,
    outdated: !!t.outdated,
    resolved: t.resolved,
    comments: t.comments.map((c) => {
      const { body, assets } = resolveAssetRefs(projectDir, c.body);
      for (const a of assets) if (!images.some((x) => x.name === a.name)) images.push(a);
      return { id: c.id, author: c.author, created: c.created, body };
    }),
    published: t.published ?? null,
  };
}

/**
 * The base for the first PR of a repo whose range starts at the predecessor's end (linked projects, `after:`): the
 * branch of the predecessor's top live PR in the same repo, as its own plan would name it. Warns if it has no branch
 * or isn't published yet (GitHub needs the base branch to exist).
 */
async function predecessorTop(project: LoadedProject, r: LoadedRepo): Promise<{ base: string | null; warnings: string[] } | null> {
  if (!project.after) return null;
  const p = await loadProject(project.after.slug);
  const pr = p?.repos.find((x) => x.cfg.path === r.cfg.path) ?? p?.repos.find((x) => x.cfg.name === r.cfg.name);
  const top = pr?.info.commits.filter((c) => !c.landed).at(-1);
  if (!p || !pr || !top) return null;
  const [loaded, refs] = await Promise.all([loadPrs(pr.prsDir, liveCommits(pr.cfg, pr.info), inspectOrphan(pr.cfg, pr.info)).catch(() => new Map<string, LoadedPr>()), loadRefs(pr.info.path)]);
  const l = loaded.get(top.sha);
  const branch = reconcileBranch(refs, top.sha, l?.override, pr.cfg.branch ?? pr.info.end ?? null);
  const n = pr.info.commits.indexOf(top) + 1;
  const warnings: string[] = [];
  if (!branch) warnings.push(`no base: the top PR of ${p.cfg.slug} here (PR #${n}, ${top.short}) has no branch yet`);
  else if (!l?.override.github) warnings.push(`based on ${p.cfg.slug}'s top PR here (PR #${n}, branch '${branch.name}'), which isn't published yet: publish ${p.cfg.slug} first`);
  return { base: branch?.name ?? null, warnings };
}

/**
 * "Landed upstream but not frozen": a prs file with a `github:` record and no `landed:`, whose commit is now an
 * ancestor of the repo's base (it merged with its sha intact, and the range moved past it). The agent should have
 * frozen it before fetching (AGENT-GUIDE.md "After merges"); Local Review only warns.
 */
async function unfrozen(r: LoadedRepo): Promise<string[]> {
  let files: string[];
  try {
    files = fs.readdirSync(r.prsDir).filter((f) => /^[0-9a-f]{40}\.yaml$/.test(f));
  } catch {
    return [];
  }
  const live = new Set(r.info.commits.map((c) => c.sha));
  const base = files.length ? await baseSha(r.cfg) : null;
  if (!base) return [];
  const out: string[] = [];
  for (const f of files.sort()) {
    const sha = f.slice(0, 40);
    if (live.has(sha)) continue;
    let l;
    try {
      l = readPrFile(prPath(r.prsDir, sha));
    } catch {
      continue;
    }
    const gh = l.override.github;
    if (!gh || l.override.landed) continue;
    if (await isAncestor(r.cfg.path, sha, base))
      out.push(`prs file ${sha.slice(0, 8)} (GitHub PR #${gh.number}) has landed upstream (its commit is in ${r.info.base ?? 'the base'}) but isn't frozen: write its \`landed:\` record and add it to the repo's \`landed:\` list (AGENT-GUIDE.md "After merges")`);
  }
  return out;
}

const stackLabel = (p: PlanPr) => (p.stack.number === null ? p.stack.title : `stack ${p.stack.number} "${p.stack.title}"${p.stack.follow_on ? ' (follow-on)' : ''}`);

/** A code fence that can't be closed by anything inside `s`. */
function fence(s: string) {
  const longest = Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

export function planMarkdown(plan: Plan): string {
  const o: string[] = [];
  const scope = [plan.scope.repo && `repo ${plan.scope.repo}`, plan.scope.stack !== null && `stack ${plan.scope.stack}`, plan.scope.include_follow_on && 'including follow-on stacks'].filter(Boolean).join(', ');
  o.push(`# Plan: ${plan.title} (${plan.project})${scope ? ` · ${scope}` : ''}`, '');
  o.push('Read-only: nothing has been pushed or created. Bodies are the exact full PR bodies.', '');
  for (const n of plan.notes) o.push(`Note: ${n}.`, '');
  if (plan.warnings.length) {
    o.push('## Warnings', '');
    for (const w of plan.warnings) o.push(`- ${w}`);
    o.push('');
  }
  let group = '';
  for (const p of plan.prs) {
    const g = `${p.repo}\0${p.stack.number}\0${p.stack.title}`;
    if (g !== group) {
      group = g;
      o.push(`## ${p.repo} · ${p.stack.number === null ? p.stack.title : `Stack ${p.stack.number}: ${p.stack.title}`}${p.stack.follow_on ? ' (follow-on)' : ''}`, '');
    }
    const br = p.branch ? `\`${p.branch.name}\` (${p.branch.status}${p.branch.status === 'moved' ? `: points at ${p.branch.points_at?.slice(0, 8)}` : ''})` : '(none — agent must choose)';
    o.push(`### PR #${p.number} (${p.stack.position} of ${p.stack.count}): ${p.title}`, '');
    o.push(`- Commit: \`${p.short}\` ${p.subject}`);
    o.push(`- Branch: ${br}`);
    if (p.branch && p.branch.discovered.filter((d) => d !== p.branch!.name).length) o.push(`- Also pointing here: ${p.branch.discovered.filter((d) => d !== p.branch!.name).map((d) => `\`${d}\``).join(', ')}`);
    o.push(`- Base: ${p.base ? `\`${p.base}\`` : p.base_from === 'previous-pr' ? `(none: PR #${p.number - 1} has no branch yet)` : '(none)'}${p.base_from === 'repo-base' ? ' (repo base)' : p.base_from === 'predecessor' ? ' (the top PR of the project this builds on)' : ''}`);
    o.push(`- Status: ${p.status}`);
    o.push(`- Title: ${p.title}${p.title_source === 'override' ? ' (edited)' : ''}`);
    o.push(`- GitHub: ${p.github ? `#${p.github.number}${p.github.url ? ` ${p.github.url}` : ''}${p.github.branch ? ` (branch ${p.github.branch}${p.github.base ? ` → ${p.github.base}` : ''})` : ''}` : 'not created'}`);
    if (p.images.length) o.push(`- Images: ${p.images.map((a) => `\`assets/${a.name}\` ${a.url ? `→ ${a.url}` : a.file ? '(no published URL)' : '(missing)'}`).join(', ')}`);
    for (const w of p.warnings) o.push(`- **Warning:** ${w}`);
    o.push('', 'Body:', '');
    const f = fence(p.body);
    o.push(`${f}markdown`, p.body, f, '');
    if (p.publish_threads.length) {
      const left = p.publish_threads.filter((t) => !t.published).length;
      o.push(`Comments for the GitHub PR (${left} to post${left < p.publish_threads.length ? `, ${p.publish_threads.length - left} posted` : ''}):`, '');
      for (const t of p.publish_threads) {
        const where = !t.path ? 'general (the review body)' : !t.line ? `\`${t.path}\` (the whole file)` : `\`${t.path}\` ${t.start_line ? `lines ${t.start_side !== t.side ? `${t.start_side} ` : ''}${t.start_line} to ${t.line}` : `line ${t.line}`} (${t.side === 'left' ? 'LEFT, the old file' : 'RIGHT'})`;
        o.push(`- Thread \`${t.id}\`, ${where}${t.outdated ? ' **(outdated: not in the diff any more)**' : ''}${t.published ? `: posted ${t.published.url}` : ''}`);
        for (const c of t.comments) {
          const text = c.body.replace(/\n+$/, '');
          const cf = fence(text);
          o.push('', `  ${c.author}${c.created ? `, ${c.created}` : ''}:`, '', `  ${cf}markdown`, ...text.split('\n').map((x) => (x ? `  ${x}` : '')), `  ${cf}`);
        }
        o.push('');
      }
    }
  }
  if (!plan.prs.length) o.push('(no PRs in scope)', '');
  return o.join('\n');
}

export function planYaml(plan: Plan): string {
  const d = new YAML.Document(plan);
  YAML.visit(d, {
    Scalar(_, node) {
      if (typeof node.value === 'string' && node.value.includes('\n')) node.type = 'BLOCK_LITERAL';
    },
  });
  return d.toString({ lineWidth: 0 });
}
