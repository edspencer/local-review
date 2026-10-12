// The Local Review data home: four projects over the four repos (two of them linked), with PR overrides, readiness, branches, GitHub
// records, landed PRs and review threads, written as plain YAML following the schemas on the docs site
// (website/src/content/docs/reference/: project.yaml, PR files, comment files). Line numbers are looked up in the generated files, never hard-coded.
import crypto from 'node:crypto';
import YAML from 'yaml';
import { git, gitAsync, type RepoBuilder } from '../lib/gitworld.ts';
import { REVIEWER, at, prUrl } from './people.ts';

export interface Repos {
  api: RepoBuilder;
  sdk: RepoBuilder;
  web: RepoBuilder;
  infra: RepoBuilder;
}

/** A file to write under the data home, with the modification time it should get. */
export interface DataFile {
  path: string; // relative to $LOCAL_REVIEW_HOME
  content: string;
  mtime: string; // ISO
}

const yaml = (o: unknown) => YAML.stringify(o, { lineWidth: 0, blockQuote: 'literal' });

/** Deterministic ids in the server's format (`t-1a2b3c4d`, `c-…`), from a seed string. */
const id = (prefix: string, seed: string) => `${prefix}-${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8)}`;

interface C {
  by?: string; // default: the reviewer
  at: string;
  body: string;
}

interface ThreadSpec {
  /** inline: file + the text of the (first) commented line; `to` for a range ends at the line holding that text */
  file?: string;
  line?: string;
  to?: string;
  resolved?: boolean;
  comments: C[];
}

/**
 * Where the data home's names point. The demo seed uses the defaults (`~/code/<repo>`, the plain slugs); the example
 * projects the app can create (server/examples.ts) put the repos in the data home and prefix the slugs.
 */
export interface DataHomeOptions {
  /** the `path:` written into project.yaml for a repo */
  repoPath?: (name: string) => string;
  /** the project's directory name under projects/ */
  slug?: (name: string) => string;
  /** patch ids worked out beforehand (patchIds below), by repo name and sha, so this makes no git calls of its own */
  patchIds?: Map<string, Map<string, string>>;
}

/** `git patch-id --stable` of one commit, as the server records it (empty for a commit it gives none, e.g. a merge). */
export async function patchIdAsync(dir: string, sha: string): Promise<string> {
  const show = await gitAsync(dir, ['show', '--no-color', '--no-ext-diff', sha]);
  return (await gitAsync(dir, ['patch-id', '--stable'], show)).split(' ')[0];
}

/** Every commit's patch id, by repo name and sha, without blocking (a few at a time). */
export async function patchIds(repos: Repos, repoDir: (name: string) => string): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const jobs = (Object.values(repos) as RepoBuilder[]).flatMap((r) => {
    const m = new Map<string, string>();
    out.set(r.name, m);
    return r.commits.map((c) => async () => {
      try {
        m.set(c.sha!, await patchIdAsync(repoDir(r.name), c.sha!));
      } catch {
        /* left out: buildDataHome works it out itself if it needs this one */
      }
    });
  });
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) await job();
  }));
  return out;
}

/** The four projects, by their plain names (before DataHomeOptions.slug). */
export const PROJECTS = ['waitlists', 'calendar-feed', 'calendar-reminders', 'webhook-retries'] as const;

