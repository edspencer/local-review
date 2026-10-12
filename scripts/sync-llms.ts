// `npm run docs:llms`: writes the docs site's llms.txt and llms-full.txt (website/public/) from AGENT-GUIDE.md and
// examples/project.example.yaml, with shared/llms.ts: the generator the running server uses for its own copies (with
// live facts). Committed, like the agent guide pages; test/docs.test.ts fails while they're stale.
//
//   npm run docs:llms              rewrite them
//   npm run docs:llms -- --check   exit 1 if they're stale
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PORT } from '../server/port.ts';
import { llmsFullTxt, llmsTxt, type LlmsInput } from '../shared/llms.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** website/public/<file> → its contents */
export function siteLlmsFiles(): Record<string, string> {
  const url = `http://localhost:${DEFAULT_PORT}`;
  const i: LlmsInput = {
    guide: fs.readFileSync(path.join(ROOT, 'AGENT-GUIDE.md'), 'utf8'),
    example: fs.readFileSync(path.join(ROOT, 'examples', 'project.example.yaml'), 'utf8'),
    url,
    defaultUrl: url,
  };
  return { 'llms.txt': llmsTxt(i), 'llms-full.txt': llmsFullTxt(i) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [name, text] of Object.entries(siteLlmsFiles())) {
    const file = path.join(ROOT, 'website', 'public', name);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) continue;
    if (check) {
      console.error(`stale: website/public/${name} (run: npm run docs:llms)`);
      stale++;
    } else {
      fs.writeFileSync(file, text);
      console.log(`-> website/public/${name}`);
    }
  }
  if (stale) process.exitCode = 1;
}
