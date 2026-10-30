// GitHub state for published PRs (shared/github.ts): thread states, the PR link's tone, PR URLs and the query.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { counts, prKey, prRef, prsQuery, snapshotOf, summaryOf, summaryTooltip, threadState, toneOf } from '../shared/github.ts';

const ref = { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 12 };
const c = (login: string | null, body = 'hi') => ({ author: login ? { login } : null, body, createdAt: '2026-10-30T10:00:00Z', url: `https://github.com/Acme/Widgets/pull/12#c-${body}` });
const thread = (o: { resolved?: boolean; outdated?: boolean; by: (string | null)[] }) => ({
  isResolved: !!o.resolved,
  isOutdated: !!o.outdated,
  path: 'src/a.ts',
  line: 7,
  comments: { totalCount: o.by.length, nodes: o.by.map((b, i) => c(b, `t${i}`)) },
  lastComment: { nodes: [c(o.by[o.by.length - 1], 'last')] },
});

describe('github', () => {
  test('a thread is resolved, answered (my last word) or open (theirs), outdated or not', () => {
    assert.equal(threadState(true, 'someone', 'me'), 'resolved');
    assert.equal(threadState(false, 'Me', 'me'), 'answered');
    assert.equal(threadState(false, 'someone', 'me'), 'open');
    assert.equal(threadState(false, null, 'me'), 'open'); // a deleted account's comment is still theirs
    assert.deepEqual(counts([{ state: 'open' }, { state: 'answered' }, { state: 'answered' }, { state: 'resolved' }]), { total: 4, open: 1, answered: 2, resolved: 1 });
  });

  test('a snapshot from the GraphQL node: approvals whatever the push, threads, reviews with a summary, checks', () => {
    const node = {
      number: 12,
      url: 'https://github.com/Acme/Widgets/pull/12',
      title: 'Add widgets',
      state: 'OPEN',
      isDraft: false,
      headRefOid: 'abc',
      baseRefName: 'main',
      reviewDecision: null,
      author: { login: 'me' },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
      latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: { login: 'ana' } }, { state: 'COMMENTED', author: { login: 'bo' } }] },
      reviews: { nodes: [{ state: 'COMMENTED', body: '', author: { login: 'bo' } }, { state: 'APPROVED', body: 'LGTM, one nit', submittedAt: '2026-10-29T09:00:00Z', url: 'u', author: { login: 'ana' } }] },
      comments: { totalCount: 3, nodes: [c('bo'), c('me')] },
      reviewThreads: {
        nodes: [
          thread({ by: ['ana', 'me'] }), // answered
          thread({ by: ['bo'], outdated: true }), // open, though outdated
          thread({ by: ['ana', 'me', 'ana'] }), // open: they replied again
          thread({ by: ['ana', 'me'], resolved: true }),
        ],
      },
    };
    const s = snapshotOf(node, ref, 'me', '2026-10-30T12:00:00Z');
    assert.deepEqual(s.threads.map((t) => [t.state, t.outdated]), [['answered', false], ['open', true], ['open', false], ['resolved', false]]);
    assert.equal(s.threads[0].comments[0].body, 't0');
    assert.equal(s.threads[0].url, 'https://github.com/Acme/Widgets/pull/12#c-t0');
    assert.deepEqual(s.approved_by, ['ana']);
    assert.deepEqual(s.changes_requested_by, []);
    assert.equal(s.checks, 'passing');
    assert.deepEqual(s.reviews.map((r) => [r.author, r.state, r.body]), [['ana', 'APPROVED', 'LGTM, one nit']]);
    assert.equal(s.conversation.length, 2);
    assert.equal(s.conversation_total, 3);
    const sum = summaryOf(s);
    assert.equal(sum.key, 'acme/widgets#12');
    assert.equal(sum.tone, 'approved');
    assert.deepEqual(sum.threads, { total: 4, open: 2, answered: 1, resolved: 1 });
    assert.equal(sum.first_open, s.threads[1].url);
    assert.equal(summaryTooltip(sum), 'GitHub PR #12\nApproved by ana\nChecks passing\n4 threads: 2 open, 1 answered, 1 resolved · 3 comments on the PR');
  });

  test('the tone: red for failing checks or changes requested (red wins), green once approved, none when not open', () => {
    const s = { state: 'open' as const, checks: 'passing' as const, approved_by: ['ana'], changes_requested_by: [] as string[] };
    assert.equal(toneOf(s), 'approved');
    assert.equal(toneOf({ ...s, checks: 'failing' }), 'blocked');
    assert.equal(toneOf({ ...s, changes_requested_by: ['bo'] }), 'blocked');
    assert.equal(toneOf({ ...s, approved_by: [], checks: 'pending' }), null);
    assert.equal(toneOf({ ...s, state: 'merged' }), null);
    // merged / closed come from GitHub's state; an empty node is tolerated
    assert.equal(snapshotOf({ state: 'MERGED', merged: true }, ref, 'me', 't').state, 'merged');
    assert.equal(snapshotOf({ state: 'CLOSED' }, ref, 'me', 't').state, 'closed');
    const empty = snapshotOf(null, ref, 'me', 't');
    assert.equal(empty.url, 'https://github.com/Acme/Widgets/pull/12');
    assert.deepEqual([empty.threads, empty.checks, empty.state], [[], null, 'open']);
  });

  test('PR URLs and keys', () => {
    assert.deepEqual(prRef('https://github.com/Acme/Widgets/pull/12'), ref);
    assert.deepEqual(prRef('https://GHE.example.com/a/b/pull/3/files#x'), { host: 'ghe.example.com', owner: 'a', repo: 'b', number: 3 });
    for (const bad of ['', null, 'https://github.com/a/b/issues/3', 'https://github.com/../b/pull/3', 'https://github.com/a/b/pull/0', 'github.com/a/b/pull/3']) assert.equal(prRef(bad), null, String(bad));
    assert.equal(prKey(ref), 'acme/widgets#12');
  });

  test('the query asks only for the given PRs, by number, and never mutates', () => {
    const q = prsQuery([3, 12]);
    assert.match(q, /^query\(/);
    assert.match(q, /pr3: pullRequest\(number: 3\)/);
    assert.match(q, /pr12: pullRequest\(number: 12\)/);
    assert.doesNotMatch(q, /mutation/i);
    assert.throws(() => prsQuery([1.5]));
    assert.throws(() => prsQuery([0]));
  });
});
