// Aggregates over PR stacks (shared/totals.ts), as shown by the stack picture and the UI: follow-on stacks are left
// out of the totals and mentioned beside them.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, followOnNote, mergeAggregates, summary } from '../shared/totals.ts';
import { repoLabel } from '../shared/repoLabel.ts';

const s = (prs: number, additions: number, deletions: number, follow_on?: boolean) => ({ prs, additions, deletions, ...(follow_on ? { follow_on } : {}) });

describe('totals', () => {
  test('follow-on stacks are counted on the side, not in the totals; empty stacks are skipped', () => {
    const a = aggregate([s(4, 1095, 6), s(3, 934, 8), s(0, 0, 0), s(2, 585, 14, true)]);
    assert.deepEqual(a, { stacks: 2, prs: 7, additions: 2029, deletions: 14, followOn: { stacks: 1, prs: 2, additions: 585, deletions: 14 }, merged: { stacks: 0, prs: 0, additions: 0, deletions: 0 } });
    assert.equal(followOnNote(a), '+1 follow-on stack (2 PRs)');
    assert.equal(followOnNote(aggregate([s(1, 1, 1)])), null);
    assert.equal(followOnNote(aggregate([s(1, 1, 1, true), s(2, 1, 1, true)])), '+2 follow-on stacks (3 PRs)');
  });

  test('project and repo summary lines', () => {
    // a project: my-service (3 stacks + a follow-on) and my-client (1 stack)
    const service = aggregate([s(4, 1000, 10), s(3, 900, 5), s(4, 1300, 120), s(2, 500, 10, true)]);
    const client = aggregate([s(1, 100, 15)]);
    const project = mergeAggregates([service, client]);
    assert.deepEqual(summary(project, 2), { counts: '2 repos · 4 stacks · 12 PRs', additions: 3300, deletions: 150, note: '+1 follow-on stack (2 PRs)', merged: null });
    assert.deepEqual(summary(service), { counts: '11 PRs', additions: 3200, deletions: 135, note: '+1 follow-on stack (2 PRs)', merged: null });
    assert.deepEqual(summary(client), { counts: '1 PR', additions: 100, deletions: 15, note: null, merged: null });
    // the same whether summed per repo or over all stacks at once
    assert.deepEqual(project, aggregate([s(4, 1000, 10), s(3, 900, 5), s(4, 1300, 120), s(2, 500, 10, true), s(1, 100, 15)]));
    assert.deepEqual(mergeAggregates([]), aggregate([]));
  });

  test('nothing but follow-on work: its own numbers, labelled, instead of zeros', () => {
    const only = aggregate([s(2, 585, 14, true)]);
    assert.deepEqual(summary(only, 1), { counts: '1 repo · 1 follow-on stack · 2 PRs', additions: 585, deletions: 14, note: null, merged: null });
    assert.deepEqual(summary(only), { counts: '2 follow-on PRs', additions: 585, deletions: 14, note: null, merged: null });
    assert.deepEqual(summary(aggregate([]), 1), { counts: '1 repo · 0 stacks · 0 PRs', additions: 0, deletions: 0, note: null, merged: null });
  });

  test('merged PRs are counted on the side, whatever stack they are in; a fully merged stack is not a stack', () => {
    const m = (prs: number, additions: number, deletions: number) => ({ prs, additions, deletions });
    const a = aggregate([{ ...s(3, 300, 30), merged: m(3, 300, 30) }, { ...s(4, 400, 40), merged: m(1, 100, 10) }, s(2, 585, 14, true)]);
    assert.deepEqual(a, { stacks: 1, prs: 3, additions: 300, deletions: 30, followOn: { stacks: 1, prs: 2, additions: 585, deletions: 14 }, merged: { stacks: 1, prs: 4, additions: 400, deletions: 40 } });
    assert.deepEqual(summary(a, 1), { counts: '1 repo · 1 stack · 3 PRs', additions: 300, deletions: 30, note: '+1 follow-on stack (2 PRs)', merged: '+4 merged' });
    assert.deepEqual(summary(aggregate([{ ...s(9, 13020, 127), merged: m(9, 13020, 127) }]), 1), { counts: '1 repo · 1 stack · 9 merged PRs', additions: 13020, deletions: 127, note: null, merged: null });
  });
});

test('repoLabel: the branch, else the range end, else "merged" once PRs have landed, else nothing', () => {
  assert.deepEqual(repoLabel({ branch: 'me/feature', end: 'me/feature' }, 2), { text: 'me/feature', merged: false });
  assert.deepEqual(repoLabel({ branch: null, end: 'abc1234' }, 0), { text: 'abc1234', merged: false });
  assert.deepEqual(repoLabel({ branch: null, end: '' }, 3), { text: 'merged', merged: true });
  assert.equal(repoLabel({ branch: null, end: '' }, 0), null);
});
