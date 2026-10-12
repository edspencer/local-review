// Autosaved drafts (src/drafts.ts): keys, the debounced write, restoring, the clear rules, conflicts, rebases, expiry,
// the size cap, other tabs, and storage that's full or missing.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_MAX_AGE,
  DRAFT_PREFIX,
  DraftStore,
  adoptable,
  draftKey,
  hasChanges,
  inConflict,
  matchesSaved,
  parseDraft,
  relocateAt,
  relocateLine,
  type DraftId,
  type DraftRecord,
  type StorageLike,
} from '../src/drafts.ts';

/** localStorage, in memory: `quota` (in chars of keys and values) makes setItem throw like a full one. */
class FakeStorage implements StorageLike {
  map = new Map<string, string>();
  quota = Infinity;
  broken = false;
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.broken) throw new Error('SecurityError');
    const used = [...this.map].reduce((n, [a, b]) => n + (a === k ? 0 : a.length + b.length), 0);
    if (used + k.length + v.length > this.quota) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  drafts() {
    return [...this.map.keys()].filter((k) => k.startsWith(DRAFT_PREFIX));
  }
}

/** A clock and timers the test moves by hand. */
function fakeTime(start = Date.UTC(2026, 9, 12, 10, 42)) {
  let t = start;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    now: () => t,
    schedule: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    cancel: (id: unknown) => {
      timers = timers.filter((x) => x.id !== id);
    },
    advance(ms: number) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers = timers.filter((x) => x.at > t);
      for (const x of due) x.fn();
    },
  };
}

function setup(storage: StorageLike | null = new FakeStorage(), opts: { maxChars?: number } = {}) {
  const time = fakeTime();
  const store = new DraftStore(storage, { now: time.now, schedule: time.schedule, cancel: time.cancel, delay: 400, ...opts });
  return { store, time, storage: storage as FakeStorage };
}

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const body: DraftId = { kind: 'body', project: 'p', repo: 'api', sha: SHA };
const comment: DraftId = { kind: 'comment', project: 'p', repo: 'api', sha: SHA };
const inline = (line: number, start_line?: number): DraftId => ({ kind: 'inline', project: 'p', repo: 'api', sha: SHA, at: { path: 'src/a.ts', side: 'right', line, start_line } });

describe('draft keys', () => {
  test('every text box has its own key, by project, repo, commit and field or thread', () => {
    const keys = [
      draftKey({ kind: 'title', project: 'p', repo: 'api', sha: SHA }),
      draftKey(body),
      draftKey({ ...body, sha: OTHER }),
      draftKey({ ...body, repo: 'web' }),
      draftKey({ ...body, project: 'q' }),
      draftKey(comment),
      draftKey({ kind: 'reply', project: 'p', repo: 'api', sha: SHA, thread: 't1' }),
      draftKey({ kind: 'reply', project: 'p', repo: 'api', sha: SHA, thread: 't2' }),
      draftKey({ kind: 'edit', project: 'p', repo: 'api', sha: SHA, thread: 't1', comment: 'c1' }),
      draftKey({ kind: 'intro', project: 'p' }),
      draftKey({ kind: 'stack', project: 'p', repo: 'api', stack: { number: 1, title: 'Groundwork' } }),
      draftKey({ kind: 'stack', project: 'p', repo: 'api', stack: { number: 2, title: 'Groundwork' } }),
      draftKey(inline(10)),
      draftKey(inline(10, 8)),
      draftKey({ ...inline(10), at: { path: 'src/a.ts', side: 'left', line: 10 } }),
      draftKey({ ...inline(10), at: { path: 'src/b.ts', side: 'right', line: 10 } }),
    ];
    assert.equal(new Set(keys).size, keys.length);
    for (const k of keys) assert.ok(k.startsWith(DRAFT_PREFIX));
  });
  test('parts are encoded, so a slash or colon in a name never runs into the next part', () => {
    assert.notEqual(draftKey({ kind: 'intro', project: 'a/b' }), draftKey({ kind: 'body', project: 'a', repo: 'b' }));
    assert.match(draftKey({ ...inline(3), at: { path: 'dir/x y.ts', side: 'right', line: 3 } }), /dir%2Fx%20y\.ts/);
  });
  test('facts that are not identity (patch-id, subject) are not part of the key', () => {
    assert.equal(draftKey({ ...body, patchId: 'x', subject: 'y' } as DraftId), draftKey(body));
  });
});

