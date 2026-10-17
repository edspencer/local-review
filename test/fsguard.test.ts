// A static guard: no server code may delete, truncate, overwrite or rename files except the few reviewed call
// sites below (temp-file cleanup and no-clobber renames in safefs.ts, snapshot copying and pruning in
// backups.ts, and `local-review service uninstall` removing its own LaunchAgent / systemd unit in service/manager.ts). If this fails, you've added a way to lose data: route it through server/safefs.ts instead, or
// (after careful review) update ALLOWED with a comment saying why it can't destroy anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(REPO, 'server');
// the code the server runs to create the example projects (server/examples.ts) is held to the same rules, with no
// allowance at all: it only ever creates
const ALSO_SCANNED = ['demo/lib', 'demo/world'].map((d) => path.join(REPO, d));

const RULES: Record<string, RegExp> = {
  unlink: /\bunlink(?:Sync)?\s*\(/g,
  rm: /\brm(?:Sync)?\s*\(/g,
  rmdir: /\brmdir(?:Sync)?\b/g,
  truncate: /\bftruncate(?:Sync)?\b|\btruncateSync\b|\.truncate\s*\(/g,
  writeFile: /\b(?:writeFile|appendFile)(?:Sync)?\s*\(|\bcreateWriteStream\b|\bopen(?:Sync)?\s*\([^)]*['"][wa]\+?['"]/g,
  rename: /\brename(?:Sync)?\s*\(/g,
  copy: /\b(?:copyFile|cp)(?:Sync)?\s*\(/g,
  // destructive fs functions imported by name (would dodge the call patterns above if renamed)
  fsImport: /import\s*\{[^}]*\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|truncate|truncateSync|writeFile|writeFileSync|rename|renameSync)\b[^}]*\}\s*from\s*['"](?:node:)?fs/g,
  // shelling out to file tools
  shell: /\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync)\s*\(\s*['"](?:rm|mv|cp|truncate|dd|shred|find)['"]/g,
};

/** Exact counts per file. Anything not listed must be zero. */
const ALLOWED: Record<string, Record<string, number>> = {
  'safefs.ts': {
    unlink: 2, // removeOwnTemp (our .tmp only); renameNoClobber dropping the old name once hard-linked at the new one
    writeFile: 1, // atomicWrite's temp file, flag 'wx' (checked below)
    rename: 2, // atomicWrite's temp -> target; renameNoClobber's fallback after an existence check
  },
  'backups.ts': {
    rm: 1, // pruneSnapshots, only after assertPrunable
    rename: 1, // a complete snapshot copy into its fresh name
    copy: 1, // the snapshot copy itself (errorOnExist, force: false)
  },
  'service/manager.ts': {
    // `service uninstall` removing the service's own generated definition (local-review.server.plist /
    // local-review-server.service), outside the data home, after checking its name and directory (checked below)
    unlink: 1,
  },
};

function serverFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? serverFiles(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('no server code can delete, truncate or overwrite files outside the allowlist', () => {
  const files = [SERVER, ...ALSO_SCANNED].flatMap(serverFiles);
  assert.ok(files.some((f) => f.endsWith('reviews.ts')), 'scanning the right directory');
  assert.ok(files.some((f) => f.endsWith('gitworld.ts')), 'scanning the example builder');
  const problems: string[] = [];
  for (const f of files) {
    const rel = path.relative(f.startsWith(SERVER + path.sep) ? SERVER : REPO, f).split(path.sep).join('/');
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const [rule, re] of Object.entries(RULES)) {
      const n = src.match(re)?.length ?? 0;
      const allowed = ALLOWED[rel]?.[rule] ?? 0;
      if (n !== allowed) problems.push(`${rel}: ${n} × ${rule} (allowed ${allowed})`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the one writeFile is a temp file opened with 'wx', and the prune is guarded", () => {
  const safefs = stripComments(fs.readFileSync(path.join(SERVER, 'safefs.ts'), 'utf8'));
  const writes = safefs.match(/writeFileSync\([^;]*\);/g) ?? [];
  assert.equal(writes.length, 1);
  assert.match(writes[0], /writeFileSync\(tmp,[^;]*flag: 'wx'/);
  const backups = stripComments(fs.readFileSync(path.join(SERVER, 'backups.ts'), 'utf8'));
  assert.match(backups, /const target = assertPrunable\(backupsDir, n, projectsDir\);\s*fs\.rmSync\(target, \{ recursive: true \}\);/);
  assert.doesNotMatch(backups, /force:\s*true/);
});

test("the service's one unlink removes only its own definition file", () => {
  const src = stripComments(fs.readFileSync(path.join(SERVER, 'service', 'manager.ts'), 'utf8'));
  // the name pattern is exactly the two definition files, anchored
  assert.match(src, /export const SERVICE_FILE = \/\^local-review\[\.-\]server\\\.\(\?:plist\|service\)\$\/;/);
  // and the unlink is reached only past the check of the name and the directory
  assert.match(
    src,
    /export function removeServiceFile\(file: string, dir: string\) \{\s*if \(!SERVICE_FILE\.test\(path\.basename\(file\)\) \|\| path\.dirname\(path\.resolve\(file\)\) !== path\.resolve\(dir\)\)\s*throw new Error\([^;]*;\s*try \{\s*fs\.unlinkSync\(file\);/,
  );
});

test('the guard catches the patterns it is meant to', () => {
  const hits = (code: string) => Object.entries(RULES).filter(([, re]) => (stripComments(code).match(re)?.length ?? 0) > 0).map(([k]) => k);
  assert.deepEqual(hits("fs.unlinkSync(f)"), ['unlink']);
  assert.deepEqual(hits("await fsp.rm(dir, { recursive: true })"), ['rm']);
  assert.deepEqual(hits("fs.rmdirSync(d)"), ['rmdir']);
  assert.deepEqual(hits("fs.truncateSync(f, 0)"), ['truncate']);
  assert.deepEqual(hits("fs.writeFileSync(f, s)"), ['writeFile']);
  assert.deepEqual(hits("fs.openSync(f, 'w')"), ['writeFile']);
  assert.deepEqual(hits("fs.renameSync(a, b)"), ['rename']);
  assert.deepEqual(hits("fs.copyFileSync(a, b)"), ['copy']);
  assert.deepEqual(hits("import { rmSync as r } from 'node:fs'"), ['fsImport']);
  assert.deepEqual(hits("execFile('rm', ['-rf', d])"), ['shell']);
  assert.deepEqual(hits("// fs.unlinkSync(f) in a comment\nconst t = truncate(s, face, 12, 100); w.on('unlink', f); const u = 'http://x'"), []);
});
