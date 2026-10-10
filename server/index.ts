import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { PORT, PROJECTS_DIR, ROOT, SAFE_NAME } from './config.js';
import { detailOf, filesOf, type CommitSummary } from './commits.js';
import { prStatus, progressOf, storedStatus } from '../shared/readiness.js';
import { ReviewConflictError, loadReview, mutateReview, randomId, reviewPath, unresolvedCount, viewReview, type Review, type ReviewContext, type Thread } from './reviews.js';
import { branchName, githubOf, loadPr, loadPrs, prPath, prView, writePr, type GithubPr, type LoadedPr } from './prs.js';
import { loadRefs, reconcileBranch, type RefIndex } from './branches.js';
import { contextFor, inspectOrphan, liveCommits, prContextFor } from './context.js';
import { emit, startWatchers, subscribe } from './events.js';
import { isArchived, listProjectSlugs, loadProject, projectModified, type LoadedProject, type LoadedRepo } from './projects.js';
import { localOnly } from './security.js';
import { EditNotFoundError, editProjectYaml, setProjectDescription, setStackDescription } from './projectEdit.js';
import { aggregate, mergeAggregates } from '../shared/totals.js';
import { REVIEWER } from './reviewer.js';
import { renderStackSvg, scopeModel, stackWeights, svgToPng, vizModel, type VizScale, type VizScope } from './stackviz.js';

const app = new Hono();

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

app.use('*', localOnly);

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : err instanceof ReviewConflictError ? 409 : err instanceof EditNotFoundError ? 404 : 500;
  if (status === 500) console.error(err);
  return c.json({ error: err.message }, status as any);
});

const relFile = (f: string) => (path.relative(ROOT, f).startsWith('..') ? f : path.relative(ROOT, f));

async function getProject(slug: string): Promise<LoadedProject> {
  // only names that are plain directory names under projects/ (no traversal), and that exist
  const p = SAFE_NAME.test(slug) ? await loadProject(slug) : null;
  if (!p) throw new HttpError(404, `no project '${slug}' in ${relFile(PROJECTS_DIR)}`);
  return p;
}

function findRepo(p: LoadedProject, name: string): LoadedRepo {
  const r = p.repos.find((x) => x.cfg.name === name);
  if (!r) throw new HttpError(404, `no repo '${name}' in project '${p.cfg.slug}'`);
  return r;
}

interface Resolved {
  project: LoadedProject;
  repo: LoadedRepo;
  commit: CommitSummary;
  index: number;
}

async function resolveCommit(c: Context): Promise<Resolved> {
  const project = await getProject(c.req.param('project')!);
  const repo = findRepo(project, c.req.param('repo')!);
  if (repo.info.error) throw new HttpError(404, repo.info.error);
  const shaParam = c.req.param('sha')!;
  const p = shaParam.toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(p)) throw new HttpError(400, 'bad sha');
  const matches = repo.info.commits.filter((x) => x.sha.startsWith(p));
  if (matches.length === 0) throw new HttpError(404, `commit ${shaParam} is not in ${repo.info.end} (it may have been rebased away)`);
  if (matches.length > 1) throw new HttpError(400, `ambiguous sha ${shaParam}`);
  const commit = matches[0];
  return { project, repo, commit, index: repo.info.commits.indexOf(commit) };
}

const reviewCtx = ({ repo, commit }: Resolved) => contextFor(repo.reviewsDir, repo.cfg, repo.info, commit);
const prCtx = ({ repo, commit }: Resolved) => prContextFor(repo.prsDir, repo.cfg, repo.info, commit);

