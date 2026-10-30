// The GitHub sync (server/github.ts, settings.ts, gh.ts): config.yaml, which PRs it asks about (one query per GitHub
// repo, across projects), the cache on disk and its maximum age, backing off after errors, and gh's guard rails. A
// fake source stands in for GitHub; nothing here touches the network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './fixture.ts';

const home = tmpDir('lr-test-github-');
process.env.LOCAL_REVIEW_HOME = home;
delete process.env.LOCAL_REVIEW_PROJECTS_DIR;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const G = await import('../server/github.ts');
const S = await import('../server/settings.ts');
const { checkQuery, ghGraphql, setGhBinary } = await import('../server/gh.ts');

const sha = (n: number) => n.toString(16).padStart(40, '0');
function project(slug: string, yaml: string, prs: Record<string, Record<string, string>>) {
  const dir = path.join(home, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.yaml'), yaml);
  for (const [repo, files] of Object.entries(prs)) {
    fs.mkdirSync(path.join(dir, 'prs', repo), { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'prs', repo, name), text);
  }
}
const config = (text: string) => fs.writeFileSync(path.join(home, 'config.yaml'), text);
const pr = (url: string) => `github:\n  number: ${url.split('/').pop()}\n  url: ${url}\n`;

/** A GitHub that answers from a table, and counts what it's asked. */
function fake(prs: Record<string, any>, opts: { fail?: string } = {}) {
  const calls: { host: string; vars: any; numbers: number[] }[] = [];
  return {
    calls,
    source: {
      name: 'fake',
      async graphql(host: string, query: string, vars: any) {
        checkQuery(query);
        const numbers = [...query.matchAll(/pr(\d+): pullRequest/g)].map((m) => Number(m[1]));
        calls.push({ host, vars, numbers });
        if (opts.fail) throw new Error(opts.fail);
        const repository: Record<string, any> = {};
        for (const n of numbers) repository[`pr${n}`] = prs[`${vars.owner}/${vars.name}#${n}`] ?? null;
        return { data: { viewer: { login: 'me' }, repository } };
      },
    },
  };
}

const open = (o: any = {}) => ({ state: 'OPEN', title: 't', ...o });

describe('settings', () => {
  test('defaults: off, gh, 5 minutes; durations; bad values are warnings and keep the default', () => {
    assert.deepEqual(S.parseSettings(null).github, { sync: false, source: 'gh', maxAgeMs: 300_000, me: null });
    const s = S.parseSettings('github:\n  sync: on\n  max_age: 90s\n  me: edspencer\n');
    assert.deepEqual(s.github, { sync: true, source: 'gh', maxAgeMs: 90_000, me: 'edspencer' });
    assert.equal(S.parseSettings('github: {max_age: 1s}').github.maxAgeMs, 30_000); // at least 30s
    assert.equal(S.duration('1h'), 3_600_000);
    assert.equal(S.duration(45), 45_000);
    assert.equal(S.duration('soon'), null);
    const bad = S.parseSettings('github:\n  sync: maybe\n  source: carrier-pigeon\n  max_age: soon\n');
    assert.deepEqual(bad.github, { sync: false, source: 'gh', maxAgeMs: 300_000, me: null });
    assert.equal(bad.warnings.length, 3);
    assert.equal(S.parseSettings('github: [').warnings.length, 1);
  });
});

describe('sync', () => {
  // two projects record PRs of the same GitHub repo (and one of another); a third opts out
  project('alpha', 'title: Alpha\nrepos:\n  - name: svc\n    path: /nowhere/svc\n    branch: a\n', {
    svc: { [`${sha(1)}.yaml`]: pr('https://github.com/Acme/Svc/pull/1'), [`${sha(2)}.yaml`]: pr('https://github.com/Acme/Svc/pull/2'), [`${sha(3)}.yaml`]: 'github: 3\n', [`${sha(9)}.yaml`]: 'title: not published\n' },
  });
  project('beta', 'title: Beta\nrepos:\n  - name: service\n    path: /nowhere/svc\n    branch: b\n  - name: web\n    path: /nowhere/web\n    branch: b\n', {
    service: { [`${sha(4)}.yaml`]: pr('https://github.com/acme/svc/pull/2'), [`${sha(5)}.yaml`]: pr('https://github.com/acme/svc/pull/5') },
    web: { [`${sha(6)}.yaml`]: pr('https://github.com/acme/web/pull/7') },
  });
  project('gamma', 'title: Gamma\ngithub: {sync: off}\nrepos:\n  - name: svc\n    path: /nowhere/svc\n    branch: c\n', {
    svc: { [`${sha(7)}.yaml`]: pr('https://github.com/acme/svc/pull/99') },
  });

  test('one group per GitHub repo, across projects and local repo names; opted-out projects and the sync being off', () => {
    config('github:\n  sync: off\n');
    assert.deepEqual(G.collectRepos(), []); // off: nothing, unless asked explicitly
    assert.deepEqual(G.collectRepos({ all: true }).map((g) => [g.key, g.numbers, g.projects]), [
      ['acme/svc', [1, 2, 3, 5], ['alpha', 'beta']], // #3 recorded by number only: its repo's URL
      ['acme/web', [7], ['beta']],
    ]);
    config('github:\n  sync: on\n');
    assert.deepEqual(G.collectRepos().map((g) => g.key), ['acme/svc', 'acme/web']);
    assert.deepEqual(G.collectRepos({ project: 'gamma' }), []); // opted out, even when named
    assert.deepEqual(G.collectRepos({ project: 'beta' }).map((g) => [g.key, g.numbers]), [['acme/svc', [2, 5]], ['acme/web', [7]]]);
  });

  test('refresh: one query per repo, snapshots on disk, then fresh until max_age; force asks again', async () => {
    config('github:\n  sync: on\n  max_age: 5m\n');
    let t = Date.parse('2026-10-30T12:00:00Z');
    const now = () => t;
    const gh = fake({
      'Acme/Svc#1': open({ reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ author: { login: 'ana' }, body: 'why?', url: 'u1' }] } }] } }),
      'Acme/Svc#2': open({ latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: { login: 'ana' } }] } }),
      'Acme/Svc#3': { state: 'MERGED', merged: true },
      'acme/web#7': open(),
    });
    const r1 = await G.refresh({ source: gh.source, now });
    assert.deepEqual(gh.calls.map((c) => [c.host, c.vars.owner, c.vars.name, c.numbers]), [
      ['github.com', 'Acme', 'Svc', [1, 2, 3, 5]],
      ['github.com', 'acme', 'web', [7]],
    ]);
    assert.deepEqual(r1.map((r) => [r.key, r.fetched, r.missing]), [['acme/svc', 3, [5]], ['acme/web', 1, undefined]]);
    const snap = G.readSnapshot({ host: 'github.com', owner: 'ACME', repo: 'svc', number: 1 })!;
    assert.equal(snap.threads[0].state, 'open');
    assert.equal(snap.threads[0].comments[0].body, 'why?');
    assert.ok(fs.existsSync(path.join(home, 'github', 'acme', 'svc', '1.json')));

    // the UI's view of a project, from the cache
    const b = G.projectGithub('beta')!;
    assert.equal(b.enabled, true);
    assert.equal(b.fetchedAt, '2026-10-30T12:00:00.000Z');
    assert.deepEqual(Object.keys(b.prs).sort(), ['acme/svc#2', 'acme/web#7']);
    assert.equal(b.prs['acme/svc#2'].tone, 'approved');
    assert.equal(b.aliases['service#5'], 'acme/svc#5');
    assert.equal(G.projectGithub('alpha')!.aliases['svc#3'], 'acme/svc#3');
    assert.equal(G.projectGithub('gamma')!.optedOut, true);

    // fresh: nothing asked; a minute later still fresh
    gh.calls.length = 0;
    t += 60_000;
    assert.deepEqual((await G.refresh({ source: gh.source, now })).map((r) => r.skipped), ['fresh', 'fresh']);
    // a page coming back into view refreshes what's over a minute old
    t += 1000;
    await G.refresh({ source: gh.source, now, minAgeMs: G.FOCUS_MIN_AGE_MS, project: 'beta' });
    assert.deepEqual(gh.calls.map((c) => c.numbers), [[2, 5], [7]]); // beta's PRs only (#5: not found last time, asked again)
    // past max_age: due again; force asks for everything, merged too
    gh.calls.length = 0;
    t += 5 * 60_000;
    await G.refresh({ source: gh.source, now, project: 'alpha' });
    assert.deepEqual(gh.calls.map((c) => c.numbers), [[1, 2]]); // alpha's open PRs: its merged #3 isn't asked again
    gh.calls.length = 0;
    await G.refresh({ source: gh.source, now, project: 'alpha', force: true });
    assert.deepEqual(gh.calls.map((c) => c.numbers), [[1, 2, 3]]);
  });

  test('a new PR is fetched at once; errors are recorded and back off', async () => {
    config('github:\n  sync: on\n  max_age: 10m\n');
    let t = Date.parse('2026-10-30T13:00:00Z');
    const now = () => t;
    const ok = fake({ 'acme/web#7': open(), 'acme/web#8': open() });
    await G.refresh({ source: ok.source, now, project: 'beta', force: true });
    // an agent records a new PR: fetched on the next round, though the repo is fresh
    fs.writeFileSync(path.join(home, 'projects', 'beta', 'prs', 'web', `${sha(8)}.yaml`), pr('https://github.com/acme/web/pull/8'));
    ok.calls.length = 0;
    t += 1000;
    await G.refresh({ source: ok.source, now, project: 'beta' });
    assert.deepEqual(ok.calls.map((c) => [c.vars.name, c.numbers]), [['web', [7, 8]]]);

    const down = fake({}, { fail: "gh isn't logged in to github.com" });
    t += 11 * 60_000;
    const r = await G.refresh({ source: down.source, now, project: 'beta' });
    assert.equal(r[0].error, "gh isn't logged in to github.com");
    assert.equal(G.readRepoSync({ owner: 'acme', repo: 'svc' })!.failures, 1);
    assert.match(G.projectGithub('beta')!.error!, /logged in/);
    // backing off: not asked again for a minute, then two
    down.calls.length = 0;
    t += 30_000;
    assert.deepEqual((await G.refresh({ source: down.source, now, project: 'beta' })).map((x) => x.skipped), ['backoff', 'backoff']);
    t += 31_000;
    await G.refresh({ source: down.source, now, project: 'beta' });
    assert.equal(G.readRepoSync({ owner: 'acme', repo: 'svc' })!.failures, 2);
    t += 61_000;
    assert.equal((await G.refresh({ source: down.source, now, project: 'beta' }))[0].skipped, 'backoff');
    // the Refresh button always asks; once it works the error's gone, and the old snapshots were kept meanwhile
    await G.refresh({ source: ok.source, now, project: 'beta', force: true });
    assert.equal(G.readRepoSync({ owner: 'acme', repo: 'web' })!.error, null);
    assert.ok(G.readSnapshot({ host: 'github.com', owner: 'acme', repo: 'svc', number: 2 }));
  });

  test('concurrent refreshes of a repo share one fetch', async () => {
    config('github:\n  sync: on\n');
    const gh = fake({ 'acme/web#7': open(), 'acme/web#8': open() });
    const slow = { name: 'slow', graphql: async (h: string, q: string, v: any) => { await new Promise((r) => setTimeout(r, 30)); return gh.source.graphql(h, q, v); } };
    await Promise.all([G.refresh({ source: slow, project: 'beta', force: true }), G.refresh({ source: slow, project: 'beta', force: true })]);
    assert.equal(gh.calls.filter((c) => c.vars.name === 'web').length, 1);
  });
});