describe('what counts as a change', () => {
  test('a description only differs if it would save differently (trailing whitespace is not a change)', () => {
    assert.equal(hasChanges({ kind: 'body', text: 'Hello\n\n', base: 'Hello' }), false);
    assert.equal(hasChanges({ kind: 'body', text: 'Hello!', base: 'Hello' }), true);
    assert.equal(hasChanges({ kind: 'title', text: '  Fix it ', base: 'Fix it' }), false);
  });
  test('an empty or blank comment box has nothing in it', () => {
    assert.equal(hasChanges({ kind: 'comment', text: '  \n', base: '' }), false);
    assert.equal(hasChanges({ kind: 'reply', text: 'ok', base: '' }), true);
  });
  test('a draft matching what is saved now has nothing to keep', () => {
    assert.equal(matchesSaved({ kind: 'body', text: 'New text\n' }, 'New text'), true);
  });
});

describe('the debounced write', () => {
  test('typing is written once, a moment after the last keystroke', () => {
    const { store, time, storage } = setup();
    let writes = 0;
    const set = storage.setItem.bind(storage);
    storage.setItem = (k, v) => { writes++; set(k, v); };
    for (const t of ['H', 'He', 'Hel', 'Hell', 'Hello']) {
      store.put(comment, { text: t, base: '' });
      time.advance(100);
    }
    assert.equal(writes, 0);
    time.advance(400);
    assert.equal(writes, 1);
    assert.equal(parseDraft(storage.getItem(draftKey(comment)))?.text, 'Hello');
  });
  test('flush() writes at once (the page is going away)', () => {
    const { store, storage } = setup();
    store.put(comment, { text: 'Hi', base: '' });
    store.flush();
    assert.equal(parseDraft(storage.getItem(draftKey(comment)))?.text, 'Hi');
  });
  test('it keeps the text, the saved text it started from, and when', () => {
    const { store, time, storage } = setup();
    store.put({ ...body, patchId: 'pid', subject: 'Add retries' }, { text: 'Old', base: 'Old' });
    time.advance(1000);
    store.put(body, { text: 'New' });
    store.flush();
    const r = parseDraft(storage.getItem(draftKey(body)))!;
    assert.equal(r.text, 'New');
    assert.equal(r.base, 'Old');
    assert.equal(r.patchId, 'pid');
    assert.equal(r.subject, 'Add retries');
    assert.equal(r.saved - r.created, 1000);
  });
});

describe('restoring after a reload', () => {
  test('a new store reads the drafts back, marked restored', () => {
    const storage = new FakeStorage();
    const a = setup(storage);
    a.store.put(inline(12, 10), { text: 'Why not a map?', base: '' });
    a.store.flush();
    const b = setup(storage);
    b.store.load();
    const key = draftKey(inline(12, 10));
    assert.equal(b.store.get(key)?.text, 'Why not a map?');
    assert.deepEqual(b.store.get(key)?.at, { path: 'src/a.ts', side: 'right', line: 12, start_line: 10 });
    assert.equal(b.store.isRestored(key), true);
  });
  test('a draft started in this page is not "restored"', () => {
    const { store } = setup();
    store.load();
    assert.equal(store.isRestored(store.put(comment, { text: 'x', base: '' })), false);
  });
  test('garbage, other formats and misfiled entries are dropped; other localStorage keys are left alone', () => {
    const storage = new FakeStorage();
    storage.setItem(`${DRAFT_PREFIX}junk`, '{not json');
    storage.setItem(`${DRAFT_PREFIX}old`, JSON.stringify({ v: 0, text: 'x' }));
    const real = { v: 1, kind: 'comment', project: 'p', repo: 'api', sha: SHA, text: 'x', base: '', created: 1, saved: Date.UTC(2026, 9, 12) };
    storage.setItem(`${DRAFT_PREFIX}elsewhere`, JSON.stringify(real));
    storage.setItem('lr.sidebarWidth', '320');
    const { store } = setup(storage);
    store.load();
    assert.deepEqual(storage.drafts(), []);
    assert.equal(storage.getItem('lr.sidebarWidth'), '320');
    assert.equal(store.all().length, 0);
  });
});

