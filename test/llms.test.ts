// llms.txt (shared/llms.ts): its shape (https://llmstxt.org), the guide section it embeds, and the URL rewriting. The
// docs site's copies are checked against it in docs.test.ts; the server's, with live facts, in hardening.test.ts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETUP_SECTION, SITE_URL, agentGuide, guideSection, llmsFullTxt, llmsTxt, type LlmsInput } from '../shared/llms.ts';
import { DEFAULT_PORT } from '../server/port.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guide = fs.readFileSync(path.join(ROOT, 'AGENT-GUIDE.md'), 'utf8');
const example = fs.readFileSync(path.join(ROOT, 'examples', 'project.example.yaml'), 'utf8');
const defaultUrl = `http://localhost:${DEFAULT_PORT}`;
const site: LlmsInput = { guide, example, url: defaultUrl, defaultUrl };
const live: LlmsInput = {
  ...site,
  url: 'http://localhost:5050',
  live: { version: '9.9.9', home: '/h/.local-review', projectsDir: '/h/.local-review/projects', reviewer: 'ada', projects: [] },
};

/** Lines outside code fences. */
function prose(md: string): string[] {
  let fence = false;
  return md.split('\n').filter((l) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    return !fence;
  });
}

describe('llms.txt', () => {
  test('the llms.txt shape: an H1, a blockquote, headingless details, then H2 link lists', () => {
    for (const i of [site, live]) {
      const lines = prose(llmsTxt(i));
      assert.equal(lines[0], '# Local Review');
      assert.match(lines[2], /^> /);
      const headings = lines.filter((l) => /^#{1,6} /.test(l));
      assert.deepEqual(headings, ['# Local Review', '## Docs', '## Optional']);
      // every item in the link lists is `- [name](url)`, optionally followed by `: notes`
      const lists = lines.slice(lines.indexOf('## Docs')).filter((l) => l.startsWith('- '));
      assert.ok(lists.length >= 8);
      for (const l of lists) assert.match(l, /^- \[[^\]]+\]\((https?:\/\/[^)\s]+)\)(?::|$)/, l);
    }
  });

  test(`it embeds the agent guide's "${SETUP_SECTION}" section and the example project`, () => {
    const t = llmsTxt(site);
    const section = guideSection(guide, SETUP_SECTION);
    assert.ok(section.includes('local-review init <slug>'));
    // the section, with its docs links pointing at the pages' Markdown copies
    assert.ok(t.includes(section.replace(`${SITE_URL}/reference/project-yaml/`, `${SITE_URL}/reference/project-yaml.md`)));
    assert.ok(t.includes(example.trimEnd()));
    assert.throws(() => guideSection(guide, 'No such section'), /no "## No such section" section/);
    assert.throws(() => guideSection('## A\n\n### B\n', 'A'), /can't have subheadings/);
  });

  test('a hidden project is still listed (its slug is taken), marked hidden', () => {
    const t = llmsTxt({ ...live, live: { ...live.live!, projects: [{ slug: 'parked', title: 'Parked', hidden: true, repos: [] }, { slug: 'shown', title: 'Shown', repos: [] }] } });
    assert.ok(t.includes('- `parked`: Parked (hidden: `hidden: true`, so not on the root page), http://localhost:5050/parked'));
    assert.ok(t.includes('- `shown`: Shown, http://localhost:5050/shown'));
  });

  test('the docs site copy says to read the local one; the local one has the live facts and its own URLs', () => {
    const s = llmsTxt(site);
    assert.match(s, /docs site's copy/);
    assert.doesNotMatch(s, /This Local Review, right now/);
    const l = llmsTxt(live);
    assert.match(l, /Served at http:\/\/localhost:5050, version 9\.9\.9/);
    assert.match(l, /Existing projects[^\n]*\n {2}- none yet/);
    assert.ok(!l.includes(defaultUrl), 'every default URL is rewritten');
    assert.ok(l.includes('[Agent guide](http://localhost:5050/agent-guide.md)'));
    assert.ok(l.includes('[llms-full.txt](http://localhost:5050/llms-full.txt)'));
    assert.ok(llmsFullTxt(live).startsWith(l) && llmsFullTxt(live).endsWith(agentGuide(live)));
    assert.match(agentGuide(live), /http:\/\/localhost:5050\/api\/projects/);
  });
});