async function reviewPayload(ctx: ReviewContext) {
  const l = await viewReview(ctx);
  const target = reviewPath(ctx.dir, ctx.sha);
  const prev = l.review.previous_commits;
  return {
    ...l.review,
    file: relFile(l.file ?? target), // the file the comments are in right now
    target_file: relFile(target), // where they'll be saved (differs only while carried over)
    matched_from: l.matchedFrom ?? null,
    matched_by: l.matchedBy ?? null,
    // set when this review came from an earlier commit (pending or already saved under this sha)
    carried_over: l.matchedFrom
      ? { from: l.matchedFrom, by: l.matchedBy ?? null, saved: false }
      : prev?.length
        ? { from: prev[prev.length - 1], by: l.review.matched_by ?? null, saved: true }
        : null,
    parse_error: l.parseError ?? null,
  };
}

/** The range's own tip branch name (e.g. me/my-feature): discovered on the top commit, but ranked last. */
const tipOf = (r: LoadedRepo) => r.cfg.branch ?? r.info.end ?? null;

/**
 * `branch` (reconciled with git), `github` (as recorded) and `status` (draft / ready, or published once `github`
 * exists) for one commit: the API contract for all three.
 */
function branchFields(r: LoadedRepo, refs: RefIndex, sha: string, l: LoadedPr | undefined) {
  return { branch: reconcileBranch(refs, sha, l?.override, tipOf(r)), github: l?.override.github ?? null, status: prStatus(l?.override) };
}

async function prPayload(r: Resolved, body: string) {
  const ctx = prCtx(r);
  const l = await loadPr(ctx);
  return {
    ...prView(l, { subject: r.commit.subject, body }),
    ...branchFields(r.repo, await loadRefs(r.repo.cfg.path), r.commit.sha, l),
    file: relFile(l.file ?? prPath(ctx.dir, ctx.sha)),
    target_file: relFile(prPath(ctx.dir, ctx.sha)),
    matched_from: l.matchedFrom ?? null,
    matched_by: l.matchedBy ?? null,
    parse_error: l.parseError ?? null,
  };
}

// ---------------- projects ----------------
async function repoPayload(r: LoadedRepo, withWeights = false) {
  const [prs, refs] = await Promise.all([
    loadPrs(r.prsDir, liveCommits(r.cfg, r.info), inspectOrphan(r.cfg, r.info)).catch(() => new Map<string, LoadedPr>()),
    loadRefs(r.info.path), // once per range, not per commit
  ]);
  const commits = await Promise.all(
    r.info.commits.map(async (cm, i) => {
      const [l, files] = await Promise.all([
        loadReview(contextFor(r.reviewsDir, r.cfg, r.info, cm)).catch(() => null),
        filesOf(r.info.path, cm).catch(() => []), // cached per sha (a landed PR: its own diff)
      ]);
      const pr = prs.get(cm.sha);
      return {
        ...cm,
        position: i + 1,
        stack: r.stackOf.get(cm.sha) ?? 0,
        title: pr?.override.title ?? cm.subject,
        title_source: pr?.override.title !== undefined ? 'override' : 'commit',
        ...branchFields(r, refs, cm.sha, pr),
        unresolved: l ? unresolvedCount(l.review) : 0,
        threads: l ? l.review.threads.length : 0,
        viewedCount: l ? l.review.viewed.length : 0,
        progress: progressOf(l?.review.threads ?? [], files.map((f) => f.path), l?.review.viewed ?? []),
      };
    }),
  );
  const { info } = r;
  const weights = withWeights ? await stackWeights(r).catch(() => null) : null;
  return {
    name: r.cfg.name,
    path: info.path,
    branch: info.branch,
    end: info.end,
    base: info.base,
    from: info.from,
    head: info.head,
    mergeBase: info.mergeBase,
    error: info.error ?? null,
    warnings: r.warnings,
    stacks: weights ? r.stacks.map((g, i) => ({ ...g, weight: weights[i] })) : r.stacks,
    reviewsDir: relFile(r.reviewsDir),
    prsDir: relFile(r.prsDir),
    commits,
  };
}