describe('when a draft is cleared', () => {
  test('saved, cancelled or discarded: remove() takes it out of memory and storage at once', () => {
    const { store, storage } = setup();
    const key = store.put(comment, { text: 'Looks good', base: '' });
    store.flush();
    store.remove(key);
    assert.equal(store.has(key), false);
    assert.equal(storage.getItem(key), null);
  });
  test('removing before the timer fires means nothing is written later', () => {
    const { store, time, storage } = setup();
    const key = store.put(comment, { text: 'x', base: '' });
    store.remove(key);
    time.advance(1000);
    assert.equal(storage.getItem(key), null);
  });
  test('an untouched editor stays open in memory but leaves nothing in storage', () => {
    const { store, time, storage } = setup();
    const key = store.put(body, { text: 'Saved text', base: 'Saved text' });
    time.advance(1000);
    assert.equal(store.has(key), true);
    assert.equal(storage.getItem(key), null);
  });
  test('editing back to the saved text takes it out of storage', () => {
    const { store, storage } = setup();
    const key = store.put(body, { text: 'Changed', base: 'Saved' });
    store.flush();
    assert.ok(storage.getItem(key));
    store.put(body, { text: 'Saved' });
    assert.equal(storage.getItem(key), null);
  });
  test('a failed save clears nothing: only the caller removes it, after a successful one', () => {
    const { store, storage } = setup();
    const key = store.put(comment, { text: 'Important', base: '' });
    store.flush();
    // (the save fails: nobody calls remove)
    assert.equal(parseDraft(storage.getItem(key))?.text, 'Important');
  });
});

describe('conflicts', () => {
  test('saved text changed under a draft with changes: a conflict', () => {
    assert.equal(inConflict({ kind: 'body', text: 'Mine', base: 'Original' }, 'Theirs'), true);
  });
  test('no conflict if the saved text is unchanged, the draft is untouched, or both say the same', () => {
    assert.equal(inConflict({ kind: 'body', text: 'Mine', base: 'Original' }, 'Original'), false);
    assert.equal(inConflict({ kind: 'body', text: 'Original', base: 'Original' }, 'Theirs'), false);
    assert.equal(inConflict({ kind: 'body', text: 'Same', base: 'Original' }, 'Same\n'), false);
  });
  test('a restored draft still knows what it started from, so a change made meanwhile shows as one', () => {
    const storage = new FakeStorage();
    const a = setup(storage);
    a.store.put(body, { text: 'Mine', base: 'Original' });
    a.store.flush();
    const b = setup(storage);
    b.store.load();
    assert.equal(inConflict(b.store.get(draftKey(body))!, 'Edited by an agent'), true);
  });
});

