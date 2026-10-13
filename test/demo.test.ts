// The demo test bed (demo/): seeding is deterministic (the same shas and data files as the committed lock,
// demo/shas.json), and what it seeds loads cleanly through the real server: no YAML or repo warnings, every
// feature it's meant to show actually showing. Seeds into the OS temp dir only.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, seed, type Manifest } from '../demo/seed.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('seeding is deterministic: the same shas and data files as demo/shas.json', () => {
  assert.deepEqual(check(), [], 'run `npm run demo:check -- --update` if the demo content changed on purpose');
});

describe('the seeded demo, through the server', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-test-demo-'));
  let m: Manifest;
  let server: ChildProcess | undefined;
  let port = 0;
  const api = async (p: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${p}`);
    assert.equal(res.status, 200, p);
    return res.json() as Promise<any>;
  };
  const sha = (repo: string, key: string) => m.lock.repos[repo][key];

  before(async () => {
    m = seed(out, { force: true });
    port = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    server = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/cli.ts'), 'serve'], {
      env: { ...process.env, HOME: m.home, LOCAL_REVIEW_HOME: m.localReviewHome, LOCAL_REVIEW_USER: m.reviewer, PORT: String(port), LOCAL_REVIEW_DEV: '1' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start');
  });
  after(() => {
    server?.kill();
    fs.rmSync(out, { recursive: true, force: true });
  });

  test('four projects, one archived, no errors or warnings anywhere', async () => {
    const list = await api('/projects');
    const projects = Array.isArray(list) ? list : list.projects;
    assert.deepEqual(projects.map((p: any) => [p.slug, p.archived]).sort(), [['calendar-feed', false], ['calendar-reminders', false], ['waitlists', false], ['webhook-retries', true]]);
    for (const p of projects) {
      const full = await api(`/projects/${p.slug}`);
      assert.equal(full.error ?? null, null, p.slug);
      assert.deepEqual(full.warnings, [], p.slug);
      for (const r of full.repos) {
        assert.equal(r.error ?? null, null, `${p.slug}/${r.name}`);
        assert.deepEqual(r.warnings, [], `${p.slug}/${r.name}`);
      }
    }
  });

  test('the flagship shows every readiness state, branch status and stack kind', async () => {
    const p = await api('/projects/waitlists');
    const repo = (n: string) => p.repos.find((r: any) => r.name === n);
    const status = (r: string) => repo(r).commits.map((c: any) => c.status);
    assert.deepEqual(status('orchard-api'), ['merged', 'merged', 'published', 'published', 'published', 'draft', 'ready', 'draft', 'draft', 'draft']);
    const branches = repo('orchard-api').commits.map((c: any) => c.branch?.status ?? null);
    assert.deepEqual(branches, ['merged', 'merged', 'ok', 'ok', 'ok', 'ok', 'moved', 'ok', null, 'discovered']);
    assert.deepEqual(repo('orchard-api').stacks.map((s: any) => [s.title, s.color, s.shas.length, !!s.follow_on]), [
      ['Groundwork', 'blue', 2, false],
      ['Joining and leaving', 'green', 3, false],
      ['Automatic promotion', 'purple', 3, false],
      ['Studio controls', 'yellow', 2, true],
    ]);
    assert.equal(repo('orchard-web').stacks[0].implicit, 'unstacked');
    assert.equal(repo('orchard-api').commits[4].title, 'Show your waitlist position in GET /me/bookings'); // title override
  });

  test('every review file parses, and its threads land where they were written (one outdated, by design)', async () => {
    let threads = 0;
    const outdated: string[] = [];
    const forGithub: string[] = [];
    for (const slug of ['waitlists', 'calendar-feed', 'calendar-reminders', 'webhook-retries']) {
      const p = await api(`/projects/${slug}`);
      for (const r of p.repos)
        for (const c of r.commits) {
          const rev = await api(`/projects/${slug}/repos/${r.name}/commits/${c.sha}/review`);
          assert.equal(rev.parse_error ?? null, null, `${slug}/${r.name}/${c.short}`);
          for (const t of rev.threads ?? []) {
            threads++;
            if (t.outdated) outdated.push(`${r.name}/${c.sha}`);
            if (t.publish) forGithub.push(`${r.name}/${c.position}${t.published ? ' posted' : ''}`);
          }
        }
    }
    assert.equal(threads, 22);
    // marked for the GitHub PR: two to post in Automatic promotion, one already posted on the published #5
    assert.deepEqual(forGithub, ['orchard-api/5 posted', 'orchard-api/6', 'orchard-api/8']);
    assert.deepEqual(outdated, [`orchard-api/${sha('orchard-api', 'f6')}`]);
  });

  test('linked projects: calendar reminders builds on the calendar feed, its range starting where the feed ends', async () => {
    const feed = await api('/projects/calendar-feed');
    const rem = await api('/projects/calendar-reminders');
    assert.deepEqual(rem.after, { slug: 'calendar-feed', title: 'Calendar feed' });
    assert.deepEqual(feed.next, [{ slug: 'calendar-reminders', title: 'Calendar reminders' }]);
    const api_ = rem.repos[0];
    assert.equal(api_.startsAfter, true);
    assert.equal(api_.after, 'theo/calendar-feed');
    assert.equal(api_.mergeBase, sha('orchard-api', 'Rotate calendar tokens from account settings'));
    assert.deepEqual(api_.commits.map((c: any) => c.subject), ['Add reminder alarms to calendar events', 'Remind members an hour before each class', 'Let members choose their reminder time']);
    assert.deepEqual(api_.stacks.map((s: any) => [s.title, s.shas.length]), [['Reminders', 2], ['Reminder settings', 1]]);
    const list = await api('/projects');
    const summary = (s: string) => list.projects.find((p: any) => p.slug === s);
    assert.deepEqual([summary('calendar-reminders').after, summary('calendar-feed').next], ['calendar-feed', ['calendar-reminders']]);
  });

  test('landed PRs show their GitHub diff', async () => {
    const p = await api('/projects/webhook-retries');
    for (const c of p.repos[0].commits) assert.equal(c.landed?.diff, 'merge-base', c.title);
    const w = await api('/projects/waitlists');
    for (const c of w.repos[0].commits.slice(0, 2)) assert.equal(c.landed?.diff, 'merge-base', c.title);
  });

  test('the archived project labels its repo "merged" in the stack picture, as the sidebar does, not with its base', async () => {
    const svg = await (await fetch(`http://127.0.0.1:${port}/api/projects/webhook-retries/stack.svg`)).text();
    assert.match(svg, />merged<\/text>/);
    assert.doesNotMatch(svg, /origin\/main/);
  });
});
