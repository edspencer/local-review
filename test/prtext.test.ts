// The PR editors' pure text helpers: markdown toolbar formatting, normalisation, "Copy title + description".
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_SEPARATOR, applyFormat, fullPrBody, normBody, normTitle, titleAndBody } from '../src/prText.ts';
import { tildify } from '../shared/paths.ts';

describe('markdown toolbar', () => {
  const at = (text: string, sel: string) => { const s = text.indexOf(sel); return [s, s + sel.length] as const; };
  test('wraps the selection and keeps it selected', () => {
    const t = 'make this bold';
    const r = applyFormat(t, ...at(t, 'this'), 'bold');
    assert.equal(r.text, 'make **this** bold');
    assert.equal(r.text.slice(r.start, r.end), 'this');
    assert.equal(applyFormat(t, ...at(t, 'bold'), 'italic').text, 'make this _bold_');
    assert.equal(applyFormat(t, ...at(t, 'this'), 'code').text, 'make `this` bold');
  });
  test('no selection inserts a selected placeholder', () => {
    const r = applyFormat('ab', 1, 1, 'bold');
    assert.equal(r.text, 'a**bold text**b');
    assert.equal(r.text.slice(r.start, r.end), 'bold text');
  });
  test('multi-line code becomes a fence; link selects the url', () => {
    assert.equal(applyFormat('x\ny', 0, 3, 'code').text, '```\nx\ny\n```');
    const r = applyFormat('see docs', 4, 8, 'link');
    assert.equal(r.text, 'see [docs](url)');
    assert.equal(r.text.slice(r.start, r.end), 'url');
  });
  test('list and quote prefix every touched line, and toggle back', () => {
    const t = 'intro\none\ntwo\nend';
    const s = t.indexOf('ne'), e = t.indexOf('wo');
    const r = applyFormat(t, s, e, 'list');
    assert.equal(r.text, 'intro\n- one\n- two\nend');
    assert.equal(applyFormat(r.text, r.start, r.end, 'list').text, t);
    const q = applyFormat('a\nb', 3, 3, 'quote');
    assert.deepEqual(q, { text: 'a\n> b', start: 5, end: 5 }); // a bare caret stays put in the line's text
    assert.deepEqual(applyFormat(q.text, q.start, q.end, 'quote'), { text: 'a\nb', start: 3, end: 3 });
    // a selection ending just after a line break doesn't take the next line
    assert.equal(applyFormat('one\ntwo', 0, 4, 'quote').text, '> one\ntwo');
  });
});

describe('PR text', () => {
  test('normalises like the server', () => {
    assert.equal(normTitle('  a \n b  '), 'a b');
    assert.equal(normBody('x\r\ny\n\n'), 'x\ny');
  });
  test('copy title + description', () => {
    assert.equal(titleAndBody({ title: 'T', body: 'Body\n\n- x\n' }), 'T\n\nBody\n\n- x');
    assert.equal(titleAndBody({ title: 'T', body: '  \n' }), 'T');
  });
});

describe('Copy full PR body', () => {
  test('intro, stack note, separator, body', () => {
    assert.equal(fullPrBody({ intro: 'Intro para 1.\n\nIntro para 2.\n', stackNote: 'Stack note.\n', body: 'The PR.\n\n- x\n' }), 'Intro para 1.\n\nIntro para 2.\n\nStack note.\n\n---\n\nThe PR.\n\n- x');
    assert.equal(CONTEXT_SEPARATOR, '\n\n---\n\n');
  });
  test('missing parts are left out', () => {
    assert.equal(fullPrBody({ intro: 'I', stackNote: null, body: 'B' }), 'I\n\n---\n\nB');
    assert.equal(fullPrBody({ intro: '', stackNote: 'S', body: 'B' }), 'S\n\n---\n\nB');
    assert.equal(fullPrBody({ intro: null, stackNote: '  \n', body: 'B\n' }), 'B');
    assert.equal(fullPrBody({ intro: 'I\r\n', body: '' }), 'I');
  });
});

test('tildify: paths under the home directory are shown as ~/…, and only whole path prefixes', () => {
  const home = '/Users/ada';
  assert.equal(tildify('/Users/ada/.local-review/projects/x/project.yaml', home), '~/.local-review/projects/x/project.yaml');
  assert.equal(tildify('/Users/ada', home), '~');
  assert.equal(tildify('/Users/ada/', '/Users/ada/'), '~/');
  assert.equal(tildify("invalid YAML in /Users/ada/.local-review/p.yaml: bad; repo not found: /Users/ada/code/x", home), 'invalid YAML in ~/.local-review/p.yaml: bad; repo not found: ~/code/x');
  assert.equal(tildify('(/Users/ada/code)', home), '(~/code)');
  assert.equal(tildify('/Users/adam/code', home), '/Users/adam/code');
  assert.equal(tildify('/srv/Users/ada/code', home), '/srv/Users/ada/code');
  assert.equal(tildify('/tmp/x', home), '/tmp/x');
  assert.equal(tildify('/Users/ada/x', ''), '/Users/ada/x');
  assert.equal(tildify('/x', '/'), '/x');
  assert.equal(tildify('/a.b+c/x', '/a.b+c'), '~/x');
});