app.get('/api/projects', async (c) => {
  const projects = await Promise.all(
    listProjectSlugs().map(async (slug) => {
      const p = await loadProject(slug);
      if (!p) return null;
      const repos = await Promise.all(p.repos.map((r) => repoPayload(r)));
      // follow-on stacks (parked work) and merged PRs are left out of the commit count and given beside it, as in every aggregate
      const t = mergeAggregates(
        repos.map((r) => {
          const merged = new Set(r.commits.filter((cm) => cm.landed).map((cm) => cm.sha));
          return aggregate(r.stacks.map((g) => ({ follow_on: g.follow_on, prs: g.shas.length, additions: 0, deletions: 0, merged: { prs: g.shas.filter((s) => merged.has(s)).length, additions: 0, deletions: 0 } })));
        }),
      );
      const archived = isArchived(p); // everything has landed
      return {
        slug,
        title: p.cfg.title,
        description: p.cfg.description,
        error: p.cfg.error ?? null,
        repoCount: repos.length,
        repos: repos.map((r) => r.name),
        commitCount: t.prs,
        followOnCount: t.followOn.prs,
        mergedCount: t.merged.prs,
        archived,
        unresolved: repos.reduce((a, r) => a + r.commits.reduce((b, cm) => b + cm.unresolved, 0), 0),
        modified: new Date(projectModified(p.cfg.dir) || 0).toISOString(),
      };
    }),
  );
  return c.json({ projectsDir: relFile(PROJECTS_DIR), projects: projects.filter(Boolean) });
});

app.get('/api/projects/:project', async (c) => {
  const p = await getProject(c.req.param('project'));
  return c.json({
    slug: p.cfg.slug,
    title: p.cfg.title,
    description: p.cfg.description,
    file: relFile(p.cfg.file),
    error: p.cfg.error ?? null,
    repos: await Promise.all(p.repos.map((r) => repoPayload(r, true))),
  });
});

// ---------------- project intro / stack notes (written into project.yaml, keeping the rest of it) ----------------
function descriptionField(b: any): string | null {
  if (!b || typeof b !== 'object' || Array.isArray(b) || !('description' in b)) throw new HttpError(400, 'expected {description: string | null}');
  const v = b.description;
  if (v !== null && typeof v !== 'string') throw new HttpError(400, 'description must be a string or null');
  if (v && v.length > 256 * 1024) throw new HttpError(400, 'description is too long');
  return v;
}

app.put('/api/projects/:project/description', async (c) => {
  const description = descriptionField(await body(c));
  const p = await getProject(c.req.param('project'));
  const cfg = await editProjectYaml(p.cfg.slug, (doc) => setProjectDescription(doc, description));
  emit({ type: 'project', project: p.cfg.slug, reason: 'config' });
  return c.json({ description: cfg.description, file: relFile(cfg.file) });
});

app.put('/api/projects/:project/repos/:repo/stacks/:number/description', async (c) => {
  const b = await body(c);
  const description = descriptionField(b);
  if (b.title !== undefined && typeof b.title !== 'string') throw new HttpError(400, 'title must be a string');
  const n = c.req.param('number');
  if (!/^[1-9][0-9]{0,3}$/.test(n)) throw new HttpError(400, 'bad stack number');
  const p = await getProject(c.req.param('project'));
  const repo = findRepo(p, c.req.param('repo')).cfg.name;
  const cfg = await editProjectYaml(p.cfg.slug, (doc, cur) => setStackDescription(doc, cur, repo, Number(n), description, b.title));
  emit({ type: 'project', project: p.cfg.slug, reason: 'config' });
  const spec = cfg.repos.find((r) => r.name === repo)?.stacks[Number(n) - 1];
  return c.json({ description: spec?.description ?? null, title: spec?.title ?? null, file: relFile(cfg.file) });
});

const COMMIT = '/api/projects/:project/repos/:repo/commits/:sha';

