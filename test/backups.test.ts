// Automatic snapshots (server/backups.ts) and the no-clobber file helpers (server/safefs.ts).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as B from '../server/backups.ts';
import { atomicWrite, renameNoClobber, renameToBak } from '../server/safefs.ts';
import { tmpDir } from './fixture.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function home() {
  const h = tmpDir('lr-test-backups-');
  dirs.push(h);
  const projects = path.join(h, 'projects');
  const backups = path.join(h, 'backups');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(projects, rel)), { recursive: true });
    fs.writeFileSync(path.join(projects, rel), text);
  };
  return { h, projects, backups, write };
}

const at = (iso: string) => new Date(iso);

describe('snapshots', () => {
  test('names are ISO-like timestamps that sort chronologically', () => {
    assert.equal(B.snapshotName(at('2026-10-09T08:45:12.345Z')), '2026-10-09T08-45-12Z');
    assert.ok(B.SNAPSHOT_NAME.test('2026-10-09T08-45-12Z'));
    assert.ok(B.SNAPSHOT_NAME.test('2026-10-09T08-45-12Z-2'));
    for (const bad of ['', '.', '..', 'projects', '2026-10-09', '../2026-10-09T08-45-12Z', '2026-10-09T08-45-12Z/..', ' 2026-10-09T08-45-12Z', '2026-10-09T08:45:12Z'])
      assert.ok(!B.SNAPSHOT_NAME.test(bad), bad);
  });

  test('copies projects/ byte for byte with mtimes, skips temp files, and only when something changed', () => {
    const { projects, backups, write } = home();
    assert.equal(B.takeSnapshot(projects, backups, at('2026-10-09T08:00:00Z')), null, 'no projects: nothing to back up');
    write('p/project.yaml', 'title: P\n');
    write('p/reviews/r/' + 'a'.repeat(40) + '.yaml', 'threads: []\n');
    write('p/reviews/r/.x.yaml.1.2.abcdef.tmp', 'half');
    const old = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(path.join(projects, 'p/project.yaml'), old, old);
    const s1 = B.takeSnapshot(projects, backups, at('2026-10-09T08:00:00Z'));
    assert.equal(s1, '2026-10-09T08-00-00Z');
    const snap = path.join(backups, s1!);
    assert.equal(fs.readFileSync(path.join(snap, 'p/project.yaml'), 'utf8'), 'title: P\n');
    assert.equal(fs.statSync(path.join(snap, 'p/project.yaml')).mtimeMs, old.getTime());
    assert.ok(!fs.existsSync(path.join(snap, 'p/reviews/r/.x.yaml.1.2.abcdef.tmp')));
    assert.deepEqual(fs.readdirSync(backups), [s1], 'no partial dirs left');

    assert.equal(B.takeSnapshot(projects, backups, at('2026-10-09T09:00:00Z')), null, 'unchanged: skipped');
    write('p/project.yaml', 'title: P2\n');
    assert.equal(B.takeSnapshot(projects, backups, at('2026-10-09T09:00:00Z')), '2026-10-09T09-00-00Z');
    write('p/project.yaml', 'title: P3\n');
    assert.equal(B.takeSnapshot(projects, backups, at('2026-10-09T09:00:00Z')), '2026-10-09T09-00-00Z-2', 'same second: suffixed');
    assert.equal(fs.readFileSync(path.join(backups, '2026-10-09T09-00-00Z/p/project.yaml'), 'utf8'), 'title: P2\n', 'never overwritten');
  });

  test('retention: newest 50, plus the first of each day for 30 days', () => {
    const now = at('2026-10-09T12:00:00Z');
    const names: string[] = [];
    // 3 per day for 40 days
    for (let d = 40; d >= 0; d--)
      for (const h of ['01', '05', '09']) names.push(B.snapshotName(new Date(now.getTime() - d * 86400000)).replace(/T\d\d/, `T${h}`));
    const keep = B.snapshotsToKeep(names, now);
    const sorted = [...names].sort();
    for (const n of sorted.slice(-50)) assert.ok(keep.has(n), `recent ${n}`);
    assert.ok(keep.has('2026-09-09T01-00-00Z'), 'first of the day 30 days ago');
    assert.ok(!keep.has('2026-09-09T05-00-00Z'), 'not the second of that day');
    assert.ok(!keep.has('2026-09-08T01-00-00Z'), 'older than 30 days');
    // newest 50 = the last 16 days and two of the 17th; plus the first of the 15 days from 16 to 30 days ago
    assert.equal(keep.size, 65);
    assert.ok([...keep].every((n) => names.includes(n)));
  });

  test('pruning removes only old snapshot directories, nothing else in backups/', () => {
    const { projects, backups, write } = home();
    write('p/project.yaml', 'title: P\n');
    const now = at('2026-10-09T12:00:00Z');
    fs.mkdirSync(backups, { recursive: true });
    const made: string[] = [];
    for (let i = 0; i < 60; i++) {
      const n = B.snapshotName(new Date(now.getTime() - (100 - i) * 86400000 - 3600000));
      fs.mkdirSync(path.join(backups, n, 'p'), { recursive: true });
      fs.writeFileSync(path.join(backups, n, 'p', 'project.yaml'), 'x');
      made.push(n);
    }
    // things that must survive: a file and a dir with snapshot-like names, a user dir, a symlink to the projects
    fs.writeFileSync(path.join(backups, '2020-01-01T00-00-00Z.txt'), 'note');
    fs.writeFileSync(path.join(backups, '2020-01-02T00-00-00Z'), 'a file, not a dir');
    fs.mkdirSync(path.join(backups, 'my-manual-backup'));
    fs.mkdirSync(path.join(backups, '.partial-2020-01-01T00-00-00Z-1'));
    fs.symlinkSync(projects, path.join(backups, '2020-01-03T00-00-00Z'));
    const removed = B.pruneSnapshots(backups, projects, now);
    assert.equal(removed.length, 10);
    assert.deepEqual(removed, made.slice(0, 10));
    for (const n of made.slice(10)) assert.ok(fs.existsSync(path.join(backups, n)));
    for (const n of ['2020-01-01T00-00-00Z.txt', '2020-01-02T00-00-00Z', 'my-manual-backup', '.partial-2020-01-01T00-00-00Z-1'])
      assert.ok(fs.existsSync(path.join(backups, n)), n);
    assert.ok(fs.lstatSync(path.join(backups, '2020-01-03T00-00-00Z')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(projects, 'p/project.yaml'), 'utf8'), 'title: P\n', 'projects untouched');
  });

  test('assertPrunable guards the path', () => {
    const { h, projects, backups, write } = home();
    write('p/project.yaml', 'title: P\n');
    const n = '2026-10-09T08-00-00Z';
    fs.mkdirSync(path.join(backups, n), { recursive: true });
    assert.equal(B.assertPrunable(backups, n, projects), path.join(backups, n));
    for (const bad of ['..', '.', '', `../${n}`, `${n}/..`, `${n}/x`, path.join(backups, n), 'projects', `..\\${n}`])
      assert.throws(() => B.assertPrunable(backups, bad, projects), /refusing/, bad);
    // a dir not called backups/, or overlapping the projects
    fs.mkdirSync(path.join(h, 'other', n), { recursive: true });
    assert.throws(() => B.assertPrunable(path.join(h, 'other'), n, projects), /not a backups/);
    fs.mkdirSync(path.join(projects, 'backups', n), { recursive: true });
    assert.throws(() => B.assertPrunable(path.join(projects, 'backups'), n, projects), /overlaps/);
    assert.throws(() => B.assertPrunable(backups, n, h), /overlaps/);
    // a symlinked snapshot name, and a backups dir that is a symlink into the projects
    fs.symlinkSync(path.join(projects, 'p'), path.join(backups, '2026-10-09T09-00-00Z'));
    assert.throws(() => B.assertPrunable(backups, '2026-10-09T09-00-00Z', projects), /not a directory/);
    const linkHome = path.join(h, 'linkhome');
    fs.mkdirSync(linkHome);
    fs.symlinkSync(path.join(projects, 'backups'), path.join(linkHome, 'backups'));
    assert.throws(() => B.assertPrunable(path.join(linkHome, 'backups'), n, projects), /inside the projects/);
    assert.ok(fs.existsSync(path.join(projects, 'backups', n)));
  });
});

describe('no-clobber file helpers', () => {
  test('renameNoClobber never replaces a file; renameToBak finds a free name', () => {
    const { h } = home();
    const a = path.join(h, 'a.yaml');
    const b = path.join(h, 'b.yaml');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(b, 'B');
    assert.throws(() => renameNoClobber(a, b), /already exists/);
    assert.equal(fs.readFileSync(a, 'utf8'), 'A');
    assert.equal(fs.readFileSync(b, 'utf8'), 'B');
    fs.writeFileSync(path.join(h, 'a.tag.yaml.bak'), 'older backup');
    const bak = renameToBak(a, 'tag');
    assert.equal(bak, path.join(h, 'a.tag.2.yaml.bak'));
    assert.equal(fs.readFileSync(bak, 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(h, 'a.tag.yaml.bak'), 'utf8'), 'older backup');
    assert.ok(!fs.existsSync(a));
  });

  test('atomicWrite leaves no temp files and creates or replaces the target', () => {
    const { h } = home();
    const f = path.join(h, 'sub', 'f.yaml');
    atomicWrite(f, 'one');
    atomicWrite(f, 'two');
    assert.equal(fs.readFileSync(f, 'utf8'), 'two');
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ['f.yaml']);
  });
});
