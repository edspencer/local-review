// The startup text (server/banner.ts): stdout's first line is always `Local Review <version>: <url>` (cli-contract
// SPEC §3), for scripts; the banner goes to stderr, only on a terminal (or with FORCE_COLOR), colour by Node's rules,
// a one-line title on a narrow terminal.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerLines, startupMessage, type Terminal } from '../server/banner.ts';

const o = { url: 'http://localhost:5050', version: '1.2.3', projectsDir: '/h/projects' };
const msg = (t: Partial<Terminal>, extra: Partial<typeof o & { quiet: boolean; dev: boolean }> = {}) => startupMessage({ ...o, ...extra }, { env: {}, ...t });
/** Both streams, as a terminal shows them: the banner (stderr) first. */
const both = (t: Partial<Terminal>, extra: Partial<typeof o & { quiet: boolean; dev: boolean }> = {}) => {
  const s = msg(t, extra);
  return s.err + s.out;
};
const ESC = '\x1b[';
const FIRST = 'Local Review 1.2.3: http://localhost:5050';
const PROJECTS = 'Projects: /h/projects';
const HINT = 'Point Claude Code/Codex/pi/whatever at http://localhost:5050/llms.txt then ask it to generate a project definition for you. Example:';

describe('startup banner', () => {
  test('LOCAL REVIEW: 6 rows of half blocks that fit 80 columns with a margin', () => {
    const lines = bannerLines();
    assert.equal(lines.length, 6);
    assert.ok(Math.max(...lines.map((l) => l.length)) <= 78);
    assert.ok(lines.every((l) => /^[ █▀▄]+$/.test(l)));
  });

  test('not a terminal: no banner, no colour; the first line, the projects, then the hint for agents', () => {
    const s = msg({ isTTY: false });
    assert.equal(s.err, '');
    assert.ok(!s.out.includes(ESC));
    assert.equal(
      s.out,
      `${FIRST}\n${PROJECTS}\n\n${HINT}\n\n  Read http://localhost:5050/llms.txt and create a local-review project for my feature-xyz branch on ~/code/my-git-project\n\n`,
    );
  });

  test('a truecolor terminal: the banner on stderr in the gradient; stdout still starts with the first line', () => {
    const s = msg({ isTTY: true, columns: 100, depth: 24 });
    assert.match(s.err, /\x1b\[38;2;176;72;156m/);
    assert.match(s.err, /\x1b\[38;2;232;163;61m/);
    assert.ok(s.err.replace(/\x1b\[[0-9;]*m/g, '').includes(bannerLines()[0]));
    assert.ok(s.out.startsWith(FIRST + '\n' + PROJECTS + '\n'));
    assert.ok(!s.out.includes('█'));
    assert.ok(s.out.includes(`\x1b[1mhttp://localhost:5050/llms.txt\x1b[22m`));
  });

  test('the banner follows stderr, not stdout: stderr redirected to a file gets none', () => {
    const s = startupMessage(o, { isTTY: true, columns: 100, depth: 24, env: {} }, { isTTY: false, env: {} });
    assert.equal(s.err, '');
    assert.ok(s.out.startsWith(FIRST + '\n'));
    assert.ok(startupMessage(o, { isTTY: false, env: {} }, { isTTY: true, columns: 100, depth: 24, env: {} }).err.includes('\x1b[38;2;'));
  });

  test('256 and 16 colours', () => {
    assert.match(both({ isTTY: true, depth: 8 }), /\x1b\[38;5;\d+m/);
    const sixteen = both({ isTTY: true, depth: 4 });
    assert.ok(sixteen.includes('\x1b[35m') && sixteen.includes('\x1b[33m'));
  });

  test("NO_COLOR on a terminal: the banner, without colour (Node's own detection)", () => {
    const text = both({ isTTY: true, env: { NO_COLOR: '1' } });
    assert.ok(text.includes(bannerLines()[0]));
    assert.ok(!text.includes(ESC));
  });

  test('FORCE_COLOR: the banner even when piped; FORCE_COLOR=0 none', () => {
    assert.match(msg({ isTTY: false, env: { FORCE_COLOR: '3' } }).err, /\x1b\[38;2;/);
    assert.match(msg({ isTTY: false, env: { FORCE_COLOR: '3', NO_COLOR: '1' } }).err, /\x1b\[38;2;/, 'FORCE_COLOR wins, as in Node');
    assert.equal(msg({ isTTY: false, env: { FORCE_COLOR: '0' } }).err, '');
  });

  test('a narrow terminal: a one-line title instead', () => {
    const s = msg({ isTTY: true, columns: 60, depth: 1 });
    assert.ok(!s.err.includes('█'));
    assert.equal(s.err, '\n ▌ LOCAL REVIEW\n\n');
    assert.ok(s.out.startsWith(FIRST + '\n'));
  });

  test('--quiet: just the first line; npm run dev: it and the projects', () => {
    assert.deepEqual(msg({ isTTY: true, depth: 24 }, { quiet: true }), { out: FIRST + '\n', err: '' });
    assert.deepEqual(msg({ isTTY: true, depth: 24 }, { dev: true }), { out: `${FIRST}\n${PROJECTS}\n`, err: '' });
  });
});
