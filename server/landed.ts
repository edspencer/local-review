// Landed PRs: PRs that merged on GitHub, frozen by the agent before it fetched or rebased. Each one is a prs file
// with a `landed:` block (head, base, merge commit, method, time), and project.yaml lists their keys per repo, bottom
// to top (`landed: [<sha or prefix>, …]`). They come first in the repo's PR list, keep their numbers and stacks, and
// show GitHub's diff of the PR: merge-base(base, head)...head. Local Review only reads them; it never calls GitHub.
import fs from 'node:fs';
import { landedSummary, type CommitSummary } from './commits.js';
import { readPrFile } from './prs.js';
import { reviewPath, str } from './reviews.js';

const SHA_FILE = /^([0-9a-f]{40})\.yaml$/;

export interface LoadedLanded {
  commits: CommitSummary[]; // in list order, each with `landed` set
  titles: Map<string, string>; // key sha -> PR title override, for stack selectors
  warnings: string[];
}

/** A `landed:` list entry as written: a sha or sha prefix (quote it in YAML). */
export function landedKey(v: unknown): string | null {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v.trim().toLowerCase() : null;
  return s && /^[0-9a-f]{4,40}$/.test(s) ? s : null;
}

export async function loadLanded(repoPath: string, prsDir: string, keys: unknown[]): Promise<LoadedLanded> {
  const out: LoadedLanded = { commits: [], titles: new Map(), warnings: [] };
  if (!keys.length) return out;
  let files: string[] = [];
  try {
    files = fs.readdirSync(prsDir).flatMap((f) => SHA_FILE.exec(f)?.[1] ?? []);
  } catch {
    /* no prs dir yet */
  }
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = landedKey(raw);
    if (!key) {
      out.warnings.push(`landed: ${JSON.stringify(raw)} is not a sha or sha prefix${typeof raw === 'number' ? ' (quote sha prefixes in YAML)' : ''}; skipped`);
      continue;
    }
    const matches = files.filter((f) => f.startsWith(key));
    if (matches.length !== 1) {
      out.warnings.push(matches.length ? `landed: "${key}" matches ${matches.length} prs files; use a longer prefix` : `landed: "${key}" has no prs file (prs/<repo>/${key}….yaml); skipped`);
      continue;
    }
    const sha = matches[0];
    if (seen.has(sha)) {
      out.warnings.push(`landed: "${key}" is listed twice; the later one is ignored`);
      continue;
    }
    seen.add(sha);
    const l = readPrFile(reviewPath(prsDir, sha));
    if (l.parseError) {
      out.warnings.push(`landed: prs file ${sha.slice(0, 8)} doesn't parse (${l.parseError}); skipped`);
      continue;
    }
    const landed = l.override.landed;
    if (!landed) {
      out.warnings.push(`landed: prs file ${sha.slice(0, 8)} has no usable \`landed:\` block (head or commit, as full shas); skipped`);
      continue;
    }
    try {
      const subject = str(l.doc?.subject)?.replace(/\s+/g, ' ').trim();
      const c = await landedSummary(repoPath, sha, landed, { subject, title: l.override.title });
      const label = `landed PR ${sha.slice(0, 8)}${l.override.github ? ` (#${l.override.github.number})` : ''}`;
      if (c.landed?.diff === 'none') out.warnings.push(`${label}: neither its head and base nor its merge commit is in the repo, so it has no diff (fetch them, or check the shas)`);
      else if (c.landed?.diff === 'merge-commit' && landed.method === 'rebase') out.warnings.push(`${label}: its head isn't in the repo, so only the last rebased commit is shown`);
      out.commits.push(c);
      if (l.override.title) out.titles.set(sha, l.override.title);
    } catch (e) {
      out.warnings.push(`landed PR ${sha.slice(0, 8)}: ${(e as Error).message}`);
    }
  }
  return out;
}