app.get(COMMIT, async (c) => {
  const r = await resolveCommit(c);
  const { project, repo, commit, index } = r;
  const detail = await detailOf(repo.cfg.path, commit);
  // prev / next walk the whole project in sidebar order: repo by repo, commits oldest first
  const flat = project.repos.flatMap((x) => x.info.commits.map((cm) => ({ repo: x.cfg.name, sha: cm.sha })));
  const at = flat.findIndex((x) => x.repo === repo.cfg.name && x.sha === commit.sha);
  const group = repo.stacks[repo.stackOf.get(commit.sha) ?? 0];
  const pr = await prPayload(r, detail.body);
  return c.json({
    project: project.cfg.slug,
    projectTitle: project.cfg.title,
    repo: repo.cfg.name,
    repoPath: repo.cfg.path,
    branch: repo.info.end,
    index,
    total: repo.info.commits.length,
    stack: group ? { ...group, position: group.shas.indexOf(commit.sha) + 1, count: group.shas.length } : null,
    prev: flat[at - 1] ?? null,
    next: flat[at + 1] ?? null,
    commit: { ...detail, branch: pr.branch, github: pr.github, status: pr.status, landed: commit.landed ?? null },
    pr,
    review: await reviewPayload(reviewCtx(r)),
  });
});

app.get(`${COMMIT}/review`, async (c) => c.json(await reviewPayload(reviewCtx(await resolveCommit(c)))));

app.get(`${COMMIT}/pr`, async (c) => {
  const r = await resolveCommit(c);
  return c.json(await prPayload(r, (await detailOf(r.repo.cfg.path, r.commit)).body));
});

// ---------------- stack visualization (SVG / PNG) ----------------
function vizOpts(c: Context) {
  const s = c.req.query('scope');
  const scope: VizScope = s === 'repo' || s === 'stack' ? s : 'project';
  const scale: VizScale = c.req.query('scale') === 'linear' ? 'linear' : 'sqrt';
  const t = c.req.query('title');
  const title = !(t === '0' || t === 'false' || t === 'no');
  return { scope, scale, title };
}

function sendViz(c: Context, svg: string, kind: 'svg' | 'png', name: string) {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (c.req.query('download') !== undefined) headers['Content-Disposition'] = `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '-')}.${kind}"`;
  if (kind === 'svg') {
    // the SVG is all escaped text and shapes; still, never let it run anything if opened directly
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
    return c.body(svg, 200, { ...headers, 'Content-Type': 'image/svg+xml; charset=utf-8' });
  }
  return c.body(new Uint8Array(svgToPng(svg)), 200, { ...headers, 'Content-Type': 'image/png' });
}

for (const kind of ['svg', 'png'] as const) {
  app.get(`${COMMIT}/stack.${kind}`, async (c) => {
    const { project, repo, commit, index } = await resolveCommit(c);
    const { scope, scale, title } = vizOpts(c);
    const model = scopeModel(await vizModel(project, { repo: repo.cfg.name, sha: commit.sha }), scope);
    return sendViz(c, renderStackSvg(model, { scale, title }), kind, `${project.cfg.slug}-${repo.cfg.name}-pr${index + 1}-stack`);
  });
  // the whole project, nothing highlighted (the project homepage)
  app.get(`/api/projects/:project/stack.${kind}`, async (c) => {
    const project = await getProject(c.req.param('project'));
    return sendViz(c, renderStackSvg(await vizModel(project, null), vizOpts(c)), kind, `${project.cfg.slug}-stacks`);
  });
}

// ---------------- comments ----------------
async function body(c: Context): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'expected a JSON body');
  }
}

function text(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  return v.replace(/\r\n/g, '\n').trimEnd();
}