describe('expiry and the size cap', () => {
  test('drafts untouched for 30 days are dropped on load', () => {
    const storage = new FakeStorage();
    const a = setup(storage);
    a.store.put(comment, { text: 'old', base: '' });
    a.store.flush();
    const later = new DraftStore(storage, { now: () => a.time.now() + DRAFT_MAX_AGE + 1 });
    later.load();
    assert.equal(later.all().length, 0);
    assert.deepEqual(storage.drafts(), []);
  });
  test('past the cap, the oldest drafts go first; the one just written stays', () => {
    const { store, time, storage } = setup(new FakeStorage(), { maxChars: 1500 });
    const ids = [1, 2, 3, 4].map((n) => ({ kind: 'reply', project: 'p', repo: 'api', sha: SHA, thread: `t${n}` }) as DraftId);
    for (const id of ids) {
      store.put(id, { text: 'x'.repeat(200), base: '' });
      store.flush();
      time.advance(1000);
    }
    const left = storage.drafts().map((k) => parseDraft(storage.getItem(k))!.thread).sort();
    assert.ok(left.length < 4, `some were pushed out: ${left}`);
    assert.ok(left.includes('t4'));
    assert.ok(!left.includes('t1'));
    assert.equal(storage.drafts().reduce((n, k) => n + k.length + storage.getItem(k)!.length, 0) <= 1500, true);
  });
  test('a draft too big for the cap on its own is not kept (and says so), and pushes nothing else out', () => {
    const { store, storage } = setup(new FakeStorage(), { maxChars: 1000 });
    const small = store.put(comment, { text: 'small', base: '' });
    store.flush();
    const big = store.put(body, { text: 'y'.repeat(2000), base: '' });
    store.flush();
    assert.equal(storage.getItem(big), null);
    assert.ok(storage.getItem(small));
    assert.equal(store.isUnkept(big), true);
    assert.equal(store.unsaved(), true);
    assert.equal(store.get(big)?.text.length, 2000, 'still in the editor');
  });
});

describe('storage that is full or missing', () => {
  test('full: the oldest other drafts make room, then it is written', () => {
    const storage = new FakeStorage();
    const { store, time } = setup(storage);
    store.put({ ...comment, sha: OTHER }, { text: 'z'.repeat(300), base: '' });
    store.flush();
    time.advance(1000);
    storage.quota = storage.drafts().reduce((n, k) => n + k.length + storage.getItem(k)!.length, 0) + 100;
    const key = store.put(comment, { text: 'w'.repeat(250), base: '' });
    store.flush();
    assert.ok(storage.getItem(key));
    assert.equal(store.isUnkept(key), false);
    assert.equal(store.unsaved(), false);
  });
  test('full with nothing to drop: the draft stays in the page, marked not kept, and leaving warns', () => {
    const storage = new FakeStorage();
    storage.quota = 10;
    const { store } = setup(storage);
    const key = store.put(comment, { text: 'This will not fit', base: '' });
    store.flush();
    assert.equal(store.isUnkept(key), true);
    assert.equal(store.unsaved(), true);
    assert.equal(store.get(key)?.text, 'This will not fit');
    storage.quota = Infinity; // room again: the next flush (a timer, or the page going away) writes it
    store.flush();
    assert.equal(store.unsaved(), false);
    assert.equal(parseDraft(storage.getItem(key))?.text, 'This will not fit');
  });
  test('a draft that could not be written is never replaced from storage (letting go of it, or another tab)', () => {
    const storage = new FakeStorage();
    storage.quota = 10;
    const { store } = setup(storage);
    const key = store.put(comment, { text: 'Only copy', base: '' });
    store.hold(key);
    store.flush();
    store.release(key); // storage has nothing for it: that mustn't read as "saved elsewhere"
    assert.equal(store.get(key)?.text, 'Only copy');
    store.external(key, null);
    assert.equal(store.get(key)?.text, 'Only copy');
  });
  test('storage that throws on every write (blocked) behaves like a full one', () => {
    const storage = new FakeStorage();
    storage.broken = true;
    const { store } = setup(storage);
    store.put(comment, { text: 'x', base: '' });
    store.flush();
    assert.equal(store.unsaved(), true);
  });
  test('no storage at all: drafts live as long as the page, and leaving warns only while one has changes', () => {
    const { store } = setup(null);
    store.load();
    const key = store.put(body, { text: 'Same', base: 'Same' });
    assert.equal(store.unsaved(), false);
    store.put(body, { text: 'Changed' });
    store.flush();
    assert.equal(store.unsaved(), true);
    assert.equal(store.persistent, false);
    store.remove(key);
    assert.equal(store.unsaved(), false);
  });
  test('with drafts kept, leaving does not warn', () => {
    const { store } = setup();
    store.put(comment, { text: 'kept', base: '' });
    store.flush();
    assert.equal(store.unsaved(), false);
  });
});