export function buildDataHome(repos: Repos, repoDir: (name: string) => string, opts: DataHomeOptions = {}): DataFile[] {
  const out: DataFile[] = [];
  const repoPath = opts.repoPath ?? ((name: string) => `~/code/${name}`);
  const slug = opts.slug ?? ((name: string) => name);
  const { api, sdk, web, infra } = repos;

  /** 1-based line number of the first line containing `text` in `file` at commit `key` (on disk). */
  const lineOf = (r: RepoBuilder, key: string, file: string, text: string, from = 1): number => {
    const lines = r.file(key, file).split('\n');
    for (let i = from - 1; i < lines.length; i++) if (lines[i].replace(/\t/g, '    ').includes(text)) return i + 1;
    throw new Error(`${r.name} ${key}: "${text}" not in ${file}`);
  };
  const patchId = (r: RepoBuilder, key: string) => {
    const known = opts.patchIds?.get(r.name)?.get(r.sha(key));
    if (known !== undefined) return known;
    const dir = repoDir(r.name);
    const show = git(dir, ['show', '--no-color', '--no-ext-diff', r.sha(key)]);
    return git(dir, ['patch-id', '--stable'], show).split(' ')[0];
  };

  const thread = (r: RepoBuilder, key: string, seed: string, t: ThreadSpec) => {
    const tid = id('t', `${r.name}/${key}/${seed}`);
    const o: Record<string, unknown> = { id: tid };
    if (t.file) {
      const line = lineOf(r, key, t.file, t.line!);
      const end = t.to ? lineOf(r, key, t.file, t.to, line) : line;
      Object.assign(o, { path: t.file, side: 'right', line: end, ...(end > line ? { start_line: line } : {}) });
    }
    o.resolved = t.resolved ?? false;
    o.comments = t.comments.map((c, i) => ({ id: id('c', `${tid}/${i}`), author: c.by ?? REVIEWER, created: c.at, body: c.body.replace(/\n*$/, '\n') }));
    return o;
  };

  /** A review file: reviews/<repo>/<sha>.yaml; `branch` is the repo's range end, as the server writes it. */
  const review = (project: string, r: RepoBuilder, key: string, branch: string | undefined, o: { viewed?: string[]; threads?: Record<string, unknown>[]; extra?: Record<string, unknown>; mtime: string }) => {
    const c = r.get(key);
    const doc: Record<string, unknown> = { repo: r.name, ...(branch ? { branch } : {}), commit: c.sha, patch_id: patchId(r, key), subject: c.subject, ...o.extra };
    doc.viewed = o.viewed ?? [];
    doc.threads = o.threads ?? [];
    out.push({ path: `projects/${project}/reviews/${r.name}/${c.sha}.yaml`, content: yaml(doc), mtime: o.mtime });
  };

  /** A prs file: prs/<repo>/<sha>.yaml. */
  const prs = (project: string, r: RepoBuilder, key: string, o: Record<string, unknown> & { mtime: string }) => {
    const c = r.get(key);
    const { mtime, ...fields } = o;
    const doc = { commit: c.sha, patch_id: patchId(r, key), subject: c.subject, ...fields, updated: mtime };
    out.push({ path: `projects/${project}/prs/${r.name}/${c.sha}.yaml`, content: yaml(doc), mtime });
  };

  const gh = (repo: string, n: number, branch: string, base: string, created: string, stack: number, stackedOn?: string) => ({
    number: n,
    url: prUrl(repo, n),
    branch,
    base,
    created,
    stack,
    ...(stackedOn ? { stacked_on: stackedOn } : {}),
  });
  const prefix = (r: RepoBuilder, key: string) => r.sha(key).slice(0, 12);

  // ======================================================================== waitlists (the flagship)
  const P = slug('waitlists');
  const BR = 'maya/waitlists';
  out.push({
    path: `projects/${P}/project.yaml`,
    mtime: at('2026-09-16 15:30'),
    content: `# Maya's waitlists work: four repos, reviewed here before (and while) it goes up as GitHub stacked PRs.
title: Class waitlists
description: |
  Full classes turn people away, and the spots that free up when someone cancels mostly go unused:
  nobody refreshes the schedule at 6am. This adds a waitlist to every full class. When a booking is
  cancelled, the first person in line is offered the spot and has two hours to take it before it
  moves on to the next.

  It spans the API (data model, promotion, expiry), the SDK, the web app and the infra (the expiry
  sweep and the rollout flag), and ships behind the \`waitlists\` flag, on for three beta studios first.
repos:
  - path: ${repoPath('orchard-api')}
    branch: ${BR}
    base: origin/main
    github_stack: 117
    # merged on GitHub (#112, #113), frozen before the rebase onto the new main
    landed: ["${prefix(api, 'f1')}", "${prefix(api, 'f2')}"]
    stacks:
      - title: Groundwork
        color: blue
        starts_at: "Add the waitlist_entries table"
        description: |
          The table and its store, with nothing calling them yet. Merged as #112 and #113.
      - title: Joining and leaving
        color: green
        starts_at: "Let members join a full class's waitlist"
        description: |
          Members can join and leave a full class's waitlist and see their place in line. Nobody is
          promoted yet: that's the next stack.
      - title: Automatic promotion
        color: purple
        starts_at: "Promote the first waitlisted member when a spot opens"
        description: |
          A cancellation offers the spot to the first person in line, held for two hours; a sweep
          expires offers nobody took and passes the spot on; the offer goes out by email.
      - title: Studio controls
        starts_at: "Let studio staff reorder a waitlist"
        follow_on: true
        description: |
          Parked until the beta studios have used the basic waitlist for a few weeks. Next after these:
          a per-studio hold window (it's a constant, two hours, for now).
  - path: ${repoPath('orchard-sdk')}
    branch: ${BR}
    base: origin/main
    stacks:
      - title: Waitlist client
        color: teal
        description: |
          Types and calls for the new endpoints. Released as 0.8.0-beta.1 for the web app to build on.
  - path: ${repoPath('orchard-web')}
    branch: ${BR}
    base: origin/main
    stacks:
      - title: Waitlist UI
        color: orange
        starts_at: "Add a Join waitlist button to full classes"
      - title: Offer copy
        color: pink
        starts_at: "Explain the hold window in the offer banner"
        description: |
          Split out so the copy can be reviewed with June without holding up the UI.
  - path: ${repoPath('orchard-infra')}
    branch: ${BR}
    base: origin/main
    stacks:
      - title: Rollout
        color: red
`,
  });

  // ---------------- orchard-api: prs files
  prs(P, api, 'f1', {
    status: 'ready',
    branch: 'maya/waitlist-table',
    github: gh('orchard-api', 112, 'maya/waitlist-table', 'main', at('2026-09-13 16:20'), 111),
    landed: { head: api.sha('f1'), base: api.sha('Refuse bookings for classes that have already started'), commit: api.sha('squash #112'), method: 'squash', at: at('2026-09-14 10:02') },
    mtime: at('2026-09-14 10:30'),
  });
  prs(P, api, 'f2', {
    status: 'ready',
    branch: 'maya/waitlist-store',
    github: gh('orchard-api', 113, 'maya/waitlist-store', 'main', at('2026-09-13 16:21'), 111, 'maya/waitlist-table'),
    landed: { head: api.sha('f2 on GitHub'), base: api.sha('squash #112'), commit: api.sha('squash #113'), method: 'squash', at: at('2026-09-14 10:09') },
    mtime: at('2026-09-14 10:31'),
  });
  prs(P, api, 'f3', { status: 'ready', branch: 'maya/waitlist-join', github: gh('orchard-api', 118, 'maya/waitlist-join', 'main', at('2026-09-15 09:12'), 117), mtime: at('2026-09-15 09:20') });
  prs(P, api, 'f4', { status: 'ready', branch: 'maya/waitlist-leave', github: gh('orchard-api', 119, 'maya/waitlist-leave', 'maya/waitlist-join', at('2026-09-15 09:13'), 117), mtime: at('2026-09-15 09:20') });
  prs(P, api, 'f5', {
    title: 'Show your waitlist position in GET /me/bookings',
    status: 'ready',
    branch: 'maya/waitlist-position',
    github: gh('orchard-api', 120, 'maya/waitlist-position', 'maya/waitlist-leave', at('2026-09-15 09:14'), 117),
    mtime: at('2026-09-15 09:20'),
  });
  prs(P, api, 'f6', {
    branch: 'maya/promote-on-cancel',
    body: `Cancelling a booking now offers the freed spot to the first person in the class's waitlist. The spot is held for them for two hours (\`HoldWindow\`); \`POST /me/offers/{id}/accept\` turns the offer into a booking.

Promotion runs inside the cancel transaction, holding the class lock, so two cancellations at once offer two different spots rather than the same one twice.`,
    mtime: at('2026-09-16 15:40'),
  });
  prs(P, api, 'f7', { status: 'ready', branch: 'maya/promotion-expiry', mtime: at('2026-09-16 11:05') });
  prs(P, api, 'f8', { branch: 'maya/promotion-emails', mtime: at('2026-09-12 17:00') });

  // ---------------- orchard-api: reviews
  review(P, api, 'f1', BR, {
    mtime: at('2026-09-13 15:02'),
    viewed: ['migrations/0005_waitlist.sql'],
    threads: [
      thread(api, 'f1', 'unique', {
        file: 'migrations/0005_waitlist.sql',
        line: 'UNIQUE (class_id, member_id)',
        resolved: true,
        comments: [
          { at: at('2026-09-12 09:14'), body: "This stops someone rejoining a waitlist after they've left (or after an offer to them expired). Is that what we want? I'd expect them to be able to get back in line, at the back." },
          {
            by: 'claude',
            at: at('2026-09-12 09:31'),
            body: "It is, and the constraint stays: the store's `JoinWaitlist` (next PR) upserts on it, so rejoining resets the row to `waiting` at the back of the line rather than inserting a second one. One row per member per class also keeps the position query simple. There's a test for it there: `TestRejoiningGoesToTheBack`.",
          },
          { at: at('2026-09-12 10:02'), body: 'Makes sense, thanks.' },
        ],
      }),
    ],
  });
  review(P, api, 'f2', BR, {
    mtime: at('2026-09-13 15:05'),
    viewed: ['internal/store/waitlist.go', 'internal/store/waitlist_test.go'],
    threads: [
      thread(api, 'f2', 'ci', {
        resolved: true,
        comments: [
          { at: at('2026-09-12 10:20'), body: 'These tests need `TEST_DATABASE_URL` and skip without it. Is CI setting it for this package, or are they quietly skipping there too?' },
          { by: 'claude', at: at('2026-09-12 10:26'), body: "CI sets it for the whole `go test ./...` run (`.github/workflows/ci.yml`) and applies every migration first, so 0005 is in place. I checked the last run's log: `TestRejoiningGoesToTheBack` ran and passed. Locally they skip, like the booking tests." },
        ],
      }),
    ],
  });
  review(P, api, 'f3', BR, {
    mtime: at('2026-09-14 16:40'),
    viewed: ['README.md', 'internal/booking/waitlist.go', 'internal/httpapi/router.go', 'internal/httpapi/waitlist.go'],
    threads: [
      thread(api, 'f3', 'status', {
        file: 'internal/httpapi/waitlist.go',
        line: 'case errors.Is(err, booking.ErrClassNotFull):',
        resolved: true,
        comments: [
          { at: at('2026-09-14 15:58'), body: "409 or 422 here? The request itself is fine; the class just isn't in the state it needs." },
          { by: 'claude', at: at('2026-09-14 16:05'), body: "409, to match `class_full` and `already_booked`: the clients already treat a 409 as \"the class changed under you, refresh it\", which is the right reaction here too. A 422 would be a new case for every client to handle." },
          { at: at('2026-09-14 16:39'), body: 'Agreed.' },
        ],
      }),
    ],
  });
  review(P, api, 'f4', BR, { mtime: at('2026-09-14 16:44'), viewed: ['internal/booking/waitlist.go', 'internal/httpapi/router.go', 'internal/httpapi/waitlist.go'] });
  review(P, api, 'f5', BR, {
    mtime: at('2026-09-14 17:10'),
    viewed: ['internal/httpapi/bookings.go', 'internal/httpapi/waitlist.go', 'internal/store/waitlist.go'],
    threads: [
      thread(api, 'f5', 'position', {
        file: 'internal/store/waitlist.go',
        line: '(SELECT count(*) FROM waitlist_entries a',
        to: "WHERE a.class_id = w.class_id AND a.status = 'waiting' AND a.position <= w.position),",
        resolved: true,
        comments: [
          { at: at('2026-09-14 16:58'), body: "So the position counts only the people still waiting, and it can go *down* while you wait, when someone ahead leaves. Good: that's what we want to show. Worth saying in the doc comment, so nobody \"fixes\" it to return the stored `position`." },
          { by: 'claude', at: at('2026-09-14 17:04'), body: 'Added to the doc comment on `MemberWaitlist`: "Position counts only the people still waiting ahead of them."' },
        ],
      }),
    ],
  });

  // the outdated thread: made on the first version of "Promote…", on lines the amend removed
  const v1 = 'f6@v1';
  const promote = 'internal/booking/promote.go';
  const oStart = lineOf(api, v1, promote, 'class, err := s.db.Class(ctx, classID)');
  const oEnd = oStart + 3;
  const v1Lines = api.file(v1, promote).split('\n');
  const outdated = {
    ...thread(api, v1, 'outside-tx', {
      file: promote,
      line: 'class, err := s.db.Class(ctx, classID)',
      to: '    }',
      comments: [
        { at: at('2026-09-15 14:21'), body: "This reads the class through the pool, outside the transaction, so it neither sees nor locks anything the cancellation just did. See the general comment." },
        { by: 'claude', at: at('2026-09-16 15:22'), body: 'Gone in the amend: the class now comes from `store.LockClass` inside the cancel transaction, and is passed in.' },
      ],
    }),
    outdated: true,
    anchor: {
      commit: api.sha(v1),
      path: promote,
      side: 'right',
      line: oEnd,
      start_line: oStart,
      before: v1Lines.slice(oStart - 4, oStart - 1).join('\n'),
      text: v1Lines.slice(oStart - 1, oEnd).join('\n'),
      after: v1Lines.slice(oEnd, oEnd + 3).join('\n'),
    },
  };
  review(P, api, 'f6', BR, {
    mtime: at('2026-09-18 09:47'),
    extra: { previous_commits: [api.sha(v1)], matched_by: 'subject' },
    viewed: ['internal/httpapi/offers.go', 'internal/httpapi/router.go', 'internal/store/waitlist.go'],
    threads: [
      thread(api, 'f6', 'race', {
        comments: [
          {
            at: at('2026-09-15 14:16'),
            body: "The happy path reads well. My main worry is two cancellations for the same class landing at once: both transactions count the bookings before either commits, both see a free spot, and we offer two people the same place.\n\nCan you take the class lock first, like `Book` does?",
          },
          {
            by: 'claude',
            at: at('2026-09-16 15:21'),
            body: "Done, squashed into this commit (the stack is rebased on it):\n\n- `Cancel` takes `store.LockClass` before promoting, and `promoteFirstWaiting` takes the locked class instead of reading it again.\n- `ExpireHolds`, in the next PR, locks the same way.\n- New test: `TestConcurrentCancellationsOfferOneSpotEach` cancels two bookings at once and checks that the first two in line get an offer each and the third keeps waiting.",
          },
          { at: at('2026-09-17 08:52'), body: "Great. Leaving this open until I've read the test properly." },
        ],
      }),
      outdated,
      thread(api, 'f6', 'offered-spots', {
        file: promote,
        line: 'n, err := store.CountBookings(ctx, tx, class.ID)',
        to: 'if n >= class.Capacity {',
        comments: [
          {
            at: at('2026-09-17 09:05'),
            body: "`CountBookings` only counts confirmed bookings, so while a spot is on offer it still looks free. Someone booking from the schedule during the hold takes it, and the person we emailed finds it gone when they tap **Take the spot**.",
          },
          {
            by: 'claude',
            at: at('2026-09-17 09:18'),
            body: "You're right, and `Book` has the same gap. Two ways to fix it:\n\n1. Count outstanding offers in `CountBookings` itself, so `Book`, `JoinWaitlist` and promotion all agree on what's taken.\n2. A separate `TakenSpots`, used here and in `Book`.\n\nI'd do 1, in this commit: an offered spot is taken for every purpose I can think of. Shall I?",
          },
        ],
      }),
      thread(api, 'f6', 'hold', {
        file: promote,
        line: 'const HoldWindow = 2 * time.Hour',
        resolved: true,
        comments: [
          { at: at('2026-09-15 14:30'), body: "Two hours is long for a 7am class when the cancellation comes in at 6:30. Not for this PR, but studios will want to set this." },
          { by: 'claude', at: at('2026-09-16 15:24'), body: "Agreed. I've left it a constant here and added a per-studio hold window to the Studio controls stack's note, as the next thing after those two PRs." },
        ],
      }),
    ],
  });
  review(P, api, 'f7', BR, {
    mtime: at('2026-09-17 11:02'),
    viewed: ['README.md', 'cmd/orchard-api/main.go', 'cmd/orchard-api/sweep.go', 'internal/booking/expiry.go', 'internal/store/waitlist.go'],
    threads: [
      thread(api, 'f7', 'accept-race', {
        file: 'internal/booking/expiry.go',
        line: 'ok, err := store.ExpireOffer(ctx, tx, e.ID, s.now())',
        resolved: true,
        comments: [
          { at: at('2026-09-17 10:31'), body: 'What happens if the member taps accept in the same second the sweep runs?' },
          {
            by: 'claude',
            at: at('2026-09-17 10:40'),
            body: "Both are a single `UPDATE … WHERE status = 'offered'`, so whichever commits first wins and the other matches no row: an accept after the expiry gets `offer_gone` (410), and a sweep after the accept skips it (`!ok`). There's no window in which both succeed.",
          },
          { at: at('2026-09-17 11:01'), body: 'Perfect, thanks.' },
        ],
      }),
    ],
  });
  review(P, api, 'f8', BR, {
    mtime: at('2026-09-18 10:12'),
    viewed: ['internal/store/outbox.go', 'migrations/0006_notification_outbox.sql'],
    threads: [
      thread(api, 'f8', 'skip-locked', {
        file: 'internal/store/outbox.go',
        line: 'FOR UPDATE SKIP LOCKED',
        resolved: true,
        comments: [
          { at: at('2026-09-18 09:58'), body: 'With three API replicas we get three relays. Can two of them send the same message?' },
          {
            by: 'claude',
            at: at('2026-09-18 10:04'),
            body: "Not normally: each relay claims its rows with `FOR UPDATE SKIP LOCKED` and marks them sent before it commits, so a row one relay holds is invisible to the others. A failed send leaves the row unsent for the next tick. The one way to get a duplicate is a pod dying after the send but before the commit: at-least-once, the usual outbox trade-off.",
          },
          { at: at('2026-09-18 10:11'), body: 'At-least-once is fine for this.' },
        ],
      }),
      thread(api, 'f8', 'copy', {
        file: 'internal/notify/messages.go',
        line: 'Good news: a spot in %s with %s (%s) is yours if you want it.',
        comments: [
          { at: at('2026-09-18 10:15'), body: '"is yours if you want it" could read as *already booked*. Let\'s get June to look at the wording before this goes up; the web banner has the same sentence.' },
        ],
      }),
    ],
  });

  // ---------------- orchard-sdk
  prs(P, sdk, 's1', { status: 'ready', branch: 'maya/sdk-waitlist-types', github: gh('orchard-sdk', 64, 'maya/sdk-waitlist-types', 'main', at('2026-09-15 10:02'), 63), mtime: at('2026-09-15 10:05') });
  prs(P, sdk, 's2', { title: 'Add joinWaitlist() and leaveWaitlist()', status: 'ready', branch: 'maya/sdk-join-leave', mtime: at('2026-09-15 15:40') });
  prs(P, sdk, 's3', { branch: 'maya/sdk-list-waitlist', mtime: at('2026-09-15 16:10') });
  review(P, sdk, 's1', BR, { mtime: at('2026-09-15 09:50'), viewed: ['src/types.ts'] });
  review(P, sdk, 's2', BR, {
    mtime: at('2026-09-15 15:38'),
    viewed: ['src/resources/bookings.ts', 'test/waitlist.test.ts'],
    threads: [
      thread(sdk, 's2', 'retry', {
        file: 'src/resources/bookings.ts',
        line: "/** Leave a class's waitlist. Leaving one you're not on is fine. */",
        resolved: true,
        comments: [
          { at: at('2026-09-15 15:12'), body: "The client retries DELETEs on 502/503, so \"leaving one you're not on is fine\" is load-bearing: a retried leave has to succeed. Is that tested anywhere?" },
          { by: 'claude', at: at('2026-09-15 15:20'), body: 'It is now: `retries a leave on 503, since leaving twice is harmless` in `test/waitlist.test.ts` checks the client makes three attempts. The API side is `LeaveWaitlist`, which updates no rows (and returns 204) when you\'re not on the list.' },
        ],
      }),
    ],
  });
  review(P, sdk, 's3', BR, {
    mtime: at('2026-09-16 09:30'),
    viewed: ['CHANGELOG.md'],
    threads: [
      thread(sdk, 's3', 'optional', {
        file: 'src/resources/bookings.ts',
        line: 'listMine(): Promise<{ bookings: Booking[]; waitlist: WaitlistPlace[] }> {',
        comments: [
          { at: at('2026-09-16 09:12'), body: "The API only has waitlists for studios with the flag on. Should `waitlist` be optional here, so nobody's code assumes it's there?" },
          { by: 'claude', at: at('2026-09-16 09:21'), body: "The API always returns `waitlist`, as an empty list when you're on none, flag or not: the flag only gates joining. So it's safe to keep it required. I can add a line to the CHANGELOG saying it's always present, if that helps." },
        ],
      }),
    ],
  });

  // ---------------- orchard-web
  prs(P, web, 'w1', { status: 'ready', branch: 'maya/web-join-button', mtime: at('2026-09-16 14:00') });
  prs(P, web, 'w2', { branch: 'maya/web-waitlist-position', mtime: at('2026-09-16 14:00') });
  review(P, web, 'w1', BR, {
    mtime: at('2026-09-16 13:55'),
    viewed: ['src/pages/Schedule.tsx', 'src/styles.css'],
    threads: [
      thread(web, 'w1', 'a11y', {
        file: 'src/components/ClassCard.tsx',
        line: '<button className="secondary" disabled={busy} onClick={() => run(onJoinWaitlist)}>',
        to: '</button>',
        comments: [
          { at: at('2026-09-16 13:40'), body: 'A screen reader hears "Join waitlist, button" with no idea the class is full. The spots line already has an id, so `` aria-describedby={`spots-${cls.id}`} `` would read "Full" after it.' },
          { by: 'claude', at: at('2026-09-16 13:47'), body: 'Good idea; I\'ll add it to both buttons (Book then reads "3 of 12 left"). The length of the line isn\'t in the schedule response yet. If you want that read out too, I can add `waitlist_length` to the API\'s class JSON.' },
        ],
      }),
    ],
  });
  review(P, web, 'w3', BR, {
    mtime: at('2026-09-16 14:20'),
    viewed: ['src/styles.css'],
    threads: [
      thread(web, 'w3', 'how-long', {
        file: 'src/pages/MyBookings.tsx',
        line: "<p>A spot opened up and it's yours if you want it.</p>",
        resolved: true,
        comments: [
          { at: at('2026-09-16 14:08'), body: "This needs to say how long they have, or people will leave it until after class." },
          { by: 'claude', at: at('2026-09-16 14:15'), body: 'Done in the next commit, "Explain the hold window in the offer banner", so this one stays a UI change and the wording can be reviewed with June on its own.' },
        ],
      }),
    ],
  });

  // ---------------- orchard-infra
  prs(P, infra, 'i1', { status: 'ready', branch: 'maya/infra-sweep-cron', mtime: at('2026-09-17 15:00') });
  prs(P, infra, 'i2', { branch: 'maya/infra-sweep-alert', mtime: at('2026-09-17 15:00') });
  review(P, infra, 'i1', BR, {
    mtime: at('2026-09-17 14:52'),
    viewed: ['k8s/api/cronjobs.yaml'],
    threads: [
      thread(infra, 'i1', 'cadence', {
        file: 'k8s/api/cronjobs.yaml',
        line: 'schedule: "*/5 * * * *"',
        comments: [
          { at: at('2026-09-17 14:30'), body: 'Every five minutes means a hold can run up to five minutes past its two hours, while the email gives an exact time. Should the sweep run every minute instead?' },
          {
            by: 'claude',
            at: at('2026-09-17 14:41'),
            body: "I'd keep five minutes. The time in the email is exact for the member: the API refuses an accept once `hold_until` has passed (`TakeOffer` checks it). What can be up to five minutes late is only the hand-off to the next person. Every minute would be 1,440 job pods a day for a sweep that usually finds nothing.",
          },
        ],
      }),
    ],
  });
  review(P, infra, 'i3', BR, { mtime: at('2026-09-17 15:10'), viewed: ['flags/flags.yaml'] });

  // ======================================================================== calendar-feed (one repo, no stacks)
  const C = slug('calendar-feed');
  out.push({
    path: `projects/${C}/project.yaml`,
    mtime: at('2026-09-11 16:00'),
    content: `title: Calendar feed
description: |
  Theo's private iCalendar feed of each member's bookings, so classes show up in their own calendar app.
repos:
  - path: ${repoPath('orchard-api')}
    branch: theo/calendar-feed
    base: origin/main
`,
  });
  const cal1 = 'Add an iCalendar encoder for bookings';
  const cal2Key = api.commits.find((c) => c.subject.startsWith('Serve a private calendar feed'))!.key;
  prs(C, api, cal1, { status: 'ready', mtime: at('2026-09-11 15:20') });
  review(C, api, cal1, 'theo/calendar-feed', {
    mtime: at('2026-09-11 15:18'),
    viewed: ['internal/ical/ical.go', 'internal/ical/ical_test.go'],
    threads: [
      thread(api, cal1, 'fold', {
        file: 'internal/ical/ical.go',
        line: 'for len(s) > 75 {',
        resolved: true,
        comments: [
          { at: at('2026-09-11 15:02'), body: 'This folds at 75 *bytes*, which can split a multi-byte character (a coach called Zoë). Calendar apps are mostly forgiving, but it\'s easy to fold on a rune boundary.' },
          { by: 'claude', at: at('2026-09-11 15:10'), body: "Right: RFC 5545 counts octets, but it says not to split a UTF-8 sequence. I'll back up to the last rune start before the 75th byte, and add Zoë to the test." },
        ],
      }),
    ],
  });
  review(C, api, cal2Key, 'theo/calendar-feed', {
    mtime: at('2026-09-11 15:45'),
    viewed: ['migrations/0005_calendar_tokens.sql'],
    threads: [
      thread(api, cal2Key, 'unauth', {
        file: 'internal/httpapi/router.go',
        line: 'r.Get("/calendar/{token}", h.calendarFeed)',
        comments: [
          { at: at('2026-09-11 15:40'), body: "Outside the auth group, by design (calendar apps can't send a bearer token). With 32 random bytes guessing is hopeless, but a leaked URL can be polled forever. Should a token expire if nothing fetches it for a few months?" },
        ],
      }),
    ],
  });

  // ======================================================================== calendar-reminders (builds on calendar-feed)
  // Linked projects: Theo's follow-up is its own project, `after:` the calendar feed. Its branch sits on top of
  // theo/calendar-feed in orchard-api, so its range starts where the feed's ends.
  const R = slug('calendar-reminders');
  out.push({
    path: `projects/${R}/project.yaml`,
    mtime: at('2026-09-13 17:00'),
    content: `title: Calendar reminders
description: |
  Theo's follow-up to the calendar feed: each class in the feed gets a reminder, an hour before by
  default, and members can change or turn off the reminder time.
# builds on the calendar feed: in orchard-api this range starts where that one ends (theo/calendar-feed)
after: ${C}
repos:
  - path: ${repoPath('orchard-api')}
    branch: theo/calendar-reminders
    base: origin/main
    stacks:
      - title: Reminders
        color: purple
        description: |
          Alarms in the feed, an hour before every class. Goes up on top of the calendar feed's last PR.
      - title: Reminder settings
        color: teal
        starts_at: "Let members choose their reminder time"
`,
  });
  const rem1 = 'Add reminder alarms to calendar events';
  prs(R, api, rem1, { status: 'ready', branch: 'theo/calendar-alarms', mtime: at('2026-09-12 14:10') });
  prs(R, api, 'Remind members an hour before each class', { branch: 'theo/calendar-remind-hour', mtime: at('2026-09-12 14:12') });
  review(R, api, rem1, 'theo/calendar-reminders', {
    mtime: at('2026-09-13 17:30'),
    viewed: ['internal/ical/ical_test.go'],
    threads: [
      thread(api, rem1, 'trigger', {
        file: 'internal/ical/ical.go',
        line: 'line(fmt.Sprintf("TRIGGER:-PT%dM", int(e.Remind/time.Minute)))',
        comments: [
          { at: at('2026-09-13 17:20'), body: 'A reminder under a minute (say `Remind: 30 * time.Second`) writes `-PT0M`, which most apps treat as "at the start". Round up to a minute, or refuse anything shorter?' },
        ],
      }),
    ],
  });

  // ======================================================================== webhook-retries (archived: all landed)
  const W = slug('webhook-retries');
  out.push({
    path: `projects/${W}/project.yaml`,
    mtime: at('2026-08-06 17:10'),
    content: `title: Payment webhook retries
description: |
  Sam's fix for payment webhooks that were lost when processing failed: store every delivery first,
  retry failures with backoff, and list the ones that never succeed for staff. Went up as GitHub
  stack #87 and merged in August; kept here for reference.
repos:
  - path: ${repoPath('orchard-api')}
    base: origin/main
    github_stack: 87
    landed: ["${api.sha('Record webhook deliveries before processing them').slice(0, 12)}", "${api.sha('Retry failed deliveries with exponential backoff').slice(0, 12)}", "${api.sha('List deliveries that keep failing for staff').slice(0, 12)}"]
    stacks:
      - title: Webhook retries
        color: green
        starts_at: "Record webhook deliveries before processing them"
`,
  });
  const merged = [
    { key: 'Record webhook deliveries before processing them', n: 88, branch: 'sam/webhook-deliveries', base: 'Document the API error codes', merge: 'merge #88', at: '2026-08-04 14:12' },
    { key: 'Retry failed deliveries with exponential backoff', n: 89, branch: 'sam/webhook-retry', base: 'merge #88', merge: 'merge #89', at: '2026-08-05 09:31', on: 'sam/webhook-deliveries' },
    { key: 'List deliveries that keep failing for staff', n: 90, branch: 'sam/webhook-dead-letters', base: 'merge #89', merge: 'merge #90', at: '2026-08-06 16:47', on: 'sam/webhook-retry' },
  ];
  for (const m of merged)
    prs(W, api, m.key, {
      status: 'ready',
      branch: m.branch,
      github: gh('orchard-api', m.n, m.branch, 'main', at('2026-07-30 11:00'), 87, m.on),
      landed: { head: api.sha(m.key), base: api.sha(m.base), commit: api.sha(m.merge), method: 'merge', at: at(m.at) },
      mtime: at(m.at),
    });
  review(W, api, merged[1].key, undefined, {
    mtime: at('2026-07-30 10:40'),
    viewed: ['internal/payments/retry.go', 'internal/payments/retry_test.go'],
    threads: [
      thread(api, merged[1].key, 'cap', {
        file: 'internal/payments/retry.go',
        line: 'd := 30 * time.Second << min(max(attempts-1, 0), 7)',
        resolved: true,
        comments: [
          { at: at('2026-07-30 10:12'), body: "Does this overflow for large `attempts`? A `Duration` shifted left 40 times isn't an hour any more, it's negative." },
          { by: 'claude', at: at('2026-07-30 10:20'), body: 'It would have, from about 40. `DueDeliveries` never lists a delivery past `MaxAttempts` (8), but `Backoff` shouldn\'t rely on its caller, so the shift is now clamped at 7 (an hour is reached at 8 anyway), and `TestBackoff` covers 30 attempts.' },
        ],
      }),
    ],
  });

  return out;
}