describe('gh', () => {
  test('only queries: no mutations, no subscriptions', () => {
    assert.doesNotThrow(() => checkQuery('query { viewer { login } }'));
    assert.throws(() => checkQuery('mutation { addComment(input: {}) { clientMutationId } }'), /isn't a query/);
    assert.throws(() => checkQuery('query { a } mutation { b }'), /mutation/);
    assert.throws(() => checkQuery('{ viewer { login } }'), /isn't a query/);
  });

  test('runs `gh api graphql --hostname <host> --input -` with the request on stdin; partial answers and errors', async () => {
    const dir = tmpDir('lr-test-gh-');
    const log = path.join(dir, 'log');
    const bin = path.join(dir, 'gh');
    // a gh that logs its arguments and stdin, then answers as the env says
    fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > '${log}'\ncat >> '${log}'\ncase "$FAKE_GH" in\n  partial) echo '{"data":{"repository":{"pr1":null}},"errors":[{"message":"not found"}]}'; exit 1 ;;\n  auth) echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4 ;;\n  *) echo '{"data":{"viewer":{"login":"me"}}}' ;;\nesac\n`, { mode: 0o755 });
    setGhBinary(bin);
    try {
      const r = await ghGraphql('github.com', 'query { viewer { login } }', { owner: 'a' });
      assert.deepEqual(r, { data: { viewer: { login: 'me' } } });
      const [args, input] = fs.readFileSync(log, 'utf8').split('\n');
      assert.equal(args, 'api graphql --hostname github.com --input -');
      assert.deepEqual(JSON.parse(input), { query: 'query { viewer { login } }', variables: { owner: 'a' } });
      process.env.FAKE_GH = 'partial';
      assert.deepEqual((await ghGraphql('github.com', 'query { x }', {})).errors, [{ message: 'not found' }]);
      process.env.FAKE_GH = 'auth';
      await assert.rejects(ghGraphql('ghe.example.com', 'query { x }', {}), (e: any) => e.kind === 'auth' && /gh auth login --hostname ghe.example.com/.test(e.message));
      await assert.rejects(ghGraphql('-x', 'query { x }', {}), /bad GitHub host/);
      setGhBinary(path.join(dir, 'no-such-gh'));
      await assert.rejects(ghGraphql('github.com', 'query { x }', {}), (e: any) => e.kind === 'missing');
    } finally {
      delete process.env.FAKE_GH;
      setGhBinary('gh');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
