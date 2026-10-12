// The sidebar's width: its limits, reading back what was saved, and resizing it from the keyboard.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_STEP, clampSidebar, keyResize, readSidebarWidth, sidebarMax } from '../src/sidebarWidth.ts';

describe('the sidebar width limits', () => {
  test('at most half the window, and never past the cap', () => {
    assert.equal(sidebarMax(1000), 500);
    assert.equal(sidebarMax(1001), 500);
    assert.equal(sidebarMax(2400), SIDEBAR_MAX);
  });
  test('a window too small for half of it to be the minimum still allows the minimum', () => {
    assert.equal(sidebarMax(300), SIDEBAR_MIN);
    assert.equal(clampSidebar(250, 300), SIDEBAR_MIN);
  });
  test('clamps to the limits, in whole pixels', () => {
    assert.equal(clampSidebar(50, 1500), SIDEBAR_MIN);
    assert.equal(clampSidebar(10_000, 1500), SIDEBAR_MAX);
    assert.equal(clampSidebar(700, 1000), 500);
    assert.equal(clampSidebar(321.6, 1500), 322);
  });
  test('anything not a number is the default', () => {
    for (const v of [null, undefined, '400', NaN, Infinity, {}]) assert.equal(clampSidebar(v, 1500), SIDEBAR_DEFAULT);
  });
});

describe('reading the saved width', () => {
  test('nothing saved: the default', () => assert.equal(readSidebarWidth(null, 1500), SIDEBAR_DEFAULT));
  test('a saved width comes back, clamped to the window', () => {
    assert.equal(readSidebarWidth('420', 1500), 420);
    assert.equal(readSidebarWidth('580', 1000), 500);
    assert.equal(readSidebarWidth('120', 1500), SIDEBAR_MIN);
  });
  test('garbage is the default', () => {
    for (const v of ['', 'wide', '"420"', '{"w":1}', 'null']) assert.equal(readSidebarWidth(v, 1500), SIDEBAR_DEFAULT);
  });
});

describe('resizing from the keyboard', () => {
  test('← and → step, Shift steps further', () => {
    assert.equal(keyResize(300, 'ArrowRight', false, 1500), 300 + SIDEBAR_STEP);
    assert.equal(keyResize(300, 'ArrowLeft', false, 1500), 300 - SIDEBAR_STEP);
    assert.equal(keyResize(300, 'ArrowRight', true, 1500), 300 + 4 * SIDEBAR_STEP);
  });
  test('steps stop at the limits', () => {
    assert.equal(keyResize(SIDEBAR_MIN + 4, 'ArrowLeft', false, 1500), SIDEBAR_MIN);
    assert.equal(keyResize(495, 'ArrowRight', true, 1000), 500);
  });
  test('Home and End go to the limits', () => {
    assert.equal(keyResize(400, 'Home', false, 1500), SIDEBAR_MIN);
    assert.equal(keyResize(300, 'End', false, 1000), 500);
  });
  test('other keys leave it alone', () => {
    for (const k of ['ArrowUp', 'Enter', 'j', ' ']) assert.equal(keyResize(300, k, false, 1500), null);
  });
});
