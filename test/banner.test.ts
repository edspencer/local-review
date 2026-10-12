// The startup text (server/banner.ts): the banner only on a terminal (or with FORCE_COLOR), colour by Node's rules,
// a one-line title on a narrow terminal, and the "Local Review on" line always there for scripts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerLines, startupMessage, type Terminal } from '../server/banner.ts';

const o = { url: 'http://localhost:5050', projectsDir: '/h/projects' };
const msg = (t: Partial<Terminal>, extra: Partial<typeof o & { quiet: boolean; dev: boolean }> = {}) =>
  startupMessage({ ...o, ...extra }, { env: {}, ...t });
const ESC = '\x1b[';
const LINE = 'Local Review on http://localhost:5050  (projects: /h/projects)';
const HINT = 'Point Claude Code/Codex/pi/whatever at http://localhost:5050/llms.txt then ask it to generate a project definition for you. Example:';

describe('startup banner', () => {
  test('LOCAL REVIEW: 6 rows of half blocks that fit 80 columns with a margin', () => {
    const lines = bannerLines();
    assert.equal(lines.length, 6);
    assert.ok(Math.max(...lines.map((l) => l.length)) <= 78);
    assert.ok(lines.every((l) => /^[ █▀▄]+$/.test(l)));
  });

  test('not a terminal: no banner, no colour; the line, two blank lines, then the hint for agents', () => {
    const text = msg({ isTTY: false });
    assert.ok(!text.includes(ESC) && !text.includes('█'));
    assert.equal(
      text,
      `${LINE}\n\n\n${HINT}\n\n  Read http://localhost:5050/llms.txt and create a local-review project for my feature-xyz branch on ~/code/my-git-project\n\n`,
    );
  });

  test('a truecolor terminal: the banner in the gradient, the URL in bold', () => {
    const text = msg({ isTTY: true, columns: 100, depth: 24 });
    assert.match(text, /\x1b\[38;2;176;72;156m/);
    assert.match(text, /\x1b\[38;2;232;163;61m/);
    assert.ok(text.includes(`\x1b[1mhttp://localhost:5050/llms.txt\x1b[22m`));
    assert.ok(text.replace(/\x1b\[[0-9;]*m/g, '').includes(bannerLines()[0]));
  });

  test('256 and 16 colours', () => {
    assert.match(msg({ isTTY: true, depth: 8 }), /\x1b\[38;5;\d+m/);
    const sixteen = msg({ isTTY: true, depth: 4 });
    assert.ok(sixteen.includes('\x1b[35m') && sixteen.includes('\x1b[33m'));
  });

  test("NO_COLOR on a terminal: the banner, without colour (Node's own detection)", () => {
    const text = msg({ isTTY: true, env: { NO_COLOR: '1' } });
    assert.ok(text.includes(bannerLines()[0]));
    assert.ok(!text.includes(ESC));
  });

  test('FORCE_COLOR: the banner even when piped; FORCE_COLOR=0 none', () => {
    assert.match(msg({ isTTY: false, env: { FORCE_COLOR: '3' } }), /\x1b\[38;2;/);
    assert.match(msg({ isTTY: false, env: { FORCE_COLOR: '3', NO_COLOR: '1' } }), /\x1b\[38;2;/, 'FORCE_COLOR wins, as in Node');
    assert.ok(!msg({ isTTY: false, env: { FORCE_COLOR: '0' } }).includes('█'));
  });

  test('a narrow terminal: a one-line title instead', () => {
    const text = msg({ isTTY: true, columns: 60, depth: 1 });
    assert.ok(!text.includes('█'));
    assert.ok(text.startsWith('\n ▌ LOCAL REVIEW\n\n' + LINE));
  });

  test('--quiet and npm run dev: just the line', () => {
    assert.equal(msg({ isTTY: true, depth: 24 }, { quiet: true }), LINE + '\n');
    assert.equal(msg({ isTTY: true, depth: 24 }, { dev: true }), LINE + '\n');
  });
});
