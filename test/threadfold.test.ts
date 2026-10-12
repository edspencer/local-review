// Folding threads in Files changed: which start folded, following resolve / unresolve, and the folded row's text.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_FOLDS, type FoldThread, foldLocation, foldsByDefault, isFolded, reconcileFolds, setFolded, snippet } from '../src/threadFold.ts';

type T = FoldThread & { comments: { id: string; author: string; body: string }[] };
const thread = (id: string, over: Partial<T> = {}): T => ({ id, path: 'internal/booking/promote.go', line: 24, resolved: false, comments: [{ id: 'c1', author: 'maya', body: 'Hello' }], ...over });

describe('which threads start folded', () => {
  test('resolved and outdated ones do; open ones do not', () => {
    assert.equal(foldsByDefault({ resolved: true }), true);
    assert.equal(foldsByDefault({ resolved: false, outdated: true }), true);
    assert.equal(foldsByDefault({ resolved: true, outdated: true }), true);
    assert.equal(foldsByDefault({ resolved: false }), false);
    assert.equal(foldsByDefault({ resolved: false, outdated: false }), false);
  });
  test('first sight: the default, and no override recorded', () => {
    const ts = [thread('a'), thread('b', { resolved: true }), thread('c', { outdated: true })];
    const s = reconcileFolds(NO_FOLDS, ts);
    assert.deepEqual(ts.map((t) => isFolded(s, t)), [false, true, true]);
    assert.deepEqual(s.collapsed, {});
  });
});

describe('folding by hand', () => {
  test('open threads can be folded, folded ones opened', () => {
    const a = thread('a');
    const b = thread('b', { resolved: true });
    let s = reconcileFolds(NO_FOLDS, [a, b]);
    s = setFolded(setFolded(s, 'a', true), 'b', false);
    assert.equal(isFolded(s, a), true);
    assert.equal(isFolded(s, b), false);
  });
  test('setting what it already is returns the same state', () => {
    const s = setFolded(NO_FOLDS, 'a', true);
    assert.equal(setFolded(s, 'a', true), s);
  });
});

describe('resolving and unresolving', () => {
  test('resolving folds the thread, even one opened by hand', () => {
    const a = thread('a');
    let s = setFolded(reconcileFolds(NO_FOLDS, [a]), 'a', false);
    s = reconcileFolds(s, [{ ...a, resolved: true }]);
    assert.equal(isFolded(s, { ...a, resolved: true }), true);
  });
  test('unresolving unfolds it, outdated or not', () => {
    for (const outdated of [false, true]) {
      const a = thread('a', { resolved: true, outdated });
      let s = reconcileFolds(NO_FOLDS, [a]);
      assert.equal(isFolded(s, a), true);
      const b = { ...a, resolved: false };
      s = reconcileFolds(s, [b]);
      assert.equal(isFolded(s, b), false);
    }
  });
  test('nothing changed: the same object back (safe to run every render)', () => {
    const ts = [thread('a'), thread('b', { resolved: true })];
    const s = reconcileFolds(NO_FOLDS, ts);
    assert.equal(reconcileFolds(s, ts), s);
    assert.equal(reconcileFolds(s, ts.map((t) => ({ ...t }))), s);
  });
  test('a fold by hand survives refreshes that do not change resolved', () => {
    const a = thread('a');
    const s = setFolded(reconcileFolds(NO_FOLDS, [a]), 'a', true);
    assert.equal(isFolded(reconcileFolds(s, [thread('a', { comments: [...a.comments, { id: 'c2', author: 'claude', body: 'Done' }] })]), a), true);
  });
});

describe('the folded row', () => {
  test('snippet: one plain line', () => {
    assert.equal(snippet('**This** reads `the class` from\n\nthe [pool](https://x.example), outside'), 'This reads the class from the pool, outside');
    assert.equal(snippet('> quoted\n- item one\n1. item two'), 'quoted item one item two');
    assert.equal(snippet('Look:\n```go\nfunc x() {}\n```\nthen this'), 'Look: then this');
    assert.equal(snippet('![a chart](assets/x.png) <b>bold</b>'), 'a chart bold');
  });
  test('snippet: long text is cut with an ellipsis', () => {
    const s = snippet('word '.repeat(100), 40);
    assert.equal(s.length, 40);
    assert.ok(s.endsWith('…'));
  });
  test('location: base name and line, or range', () => {
    assert.equal(foldLocation(thread('a')), 'promote.go:24');
    assert.equal(foldLocation(thread('a', { start_line: 20 })), 'promote.go:20-24');
    assert.equal(foldLocation(thread('a', { line: undefined })), 'promote.go');
  });
  test('location of an outdated thread: where it was made', () => {
    const t = thread('a', { outdated: true, line: undefined, anchor: { path: 'internal/booking/old.go', line: 12, start_line: 10 } });
    assert.equal(foldLocation(t), 'old.go:10-12');
  });
});
