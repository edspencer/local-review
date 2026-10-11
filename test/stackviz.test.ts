// Stack visualization: the aggregation maths, the bar scale, text truncation without a DOM, the SVG (well
// formed, titles, totals, the highlighted PR), and the SVG / PNG endpoints.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Repo, tmpDir } from './fixture.ts';

const PROJECTS = tmpDir('lr-test-stackviz-');
process.env.LOCAL_REVIEW_PROJECTS_DIR = PROJECTS;
const V = await import('../server/stackviz.ts');
type VizPr = import('../server/stackviz.ts').VizPr;
type VizModel = import('../server/stackviz.ts').VizModel;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repos: Repo[] = [];
after(() => {
  for (const r of repos) r.rm();
  fs.rmSync(PROJECTS, { recursive: true, force: true });
});

const pr = (position: number, additions: number, deletions: number, paths?: string[], title = `PR number ${position}`): VizPr => ({
  position,
  sha: String(position).repeat(40).slice(0, 40),
  short: String(position).repeat(8).slice(0, 8),
  title,
  additions,
  deletions,
  filesChanged: paths?.length ?? 2,
  ...(paths ? { paths } : {}),
});

/** Every tag closed in order, nothing left open: enough to catch broken markup or unescaped text. */
function assertWellFormed(svg: string) {
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  const stack: string[] = [];
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)([^<>]*?)(\/?)>|[<>]/g)) {
    assert.ok(m[2], `stray "${m[0]}" in the SVG`);
    if (m[4]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `</${m[2]}> closes the wrong tag`);
    else stack.push(m[2]);
  }
  assert.deepEqual(stack, []);
  // text content never contains a raw & that isn't an entity
  assert.doesNotMatch(svg, /&(?![a-z]+;|#\d+;)/);
}

describe('aggregation', () => {
  test('stack totals sum additions / deletions / PRs and count distinct files', () => {
    const t = V.stackTotals([pr(1, 10, 2, ['a', 'b']), pr(2, 5, 0, ['b', 'c']), pr(3, 0, 7, ['d'])]);
    assert.deepEqual(t, { additions: 15, deletions: 9, prs: 3, files: 4 });
    // without paths: the sum of per-PR counts
    assert.deepEqual(V.stackTotals([pr(1, 1, 1), pr(2, 2, 2)]), { additions: 3, deletions: 3, prs: 2, files: 4 });
    assert.deepEqual(V.stackTotals([]), { additions: 0, deletions: 0, prs: 0, files: 0 });
    assert.deepEqual(V.sumTotals([t, { additions: 1, deletions: 1, prs: 1, files: 1 }]), { additions: 16, deletions: 10, prs: 4, files: 5 });
  });

  test('bars: one shared scale, sqrt by default, segments proportional, tiny ones still visible', () => {
    assert.equal(V.barFraction(100, 100), 1);
    assert.equal(V.barFraction(25, 100), 0.5); // sqrt
    assert.equal(V.barFraction(25, 100, 'linear'), 0.25);
    assert.equal(V.barFraction(0, 100), 0);
    assert.equal(V.barFraction(200, 100), 1);
    const s = V.barSegments(75, 25, 100, 100);
    assert.equal(s.add + s.del, 100);
    assert.equal(s.add, 75);
    const tiny = V.barSegments(1000, 1, 1001, 100, 'linear');
    assert.equal(tiny.del, 2);
    assert.deepEqual(V.barSegments(0, 0, 100, 100), { add: 0, del: 0 });
  });

  test('scopes narrow to the current repo or stack', () => {
    const m: VizModel = {
      title: 'P',
      repos: [
        { name: 'a', branch: 'x', stacks: [{ label: 'Stack 1 · One', color: 'blue', prs: [pr(1, 1, 0)] }, { label: 'Stack 2 · Two', color: 'green', prs: [pr(2, 1, 0)] }] },
        { name: 'b', branch: 'y', stacks: [{ label: 'Stack 1 · Other', color: 'red', prs: [pr(1, 1, 0)] }] },
      ],
      current: { repo: 'a', sha: pr(2, 0, 0).sha },
    };
    assert.equal(V.scopeModel(m, 'project'), m);
    assert.deepEqual(V.scopeModel(m, 'repo').repos.map((r) => r.name), ['a']);
    assert.deepEqual(V.scopeModel(m, 'stack').repos.flatMap((r) => r.stacks.map((s) => s.label)), ['Stack 2 · Two']);
  });
});

describe('text without a DOM', () => {
  test('widths come from the bundled fonts; truncation fits and ends in an ellipsis', () => {
    const w = V.textWidth('Hello', 'regular', 13);
    assert.ok(w > 25 && w < 40, String(w));
    assert.ok(V.textWidth('WWWW', 'regular', 13) > V.textWidth('iiii', 'regular', 13));
    assert.ok(Math.abs(V.textWidth('iiii', 'mono', 12) - V.textWidth('WWWW', 'mono', 12)) < 0.01, 'monospace');
    assert.equal(V.truncate('short', 'regular', 13, 200), 'short');
    const long = 'A rather long pull request title that will not fit in the space it is given';
    const t = V.truncate(long, 'regular', 13, 150);
    assert.ok(t.endsWith('…') && t.length < long.length, t);
    assert.ok(V.textWidth(t, 'regular', 13) <= 150);
    assert.ok(!/\s…$/.test(t), 'no space before the ellipsis');
    assert.equal(V.truncate('x'.repeat(50), 'regular', 13, 1), '…');
    // characters outside the font still measure (as a box), never NaN
    assert.ok(Number.isFinite(V.textWidth('漢字🙂', 'regular', 13)));
  });

  test('branch names truncate in the middle, keeping both ends, and fit', () => {
    const b = 'me/feature/02-flag-parser-with-a-long-tail';
    assert.equal(V.truncateMiddle(b, 'mono', 10.5, 1000), b);
    const t = V.truncateMiddle(b, 'mono', 10.5, 160);
    assert.ok(V.textWidth(t, 'mono', 10.5) <= 160, t);
    const [head, tail] = t.split('…');
    assert.ok(head.length > 0 && b.startsWith(head), t);
    assert.ok(tail.length > 0 && b.endsWith(tail), t);
    assert.ok(tail.length <= head.length, 'the start keeps a bit more');
    assert.equal(V.truncateMiddle(b, 'mono', 10.5, 1), '…');
  });
});

describe('SVG', () => {
  const model: VizModel = {
    title: 'Demo <project> & co',
    repos: [
      {
        name: 'service',
        branch: 'me/feature',
        stacks: [
          { label: 'Stack 1 · Groundwork', color: 'blue', prs: [pr(1, 210, 0, ['a']), pr(2, 428, 0, ['a', 'b'], 'The "current" one')] },
          { label: 'Stack 2 · Polish', color: 'purple', prs: [pr(3, 1265, 12, ['c'])] },
        ],
      },
      { name: 'other', branch: 'main', stacks: [{ label: 'Unstacked', color: 'gray', implicit: 'unstacked', prs: [pr(1, 3, 1)] }] },
      { name: 'broken', branch: 'x', stacks: [], error: 'repo not found' },
    ],
    current: { repo: 'service', sha: pr(2, 0, 0).sha },
  };

  test('well formed, with stack titles, totals and escaped text', () => {
    const svg = V.renderStackSvg(model);
    assertWellFormed(svg);
    assert.match(svg, /width="680"/);
    assert.ok(svg.includes('STACK 1 · GROUNDWORK'));
    assert.ok(svg.includes('STACK 2 · POLISH'));
    assert.ok(svg.includes('UNSTACKED'));
    assert.ok(svg.includes('stroke-dasharray'), 'unstacked is dashed');
    assert.ok(svg.includes('Demo &lt;project&gt; &amp; co'));
    assert.ok(svg.includes('The &quot;current&quot; one'));
    // stack 1: +638 −0, 2 PRs, 2 distinct files
    assert.ok(svg.includes('2 PRs · 2 files'));
    assert.ok(svg.includes('+638</tspan>'));
    assert.ok(svg.includes('+1,265</tspan>') && svg.includes('−12</tspan>'));
    assert.ok(svg.includes('repo not found'));
    // header: everything summed
    assert.ok(svg.includes('3 repos · 3 stacks · 4 PRs'));
    assert.ok(svg.includes('+1,906</tspan>'));
  });

  test('highlights the current PR (marker, tint) and its stack; no highlight without one', () => {
    const svg = V.renderStackSvg(model);
    assert.equal(svg.split('◀ this PR').length - 1, 1);
    assert.ok(svg.includes('fill="#f7eff6"'), 'tinted row');
    assert.equal(svg.split('stroke-width="2.5"').length - 1, 1, 'one emphasised stack');
    const plain = V.renderStackSvg({ ...model, current: null });
    assert.ok(!plain.includes('◀ this PR'));
    assert.ok(!plain.includes('stroke-width="2.5"'));
  });

  test('title: false drops the project heading and summary line, and only shortens the image', () => {
    const height = (svg: string) => Number(svg.match(/height="(\d+)"/)![1]);
    const withTitle = V.renderStackSvg(model);
    const without = V.renderStackSvg(model, { title: false });
    assertWellFormed(without);
    assert.ok(withTitle.includes('Demo &lt;project&gt; &amp; co') && withTitle.includes('3 repos · 3 stacks'));
    assert.ok(!without.includes('Demo &lt;project&gt; &amp; co') && !without.includes('3 repos · 3 stacks'));
    assert.ok(without.includes('STACK 1 · GROUNDWORK') && without.includes('◀ this PR'));
    assert.equal(height(withTitle) - height(without), 66);
  });

  test('branches and GitHub PR numbers: a second line per row, the sha only as a fallback', () => {
    const height = (svg: string) => Number(svg.match(/height="(\d+)"/)![1]);
    const plain = V.renderStackSvg(model);
    assert.ok(plain.includes('22222222'), 'without branches: the sha column');
    const withBranches: VizModel = {
      ...model,
      repos: model.repos.map((r, i) =>
        i ? r : { ...r, stacks: r.stacks.map((s, j) => (j ? s : { ...s, prs: [{ ...s.prs[0], branch: 'me/feature/01-<config>-loader', pr: 4321 }, { ...s.prs[1], branch: 'me/gone', branchMissing: true }] })) },
      ),
    };
    const svg = V.renderStackSvg(withBranches);
    assertWellFormed(svg);
    assert.ok(svg.includes('me/feature/01-&lt;config&gt;-loader'), 'escaped branch name');
    assert.ok(svg.includes('>#4321</text>'));
    assert.ok(/text-decoration="line-through"[^>]*>me\/gone</.test(svg), 'a missing branch is struck through');
    assert.ok(svg.includes('>33333333</text>'), 'a PR without a branch shows its sha on the second line');
    // 4 PR rows, 10px taller each
    assert.equal(height(svg) - height(plain), 40);
    assert.equal(svg.split('◀ this PR').length - 1, 1);
  });

  // stack 2 (purple, +1,265 −12, 1 PR) as a follow-on stack
  const fo: VizModel = { ...model, repos: model.repos.map((r, i) => (i ? r : { ...r, stacks: r.stacks.map((s, j) => (j === 1 ? { ...s, follow_on: true } : s)) })) };
  const G = '<g opacity="0.72">';
  /** Whether position `at` of the SVG is inside a faded group (groups nest: the bars clip inside them). */
  const fadedAt = (svg: string, at: number) => {
    const open: boolean[] = [];
    for (const m of svg.slice(0, at).matchAll(/<g( opacity="0\.72")?[\s>]|<\/g>/g)) {
      if (m[0] === '</g>') open.pop();
      else open.push(!!m[1]);
    }
    return open.includes(true);
  };

  test('follow-on stacks: border and rows faded, the label and its yellow "follow-on" tag at full strength; others unchanged', () => {
    const plain = V.renderStackSvg(model);
    assert.ok(!plain.includes('<g opacity=') && !plain.includes('>follow-on<'));
    const svg = V.renderStackSvg(fo);
    assertWellFormed(svg);
    assert.equal(svg.split(G).length - 1, 1, 'one faded group');
    const start = svg.indexOf(G);
    const end = svg.indexOf('</g>\n', svg.lastIndexOf('+1,265</tspan>'));
    const inside = svg.slice(start, end);
    assert.ok(inside.includes('+1,265</tspan>'), 'the rows and weight are in the group');
    assert.ok(!inside.includes('STACK 2 · POLISH') && !inside.includes('>follow-on</text>'), 'the label and tag are not');
    const after = svg.slice(end);
    assert.ok(after.indexOf('STACK 2 · POLISH') < after.indexOf('>follow-on</text>'), 'the tag follows the label');
    assert.ok(!svg.slice(0, start).includes('STACK 2'), 'stack 1 is outside the group');
    assert.equal(Number(svg.match(/height="(\d+)"/)![1]), Number(plain.match(/height="(\d+)"/)![1]), 'same layout');
  });

  test('follow-on stacks are yellow whatever their colour; nothing else is', () => {
    const svg = V.renderStackSvg(fo);
    assert.ok(svg.includes('stroke="#bf8700"'), 'yellow border');
    assert.ok(/fill="#9a6700"[^>]*>STACK 2 · POLISH</.test(svg), 'darker yellow label text');
    assert.ok(!svg.includes(V.STACK_HEX.purple), 'its purple is ignored');
    assert.ok(!V.renderStackSvg(model).includes('#bf8700'));
  });

  test('aggregates leave follow-on stacks out and mention them; the stack itself keeps its numbers', () => {
    const svg = V.renderStackSvg(fo);
    // header: 3 repos, stacks 1 and Unstacked (2 + 1 PRs, +641 −1), plus stack 2 noted
    assert.ok(svg.includes('3 repos · 2 stacks · 3 PRs · '), svg.slice(0, 900));
    assert.ok(svg.includes('+641</tspan>') && !svg.includes('+1,906'));
    assert.ok(svg.includes('>+1 follow-on stack (1 PR)</tspan>'));
    // the first repo heading: stack 1 only, with the note
    assert.ok(svg.includes('>2 PRs</text>') && svg.includes('+638</tspan>'));
    assert.ok(svg.includes('>+1 follow-on stack (1 PR)</text>'));
    // the follow-on stack's own header still shows its real weight
    assert.ok(svg.includes('1 PR · 1 file') && svg.includes('+1,265</tspan>') && svg.includes('−12</tspan>'));
    // only follow-on work in the picture (the stack scope on a follow-on PR): its numbers, labelled, not zeros
    const only = V.renderStackSvg(V.scopeModel({ ...fo, current: { repo: 'service', sha: pr(3, 0, 0).sha } }, 'stack'));
    assertWellFormed(only);
    assert.ok(only.includes('1 repo · 1 follow-on stack · 1 PR · '), only.slice(0, 900));
    assert.ok(only.includes('>1 follow-on PR</text>'));
    assert.ok(!only.includes('0 PRs') && !only.includes('+1 follow-on'));
    // the highlighted PR is drawn at full strength, outside the faded groups
    assert.equal(fadedAt(only, only.indexOf('◀ this PR')), false);
    assert.equal(fadedAt(only, only.indexOf('>PR number 3<')), false);
    assert.equal(fadedAt(only, only.indexOf('1 PR · 1 file')), true, 'the rest of the stack is faded');
  });

  test('renders to a PNG at 2x with the bundled fonts', () => {
    const png = V.svgToPng(V.renderStackSvg(model));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1360);
  });
});