function author(v: unknown): string {
  if (v === undefined) return REVIEWER.id;
  if (typeof v !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(v)) throw new HttpError(400, 'bad author');
  return v.toLowerCase();
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

async function mutate(c: Context, fn: (r: Review) => void) {
  const r = await resolveCommit(c);
  const ctx = reviewCtx(r);
  await mutateReview(ctx, fn);
  emit({ type: 'review', project: r.project.cfg.slug, repo: r.repo.cfg.name, sha: r.commit.sha });
  return c.json(await reviewPayload(ctx));
}

function findThread(r: { threads: Thread[] }, id: string) {
  const t = r.threads.find((x) => x.id === id);
  if (!t) throw new HttpError(404, `no thread ${id}`);
  return t;
}

app.post(`${COMMIT}/threads`, async (c) => {
  const b = await body(c);
  const commentBody = text(b.body, 'body');
  const who = author(b.author);
  return mutate(c, (r) => {
    const t: Thread = { id: randomId('t'), resolved: false, comments: [] };
    if (b.path !== undefined && b.path !== null) {
      if (typeof b.path !== 'string' || !b.path) throw new HttpError(400, 'bad path');
      t.path = b.path;
      if (b.line !== undefined && b.line !== null) {
        const line = Number(b.line);
        if (!Number.isInteger(line) || line < 1) throw new HttpError(400, 'bad line');
        t.side = b.side === 'left' ? 'left' : 'right';
        t.line = line;
        const sl = Number(b.start_line);
        if (b.start_side != null && b.start_side !== 'left' && b.start_side !== 'right') throw new HttpError(400, 'bad start_side');
        const startSide = b.start_side ?? t.side;
        if (b.start_line != null && Number.isInteger(sl) && sl >= 1) {
          if (startSide !== t.side) {
            t.start_line = sl; // a range from an old-file line to a new-file line (or the reverse)
            t.start_side = startSide;
          } else if (sl < line) t.start_line = sl;
        }
      }
    }
    t.comments.push({ id: randomId('c'), author: who, created: now(), body: commentBody });
    r.threads.push(t);
  });
});

app.post(`${COMMIT}/threads/:tid/comments`, async (c) => {
  const b = await body(c);
  const commentBody = text(b.body, 'body');
  const who = author(b.author);
  return mutate(c, (r) => {
    const t = findThread(r, c.req.param('tid'));
    t.comments.push({ id: randomId('c'), author: who, created: now(), body: commentBody });
  });
});

app.patch(`${COMMIT}/threads/:tid`, async (c) => {
  const b = await body(c);
  return mutate(c, (r) => {
    const t = findThread(r, c.req.param('tid'));
    if (typeof b.resolved === 'boolean') t.resolved = b.resolved;
  });
});

app.patch(`${COMMIT}/threads/:tid/comments/:cid`, async (c) => {
  const b = await body(c);
  const commentBody = text(b.body, 'body');
  return mutate(c, (r) => {
    const t = findThread(r, c.req.param('tid'));
    const cm = t.comments.find((x) => x.id === c.req.param('cid'));
    if (!cm) throw new HttpError(404, 'no such comment');
    if (cm.author !== REVIEWER.id) throw new HttpError(403, `only ${REVIEWER.id}'s own comments can be edited here (this one is by ${cm.author})`);
    cm.body = commentBody;
    cm.edited = now();
  });
});

app.delete(`${COMMIT}/threads/:tid/comments/:cid`, async (c) =>
  mutate(c, (r) => {
    const t = findThread(r, c.req.param('tid'));
    const i = t.comments.findIndex((x) => x.id === c.req.param('cid'));
    if (i < 0) throw new HttpError(404, 'no such comment');
    // never delete an agent's (or anyone else's) words from the UI: only the reviewer's own comments
    if (t.comments[i].author !== REVIEWER.id) throw new HttpError(403, `only ${REVIEWER.id}'s own comments can be deleted here (this one is by ${t.comments[i].author})`);
    t.comments.splice(i, 1);
    if (t.comments.length === 0) r.threads = r.threads.filter((x) => x !== t);
  }),
);

app.put(`${COMMIT}/viewed`, async (c) => {
  const b = await body(c);
  if (typeof b.path !== 'string' || !b.path) throw new HttpError(400, 'path is required');
  return mutate(c, (r) => {
    const set = new Set(r.viewed);
    if (b.viewed === false) set.delete(b.path);
    else set.add(b.path);
    r.viewed = [...set];
  });
});

// ---------------- PR title / description overrides ----------------
function prField(v: unknown, field: string, max: number): string | null | undefined {
  if (v === undefined || v === null) return v as undefined | null;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string or null`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v;
}

// A branch name an agent may record: what `git check-ref-format --branch` would accept, give or take (we never
// pass it to git; it's only compared with for-each-ref's output).
function branchField(v: unknown, field: string): string | null | undefined {
  if (v === undefined || v === null) return v as undefined | null;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string or null`);
  const n = branchName(v);
  if (!n) return null; // blank clears
  if (n.length > 250 || !/^[A-Za-z0-9._\/+@-]+$/.test(n) || n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.') || n.endsWith('.lock') || n.includes('..') || n.includes('//') || n.includes('@{') || n === '@')
    throw new HttpError(400, `${field}: not a valid branch name: ${JSON.stringify(v)}`);
  return n;
}

function githubField(v: unknown): GithubPr | null | undefined {
  if (v === undefined || v === null) return v as undefined | null;
  const gh = githubOf(v);
  if (!gh) throw new HttpError(400, 'github must be null or {number, url, branch?, base?} (number: a positive integer, or derivable from a .../pull/<n> url)');
  if (gh.url && (!/^https?:\/\//.test(gh.url) || gh.url.length > 2000)) throw new HttpError(400, 'github.url must be an http(s) URL');
  const o = v as Record<string, unknown>;
  if (typeof o === 'object') {
    gh.branch = branchField(o.branch, 'github.branch') ?? undefined;
    gh.base = branchField(o.base, 'github.base') ?? undefined;
    gh.stacked_on = branchField(o.stacked_on, 'github.stacked_on') ?? undefined;
  }
  return gh;
}

app.put(`${COMMIT}/pr`, async (c) => {
  const b = await body(c);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'expected {title?, body?, branch?, github?, status?}');
  const title = prField(b.title, 'title', 1000);
  const prBody = prField(b.body, 'body', 1024 * 1024);
  const branch = branchField(b.branch, 'branch');
  const github = githubField(b.github);
  const status = b.status === undefined || b.status === null ? b.status : storedStatus(b.status);
  if (status === undefined && b.status !== undefined) throw new HttpError(400, "status must be 'draft', 'ready' or null");
  const r = await resolveCommit(c);
  await writePr(prCtx(r), { title, body: prBody, branch, github, status });
  emit({ type: 'pr', project: r.project.cfg.slug, repo: r.repo.cfg.name, sha: r.commit.sha });
  return c.json(await prPayload(r, (await detailOf(r.repo.cfg.path, r.commit)).body));
});

// ---------------- events ----------------
app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    let id = 0;
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = subscribe((e) => {
      queue.push(JSON.stringify(e));
      wake?.();
    });
    stream.onAbort(() => {
      unsub();
      wake?.();
    });
    await stream.writeSSE({ event: 'hello', data: JSON.stringify({ t: Date.now() }) });
    while (!stream.aborted) {
      while (queue.length) await stream.writeSSE({ event: 'change', data: queue.shift()!, id: String(++id) });
      await new Promise<void>((res) => {
        wake = res;
        setTimeout(res, 25000); // heartbeat
      });
      wake = null;
      if (!queue.length && !stream.aborted) await stream.write(': ping\n\n');
    }
    unsub();
  }),
);

app.get('/api/health', (c) => c.json({ ok: true }));
app.get('/api/me', (c) => c.json(REVIEWER));
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// ---------------- frontend ----------------
const DIST = path.join(ROOT, 'dist');
if (!process.env.LOCAL_REVIEW_DEV) {
  app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), DIST) || '.' }));
  app.get('*', (c) => {
    const index = path.join(DIST, 'index.html');
    if (!fs.existsSync(index)) return c.text('Frontend not built. Run `npm run build` (or `npm start`).', 500);
    return c.html(fs.readFileSync(index, 'utf8'));
  });
}

startWatchers();
serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (i) => {
  console.log(`Local Review on http://localhost:${i.port}  (projects: ${PROJECTS_DIR})`);
});