describe('two tabs', () => {
  function twoTabs() {
    const storage = new FakeStorage();
    const a = setup(storage);
    const b = setup(storage);
    // the storage event: what one tab wrote, as the other tab hears of it
    const send = (to: DraftStore, key: string) => to.external(key, storage.getItem(key));
    return { a, b, storage, send };
  }
  test('a change in one tab shows up in the other (last write wins)', () => {
    const { a, b, send } = twoTabs();
    const key = a.store.put(comment, { text: 'from A', base: '' });
    a.store.flush();
    send(b.store, key);
    assert.equal(b.store.get(key)?.text, 'from A');
    b.store.put(comment, { text: 'from B' });
    b.store.flush();
    send(a.store, key);
    assert.equal(a.store.get(key)?.text, 'from B');
  });
  test('an editor being typed in is not clobbered; it takes the other tab\'s text when let go, if it has none of its own', () => {
    const { a, b, send, storage } = twoTabs();
    const key = a.store.put(comment, { text: 'mine', base: '' });
    a.store.flush();
    send(b.store, key);
    a.store.hold(key);
    b.store.put(comment, { text: 'theirs' });
    b.store.flush();
    send(a.store, key);
    assert.equal(a.store.get(key)?.text, 'mine');
    a.store.release(key);
    assert.equal(a.store.get(key)?.text, 'theirs');
    assert.equal(parseDraft(storage.getItem(key))?.text, 'theirs');
  });
  test('this tab\'s own change still to be written wins over the other tab\'s', () => {
    const { a, b, send, storage } = twoTabs();
    const key = b.store.put(comment, { text: 'theirs', base: '' });
    b.store.flush();
    a.store.put(comment, { text: 'mine, typing', base: '' });
    send(a.store, key);
    assert.equal(a.store.get(key)?.text, 'mine, typing');
    a.store.flush();
    assert.equal(parseDraft(storage.getItem(key))?.text, 'mine, typing');
  });
  test('saved in the other tab: the draft goes here too, but an untouched editor open here stays open', () => {
    const { a, b, send } = twoTabs();
    const key = a.store.put(body, { text: 'Changed', base: 'Saved' });
    a.store.flush();
    send(b.store, key);
    assert.equal(b.store.get(key)?.text, 'Changed');
    a.store.remove(key);
    send(b.store, key);
    assert.equal(b.store.has(key), false);

    const k2 = b.store.put(body, { text: 'Saved', base: 'Saved' }); // just opened, untouched
    b.store.external(k2, null);
    assert.equal(b.store.has(k2), true);
  });
  test('events about other keys are ignored', () => {
    const { a } = twoTabs();
    a.store.external('lr.sidebarWidth', '300');
    a.store.external(null, null);
    assert.equal(a.store.all().length, 0);
  });
});

