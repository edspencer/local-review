// Who the reviewer is (server/reviewer.ts): the name's source order and the short id stored as `author:`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { resolveReviewer, reviewerId } = await import('../server/reviewer.ts');

describe('reviewer', () => {
  test('LOCAL_REVIEW_USER, then git user.name, then $USER', () => {
    assert.deepEqual(resolveReviewer({ env: 'Ada Lovelace', gitName: 'Grace Hopper\n', user: 'gh' }), { id: 'ada', name: 'Ada Lovelace' });
    assert.deepEqual(resolveReviewer({ env: '  ', gitName: 'Grace Hopper\n', user: 'gh' }), { id: 'grace', name: 'Grace Hopper' });
    assert.deepEqual(resolveReviewer({ gitName: '', user: 'gh' }), { id: 'gh', name: 'gh' });
    assert.deepEqual(resolveReviewer({}), { id: 'reviewer', name: 'reviewer' });
  });

  test('the id is the first word, lowercased, [a-z0-9_-] only; never the agent\'s', () => {
    assert.equal(reviewerId('ada'), 'ada');
    assert.equal(reviewerId('Ada Lovelace'), 'ada');
    assert.equal(reviewerId('first.last'), 'first-last');
    assert.equal(reviewerId('Zoë'), 'zo');
    assert.equal(reviewerId('…'), 'reviewer');
    assert.equal(reviewerId('Claude'), 'reviewer');
    assert.equal(reviewerId('x'.repeat(40)).length, 32);
  });
});
