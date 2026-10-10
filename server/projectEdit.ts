// Writing the project intro (`description:`) and per-stack notes (`stacks[].description:`) back into
// project.yaml. The file is hand-written (by the reviewer or an agent), so it's edited as a YAML Document: only the one
// field changes, and comments, key order, quoting and everything else in it survive. Like reviews and PR files:
// serialised per file, the change is applied to a fresh read, the file is re-read just before the atomic write
// (and the change re-applied if it moved), and a file that doesn't parse is never overwritten.
import path from 'node:path';
import YAML, { isMap, isScalar, isSeq, Pair, Scalar, YAMLMap } from 'yaml';
import { atomicWrite } from './safefs.js';
import { ReviewConflictError, readRaw, withLock } from './reviews.js';
import { parseProject, projectDir, type ProjectConfig } from './projects.js';

export class EditNotFoundError extends Error {}

/** Normalised markdown to store: CRLF -> LF, trailing whitespace dropped. Blank means "remove the field". */
export const normDescription = (s: string) => s.replace(/\r\n/g, '\n').replace(/^\s*\n/, '').trimEnd();

/**
 * Set (or, with null / blank, remove) `key` in a YAML map node, as a `|` block. An existing scalar is changed in
 * place so its comments stay; a new key goes after `after` if that key exists, else at the end.
 */
function setBlock(doc: YAML.Document, map: YAMLMap, key: string, value: string | null, after?: string) {
  const text = value === null ? '' : normDescription(value);
  const i = map.items.findIndex((p) => (isScalar(p.key) ? p.key.value : p.key) === key);
  if (!text) {
    if (i >= 0) map.items.splice(i, 1);
    return;
  }
  const stored = text + '\n'; // `|`, not `|-`
  const existing = i >= 0 ? map.items[i].value : null;
  if (isScalar(existing)) {
    existing.value = stored;
    existing.type = Scalar.BLOCK_LITERAL;
    return;
  }
  const node = doc.createNode(stored) as Scalar;
  node.type = Scalar.BLOCK_LITERAL;
  if (i >= 0) {
    map.items[i].value = node;
    return;
  }
  const pair = new Pair(doc.createNode(key), node);
  const at = after ? map.items.findIndex((p) => (isScalar(p.key) ? p.key.value : p.key) === after) : -1;
  if (at >= 0) map.items.splice(at + 1, 0, pair);
  else map.items.push(pair);
}

/** The project intro: top-level `description:`, placed after `title:` if it's new. */
export function setProjectDescription(doc: YAML.Document, description: string | null) {
  if (!isMap(doc.contents)) throw new ReviewConflictError('project.yaml: the top level must be a mapping');
  setBlock(doc, doc.contents, 'description', description, 'title');
}

/**
 * A stack's note: `repos[repoIndex].stacks[stackIndex].description`. With `expectTitle`, refuses (409) if that
 * stack is now titled differently (the list was edited meanwhile), so a note never lands on the wrong stack.
 */
export function setStackDescription(doc: YAML.Document, cfg: ProjectConfig, repo: string, stackNumber: number, description: string | null, expectTitle?: string) {
  const rc = cfg.repos.find((r) => r.name === repo);
  if (!rc) throw new EditNotFoundError(`no repo '${repo}' in project '${cfg.slug}'`);
  const spec = rc.stacks[stackNumber - 1];
  if (!Number.isInteger(stackNumber) || stackNumber < 1 || !spec) throw new EditNotFoundError(`repo '${repo}' has no stack ${stackNumber}`);
  if (expectTitle !== undefined && spec.title !== expectTitle) throw new ReviewConflictError(`stack ${stackNumber} of '${repo}' is now "${spec.title}", not "${expectTitle}" (project.yaml changed). Reload and try again.`);
  const stacks = doc.getIn(['repos', rc.index, 'stacks'], true);
  if (!isSeq(stacks)) throw new EditNotFoundError(`repo '${repo}' has no stacks list`);
  let node = stacks.items[stackNumber - 1];
  if (!isMap(node)) {
    // `- Title` shorthand (or empty): becomes `- title: Title` so it can carry a note
    if (description === null || !normDescription(description)) return;
    const map = doc.createNode({ title: spec.title }) as YAMLMap;
    if (isScalar(node)) Object.assign(map, { commentBefore: node.commentBefore, comment: node.comment });
    stacks.items[stackNumber - 1] = map;
    node = map;
  }
  setBlock(doc, node as YAMLMap, 'description', description);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 6;

/**
 * Apply `edit` to project.yaml of `slug` and write it atomically. Retries if the file is briefly invalid or
 * changes underneath us; refuses (409) to overwrite a file that keeps failing to parse. Returns the new config.
 */
export function editProjectYaml(slug: string, edit: (doc: YAML.Document, cfg: ProjectConfig) => void): Promise<ProjectConfig> {
  const dir = projectDir(slug);
  const file = path.join(dir, 'project.yaml');
  return withLock(file, async () => {
    for (let attempt = 1; ; attempt++) {
      const raw = readRaw(file);
      if (raw === null) throw new EditNotFoundError(`no project '${slug}'`);
      const doc = YAML.parseDocument(raw);
      const cfg = parseProject(slug, dir, raw);
      if (doc.errors.length || cfg.error) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(40 * attempt);
          continue;
        }
        throw new ReviewConflictError(`refusing to overwrite ${file}: ${doc.errors[0]?.message ?? cfg.error}. Fix the file by hand.`);
      }
      edit(doc, cfg);
      const text = doc.toString({ lineWidth: 0 });
      if (readRaw(file) !== raw) {
        if (attempt < MAX_ATTEMPTS) continue;
        throw new ReviewConflictError(`${file} keeps changing on disk; not saving over it. Try again.`);
      }
      if (text !== raw) atomicWrite(file, text);
      return parseProject(slug, dir, text);
    }
  });
}