describe('following a rebase', () => {
  const rec = (over: Partial<DraftRecord>): DraftRecord => ({ v: 1, kind: 'body', project: 'p', repo: 'api', sha: OTHER, text: 'x', base: '', created: 1, saved: 1, ...over });
  const target = { project: 'p', repo: 'api', sha: SHA, patchId: 'pid', subject: 'Add retries' };
  test('a draft on a commit that is gone comes over by patch-id', () => {
    assert.equal(adoptable([rec({ patchId: 'pid' })], target, new Set([SHA])).length, 1);
  });
  test('or by subject (fixup! prefixes ignored), if no gone commit has the patch-id', () => {
    assert.equal(adoptable([rec({ patchId: 'other', subject: 'fixup! Add  retries' })], target, new Set([SHA]), ['Add retries']).length, 1);
  });
  test('not by a subject that two commits share, nor from a commit still in the range', () => {
    assert.equal(adoptable([rec({ subject: 'WIP' })], { ...target, patchId: null, subject: 'WIP' }, new Set([SHA]), ['WIP', 'WIP']).length, 0);
    assert.equal(adoptable([rec({ patchId: 'pid' })], target, new Set([SHA, OTHER])).length, 0);
  });
  test('not from another repo or project', () => {
    assert.equal(adoptable([rec({ patchId: 'pid', repo: 'web' }), rec({ patchId: 'pid', project: 'q' })], target, new Set([SHA])).length, 0);
  });
  test('adopt() moves the drafts onto the new commit, restored, and inline ones follow their line', () => {
    const storage = new FakeStorage();
    const { store } = setup(storage);
    const old: DraftId = { kind: 'inline', project: 'p', repo: 'api', sha: OTHER, at: { path: 'src/a.ts', side: 'right', line: 3, start_line: 2 } };
    store.put({ ...old, patchId: 'pid', lineText: 'const b = 2;' }, { text: 'Why 2?', base: '' });
    store.put({ kind: 'body', project: 'p', repo: 'api', sha: OTHER, patchId: 'pid' }, { text: 'New description', base: 'Old' });
    store.flush();
    const file = '// header\n// more\nconst a = 1;\nconst b = 2;\n';
    const n = store.adopt(target, new Set([SHA]), [], (path, side) => (path === 'src/a.ts' && side === 'right' ? file : null));
    assert.equal(n, 2);
    const moved = store.all().find((r) => r.kind === 'inline')!;
    assert.equal(moved.sha, SHA);
    assert.equal(moved.movedFrom, OTHER);
    assert.deepEqual(moved.at, { path: 'src/a.ts', side: 'right', line: 4, start_line: 3 });
    assert.equal(store.isRestored(draftKey(moved)), true);
    assert.equal(storage.getItem(draftKey(old)), null);
    assert.ok(storage.getItem(draftKey(moved)));
    assert.equal(store.get(draftKey(body))?.base, 'Old', 'its base still says what it started from (so a conflict shows)');
  });
  test('a draft that would land on one already there stays where it was', () => {
    const { store } = setup();
    store.put({ ...comment, sha: OTHER, patchId: 'pid' }, { text: 'old one', base: '' });
    store.put({ ...comment, patchId: 'pid' }, { text: 'new one', base: '' });
    assert.equal(store.adopt(target, new Set([SHA])), 0);
    assert.equal(store.get(draftKey(comment))?.text, 'new one');
    assert.equal(store.get(draftKey({ ...comment, sha: OTHER }))?.text, 'old one');
  });
});

describe('finding a line again', () => {
  const lines = ['a', 'b', 'c', 'b', 'd'];
  test('the same line if its text is still there, else the nearest line with that text', () => {
    assert.equal(relocateLine(lines, 2, 'b'), 2);
    assert.equal(relocateLine(lines, 3, 'b'), 2);
    assert.equal(relocateLine(lines, 5, 'b'), 4);
    assert.equal(relocateLine(lines, 1, 'zzz'), null);
  });
  test('without remembered text, it stays if the file is still that long', () => {
    assert.equal(relocateLine(lines, 5, undefined), 5);
    assert.equal(relocateLine(lines, 6, undefined), null);
  });
  test('a range moves with its end; a line not found stays put', () => {
    assert.deepEqual(relocateAt({ path: 'f', side: 'right', line: 3, start_line: 1 }, 'd', () => lines.join('\n')), { path: 'f', side: 'right', line: 5, start_line: 3 });
    assert.deepEqual(relocateAt({ path: 'f', side: 'right', line: 3 }, 'nope', () => lines.join('\n')), { path: 'f', side: 'right', line: 3 });
  });
});
