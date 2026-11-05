// The counter behind /api/busy (server/busy.ts): what's under way, by kind, for as long as it runs.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { busyCounts, isBusy, trackBusy, whenIdle } from '../server/busy.ts';

describe('busy counts', () => {
  test('a synchronous write counts while it runs, and not after, even if it throws', () => {
    assert.equal(isBusy(), false);
    assert.equal(
      trackBusy('snapshot', () => {
        assert.deepEqual(busyCounts(), { save: 0, snapshot: 1, sync: 0 });
        return 'name';
      }),
      'name',
    );
    assert.throws(() => trackBusy('snapshot', () => {
      throw new Error('disk full');
    }), /disk full/);
    assert.deepEqual(busyCounts(), { save: 0, snapshot: 0, sync: 0 });
  });

  test('an async one counts until its promise settles, resolved or rejected; whenIdle waits for it', async () => {
    let finish!: () => void;
    const a = trackBusy('sync', () => new Promise<void>((r) => (finish = r)));
    const b = trackBusy('save', async () => {
      throw new Error('conflict');
    });
    assert.deepEqual(busyCounts(), { save: 1, snapshot: 0, sync: 1 });
    await assert.rejects(b, /conflict/);
    assert.deepEqual(busyCounts(), { save: 0, snapshot: 0, sync: 1 });
    assert.equal(await whenIdle(20, 5), false, 'still syncing');
    setTimeout(finish, 10);
    assert.equal(await whenIdle(1000, 5), true);
    await a;
    assert.equal(isBusy(), false);
  });
});