describe('thumbnail (the root page)', () => {
  const model = (repos: { name: string; stacks: { color: string; prs: VizPr[]; follow_on?: boolean }[]; error?: string }[]): VizModel => ({
    title: 'Thumb & co',
    current: null,
    repos: repos.map((r) => ({ name: r.name, branch: '', error: r.error ?? null, stacks: r.stacks.map((s, i) => ({ label: `Stack ${i + 1}`, ...s })) })),
  });
  const prs = (n: number, lines = 100, status?: VizPr['status']) => Array.from({ length: n }, (_, i) => ({ ...pr(i + 1, lines, 0), ...(status ? { status } : {}) }));
  const bars = (svg: string) => [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="([\d.]+)"[^>]*class="t-(?:bar|merged)"/g)].map((m) => ({ x: +m[1], w: +m[2], h: +m[3] }));

  test('well formed, a fixed size, escaped, with its own dark-mode colours', () => {
    const svg = V.renderThumbSvg(model([{ name: 'api<1>', stacks: [{ color: 'blue', prs: prs(3) }] }]));
    assertWellFormed(svg);
    assert.match(svg, /width="280" height="150"/);
    assert.ok(svg.includes('Thumb &amp; co') && svg.includes('api&lt;1&gt;'));
    assert.match(svg, /@media \(prefers-color-scheme: dark\)\{[^]*\.s-blue \.t-bar\{fill:#4493f8\}/);
    assert.match(svg, /\.s-blue \.t-bar\{fill:#0969da\}/);
  });

  test('one bar per PR; one unit across lanes, so a 1-PR repo is visibly short; capped for small projects', () => {
    const svg = V.renderThumbSvg(model([{ name: 'big', stacks: [{ color: 'blue', prs: prs(30) }] }, { name: 'small', stacks: [{ color: 'green', prs: prs(1) }] }]));
    const b = bars(svg);
    assert.equal(b.length, 31);
    assert.ok(new Set(b.map((x) => x.w)).size === 1, 'every bar the same width');
    // the 30-PR lane fills the width (280 less the padding)
    assert.ok(b[29].x + b[29].w > 250);
    const tiny = bars(V.renderThumbSvg(model([{ name: 'one', stacks: [{ color: 'blue', prs: prs(2) }] }])));
    assert.ok(tiny[0].w <= 16, 'a bar is never wider than the cap');
  });

  test('heights: log scale with a floor, so one huge PR does not flatten the rest', () => {
    assert.equal(V.thumbHeight(13000, 13000), 1);
    assert.ok(V.thumbHeight(300, 13000) > 0.55, 'a 300-line PR next to a 13k-line one is still more than half height');
    assert.equal(V.thumbHeight(0, 13000), 0.22);
    assert.ok(V.thumbHeight(100, 1000) < V.thumbHeight(500, 1000));
  });

  test('readiness is the fill: drafts faint and outlined, published solid, merged purple', () => {
    const svg = V.renderThumbSvg(model([{ name: 'r', stacks: [{ color: 'blue', prs: [{ ...pr(1, 10, 0), status: 'draft' }, { ...pr(2, 10, 0), status: 'ready' }, { ...pr(3, 10, 0), status: 'published' }, { ...pr(4, 10, 0), status: 'merged', merged: true }] }] }]));
    assert.match(svg, /class="t-bar" fill-opacity="0.22"/);
    assert.match(svg, /class="t-bar" fill-opacity="0.6"/);
    assert.match(svg, /class="t-bar" fill-opacity="1"/);
    assert.equal((svg.match(/class="t-merged"/g) ?? []).length, 1);
    assert.equal((svg.match(/class="t-outline"/g) ?? []).length, 1);
  });

  test('follow-on stacks are hatched yellow; a "#hex" colour is kept; many repos end in "+N more repos"; errors say so', () => {
    const fo = V.renderThumbSvg(model([{ name: 'r', stacks: [{ color: 'blue', prs: prs(2) }, { color: 'teal', follow_on: true, prs: prs(1) }] }]));
    assert.ok(fo.includes('<pattern') && fo.includes('class="s-yellow"') && fo.includes('stroke-dasharray="3 2"'));
    const hex = V.renderThumbSvg(model([{ name: 'r', stacks: [{ color: '#123456', prs: prs(2) }] }]));
    assert.ok(hex.includes('fill="#123456"') && hex.includes('stroke="#123456"'));
    const many = V.renderThumbSvg(model(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, stacks: [{ color: 'blue', prs: prs(1) }] }))));
    assert.ok(many.includes('+3 more repos') && many.includes('>c</text>') && !many.includes('>d</text>'));
    const err = V.renderThumbSvg(model([{ name: 'gone', error: 'no such repo', stacks: [] }]));
    assert.ok(err.includes('can’t read this repo'));
  });

  test('hundreds of PRs: one block per stack instead of sub-pixel bars', () => {
    const svg = V.renderThumbSvg(model([{ name: 'huge', stacks: [{ color: 'blue', prs: prs(300) }, { color: 'green', prs: prs(200) }] }]));
    assertWellFormed(svg);
    assert.equal(bars(svg).length, 2);
  });
});

describe('endpoints', () => {
  let server: ChildProcess;
  let port = 0;
  let sha = '';
  before(async () => {
    const repo = Repo.create();
    repos.push(repo);
    repo.commit('Initial', { 'README.md': 'x\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('First change', { 'a.txt': 'a\nb\n' });
    sha = repo.commit('Second change', { 'a.txt': 'a\nc\n', 'b.txt': 'b\n' });
    fs.mkdirSync(path.join(PROJECTS, 'viz'));
    fs.writeFileSync(
      path.join(PROJECTS, 'viz', 'project.yaml'),
      YAML.stringify({ title: 'Viz project', repos: [{ path: repo.dir, branch: 'feature', base: 'main', name: 'demo', stacks: [{ title: 'Alpha', starts_at: 'First change' }, { title: 'Beta', color: 'teal', starts_at: 'Second change', follow_on: true }] }] }),
    );
    port = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    server = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), 'serve'], {
      env: { ...process.env, PORT: String(port), LOCAL_REVIEW_DEV: '1', LOCAL_REVIEW_PROJECTS_DIR: PROJECTS },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start');
  });
  after(() => server?.kill());
  const url = (p: string) => `http://127.0.0.1:${port}/api/projects/viz${p}`;

  test('stack.png is image/png; stack.svg highlights the PR; scopes; download names the file', async () => {
    const png = await fetch(url(`/repos/demo/commits/${sha.slice(0, 8)}/stack.png`));
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await png.arrayBuffer());
    assert.equal(buf.subarray(1, 4).toString(), 'PNG');

    const svgRes = await fetch(url(`/repos/demo/commits/${sha}/stack.svg`));
    assert.match(svgRes.headers.get('content-type')!, /^image\/svg\+xml/);
    assert.match(svgRes.headers.get('content-security-policy')!, /default-src 'none'/);
    const svg = await svgRes.text();
    assertWellFormed(svg);
    assert.ok(svg.includes('STACK 1 · ALPHA') && svg.includes('STACK 2 · BETA'));
    assert.ok(svg.includes('◀ this PR'));
    assert.ok(svg.includes('Second change'));

    const stackOnly = await (await fetch(url(`/repos/demo/commits/${sha}/stack.svg?scope=stack`))).text();
    assert.ok(stackOnly.includes('BETA') && !stackOnly.includes('ALPHA'));

    const dl = await fetch(url(`/repos/demo/commits/${sha}/stack.png?download`));
    assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="viz-demo-pr2-stack.png"');

    const noTitle = await (await fetch(url(`/repos/demo/commits/${sha}/stack.svg?scope=stack&title=0`))).text();
    assert.ok(!noTitle.includes('Viz project') && noTitle.includes('BETA') && noTitle.includes('◀ this PR'));
    assert.ok((await (await fetch(url(`/repos/demo/commits/${sha}/stack.svg`))).text()).includes('Viz project'));

    const home = await (await fetch(url('/stack.svg'))).text();
    assert.ok(home.includes('ALPHA') && !home.includes('◀ this PR'));
  });

  test('a follow-on stack (Beta): yellow in the API and the picture, left out of the totals and the project list count', async () => {
    const p = await (await fetch(url(''))).json();
    assert.deepEqual(p.repos[0].stacks.map((g: any) => [g.title, g.color, !!g.follow_on]), [['Alpha', 'blue', false], ['Beta', 'yellow', true]]);
    const home = await (await fetch(url('/stack.svg'))).text();
    assert.ok(home.includes('1 repo · 1 stack · 1 PR · ') && home.includes('+1 follow-on stack (1 PR)'));
    assert.ok(home.includes('stroke="#bf8700"'));
    const list = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
    const viz = list.projects.find((x: any) => x.slug === 'viz');
    assert.deepEqual([viz.commitCount, viz.followOnCount], [1, 1]);
  });

  test('a stack page picture: just that stack, by its ref, nothing highlighted; follows a reordered list', async () => {
    const beta = await fetch(url('/repos/demo/stacks/2-beta/stack.svg'));
    assert.equal(beta.status, 200);
    assert.match(beta.headers.get('content-security-policy')!, /default-src 'none'/);
    const svg = await beta.text();
    assertWellFormed(svg);
    assert.ok(svg.includes('BETA') && !svg.includes('ALPHA') && !svg.includes('◀ this PR'));
    assert.ok(svg.includes('Viz project'));
    const alpha = await (await fetch(url('/repos/demo/stacks/1/stack.svg?title=0'))).text();
    assert.ok(alpha.includes('ALPHA') && !alpha.includes('BETA') && !alpha.includes('Viz project'));
    // the title outranks the number: a ref whose number now holds another stack still finds its own
    assert.ok((await (await fetch(url('/repos/demo/stacks/1-beta/stack.svg'))).text()).includes('BETA'));
    const png = await fetch(url('/repos/demo/stacks/2-beta/stack.png?download'));
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('content-disposition'), 'attachment; filename="viz-demo-stack-2-beta.png"');
  });

  test('stack page pictures: bad refs, missing stacks and repos are refused', async () => {
    assert.equal((await fetch(url('/repos/demo/stacks/9/stack.svg'))).status, 404);
    assert.equal((await fetch(url('/repos/demo/stacks/unstacked/stack.svg'))).status, 404); // Alpha starts at the first commit
    assert.equal((await fetch(url('/repos/demo/stacks/..%2F..%2Fx/stack.svg'))).status, 400);
    assert.equal((await fetch(url('/repos/demo/stacks/0/stack.png'))).status, 400);
    assert.equal((await fetch(url('/repos/nope/stacks/1/stack.svg'))).status, 404);
    // under the same localhost-only guard as every route (fetch won't send another Host, so plain http)
    const status = await new Promise<number>((res, rej) =>
      http.get(url('/repos/demo/stacks/1/stack.svg'), { headers: { host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode!); }).on('error', rej),
    );
    assert.equal(status, 403);
  });

  test('bad shas and repo names are refused as for every other route', async () => {
    assert.equal((await fetch(url('/repos/demo/commits/zzzz/stack.png'))).status, 400);
    assert.equal((await fetch(url('/repos/demo/commits/0000000/stack.svg'))).status, 404);
    assert.equal((await fetch(url('/repos/..%2F..%2Fx/commits/0000000/stack.svg'))).status, 404);
  });

  test('the project list: totals, readiness, last activity and the thumbnail version', async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
    const viz = list.projects.find((x: any) => x.slug === 'viz');
    assert.deepEqual(viz.readiness, { draft: 1, ready: 0, published: 0, merged: 0 }); // the follow-on PR is left out
    assert.equal(viz.totals.prs, 1);
    assert.equal(viz.totals.followOn.prs, 1);
    assert.deepEqual(viz.branches, ['feature']);
    assert.match(viz.thumb, /^[0-9a-f]{16}$/);
    assert.ok(['commit', 'edit', 'comment', 'merged'].includes(viz.activity.kind) && !Number.isNaN(Date.parse(viz.activity.at)));
  });

  test('thumb.svg: an SVG under the image CSP, revalidated by an ETag that is the list’s version', async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
    const v = list.projects.find((x: any) => x.slug === 'viz').thumb;
    const r = await fetch(url('/thumb.svg'));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /^image\/svg\+xml/);
    assert.match(r.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal(r.headers.get('etag'), `"${v}"`);
    const svg = await r.text();
    assertWellFormed(svg);
    assert.ok(svg.includes('>demo</text>') && svg.includes('<pattern')); // the repo's lane, the follow-on hatching
    const again = await fetch(url('/thumb.svg'), { headers: { 'if-none-match': `"${v}"` } });
    assert.equal(again.status, 304);
    assert.equal((await fetch(url('/thumb.svg'), { headers: { 'if-none-match': '"stale"' } })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects/nope/thumb.svg`)).status, 404);
    const status = await new Promise<number>((res, rej) =>
      http.get(url('/thumb.svg'), { headers: { host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode!); }).on('error', rej),
    );
    assert.equal(status, 403);
  });

  test('a new comment is the last activity, and marking a PR ready changes the thumbnail', async () => {
    const before = (await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json()).projects.find((x: any) => x.slug === 'viz');
    const first = (await (await fetch(url(''))).json()).repos[0].commits[0].sha;
    const post = await fetch(url(`/repos/demo/commits/${first}/threads`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'A note' }) });
    assert.equal(post.status, 200);
    const ready = await fetch(url(`/repos/demo/commits/${first}/pr`), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'ready' }) });
    assert.equal(ready.status, 200);
    const after = (await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json()).projects.find((x: any) => x.slug === 'viz');
    assert.equal(after.activity.kind, 'comment');
    assert.ok(after.activity.at >= before.activity.at);
    assert.deepEqual(after.readiness, { draft: 0, ready: 1, published: 0, merged: 0 });
    assert.notEqual(after.thumb, before.thumb);
  });
});
