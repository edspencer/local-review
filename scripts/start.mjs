// `npm start`: build the frontend if dist/ is missing or older than the sources, then serve
// the built UI + API from one process on 127.0.0.1:5000.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = path.join(root, 'dist', 'index.html');

function newestMtime(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = st.mtimeMs;
  for (const e of fs.readdirSync(p)) m = Math.max(m, newestMtime(path.join(p, e)));
  return m;
}

const sources = ['src', 'index.html', 'vite.config.ts', 'package.json'].map((p) => path.join(root, p));
const srcTime = Math.max(...sources.filter(fs.existsSync).map(newestMtime));
const needsBuild = !fs.existsSync(distIndex) || fs.statSync(distIndex).mtimeMs < srcTime || process.argv.includes('--build');
if (needsBuild) {
  console.log('Building frontend...');
  const r = spawnSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const child = spawn('npx', ['tsx', path.join(root, 'server', 'index.ts')], { cwd: root, stdio: 'inherit', env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
