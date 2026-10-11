// Stack refs (shared/stackRef.ts): how a stack page's URL names a stack, and how it follows a renamed or reordered
// `stacks:` list. Pure functions, no server.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStackRef, resolveStackRef, stackRef, titleSlug } from '../shared/stackRef.ts';

type G = { number: number | null; title: string; implicit?: 'unstacked' | 'branch'; index: number };
const stacks = (...titles: string[]): G[] => [
  { number: null, title: 'Unstacked', implicit: 'unstacked', index: 0 },
  ...titles.map((title, i) => ({ number: i + 1, title, index: i + 1 })),
];

describe('stack refs', () => {
  test('a ref is the number and a slug of the title; implicit groups by name', () => {
    assert.equal(titleSlug('Groundwork: the API & CLI'), 'groundwork-the-api-cli');
    assert.equal(titleSlug('Café — résumé'), 'cafe-resume');
    assert.equal(titleSlug('!!!'), '');
    assert.equal(titleSlug('x'.repeat(80)).length, 60);
    assert.equal(stackRef({ number: 2, title: 'Groundwork' }), '2-groundwork');
    assert.equal(stackRef({ number: 3, title: '🚀' }), '3');
    assert.equal(stackRef({ number: null, title: 'Unstacked', implicit: 'unstacked' }), 'unstacked');
    assert.equal(stackRef({ number: null, title: 'me/feature', implicit: 'branch' }), 'branch');
  });

  test('parse: numbers with an optional slug, the implicit names, nothing else', () => {
    assert.deepEqual(parseStackRef('2-groundwork'), { number: 2, slug: 'groundwork' });
    assert.deepEqual(parseStackRef('12'), { number: 12, slug: null });
    assert.deepEqual(parseStackRef('branch'), { implicit: 'branch' });
    for (const bad of ['', '0', '0-x', '-1', '2-', '2--x', '2-X', '2-x/y', '../x', 'stack', '99999']) assert.equal(parseStackRef(bad), null, bad);
  });

  test('resolve: exact, moved (reordered: the title wins), renamed (the number wins), or not found', () => {
    const s = stacks('Groundwork', 'API', 'UI');
    assert.deepEqual(pick(resolveStackRef(s, '2-api')), [2, '2-api', 'exact']);
    assert.deepEqual(pick(resolveStackRef(s, '2')), [2, '2-api', 'exact']);
    assert.deepEqual(pick(resolveStackRef(s, 'unstacked')), [null, 'unstacked', 'exact']);
    // the list was reordered: API is stack 3 now
    const reordered = stacks('Groundwork', 'UI', 'API');
    assert.deepEqual(pick(resolveStackRef(reordered, '2-api')), [3, '3-api', 'moved']);
    // stack 2 was renamed
    const renamed = stacks('Groundwork', 'HTTP API', 'UI');
    assert.deepEqual(pick(resolveStackRef(renamed, '2-api')), [2, '2-http-api', 'renamed']);
    // gone altogether, or never there
    assert.equal(resolveStackRef(stacks('Groundwork'), '2-api'), null);
    assert.equal(resolveStackRef(s, '9'), null);
    assert.equal(resolveStackRef(s, 'branch'), null);
    assert.equal(resolveStackRef(s, 'nonsense'), null);
  });
});

const pick = (r: ReturnType<typeof resolveStackRef<G>>) => (r ? [r.group.number, r.ref, r.how] : null);
