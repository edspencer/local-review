// From edspencer/cli-contract test/rotate.test.ts @ 0.2; local changes: imports server/contract/ (not reference/service/), and contract-helpers.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rotateLog, startLogRotation } from '../server/contract/rotate.ts';
import { tempDir } from './contract-helpers.ts';

function logIn(dir: string, bytes: number): string {
  const file = path.join(dir, 'service.log');
  fs.writeFileSync(file, 'x'.repeat(bytes));
  return file;
}

test('under the limit, or no log at all: nothing happens', () => {
  const dir = tempDir();
  assert.equal(rotateLog(path.join(dir, 'service.log')), false);
  const file = logIn(dir, 10);
  assert.equal(rotateLog(file, { maxBytes: 10 }), false);
  assert.deepEqual(fs.readdirSync(dir), ['service.log']);
});

test("past the limit: copied to .1 and truncated in place, so the manager's descriptor keeps working", () => {
  const dir = tempDir();
  const file = logIn(dir, 20);
  const fd = fs.openSync(file, 'a');
  const inode = fs.statSync(file).ino;
  try {
    assert.equal(rotateLog(file, { maxBytes: 10 }), true);
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'x'.repeat(20));
    assert.equal(fs.statSync(file).size, 0);
    assert.equal(fs.statSync(file).ino, inode, 'the same file, not a new one');
    fs.writeSync(fd, 'after\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'after\n', 'an O_APPEND write lands at the start of the truncated file');
  } finally {
    fs.closeSync(fd);
  }
});

test('generations shift down and the oldest goes', () => {
  const dir = tempDir();
  const file = path.join(dir, 'service.log');
  for (const n of [1, 2, 3, 4]) {
    fs.writeFileSync(file, String(n).repeat(20));
    rotateLog(file, { maxBytes: 10, keep: 3 });
  }
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), '4'.repeat(20));
  assert.equal(fs.readFileSync(`${file}.2`, 'utf8'), '3'.repeat(20));
  assert.equal(fs.readFileSync(`${file}.3`, 'utf8'), '2'.repeat(20));
  assert.equal(fs.existsSync(`${file}.4`), false);
});

test('a rotation that fails warns and returns false; it never throws', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a folder root and Windows can write to' : false }, () => {
  const dir = tempDir();
  const file = logIn(dir, 20);
  fs.chmodSync(dir, 0o500);
  const warnings: string[] = [];
  try {
    assert.equal(rotateLog(file, { maxBytes: 10, warn: (m) => warnings.push(m) }), false);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.match(warnings[0] ?? '', /^couldn't rotate .*service\.log: /);
});

test('startLogRotation rotates at once, and its timer never keeps the process alive', () => {
  const dir = tempDir();
  const file = logIn(dir, 20);
  const stop = startLogRotation(file, { maxBytes: 10, everyMs: 60_000 });
  stop();
  assert.equal(fs.statSync(file).size, 0);
  assert.ok(fs.existsSync(`${file}.1`));
});
