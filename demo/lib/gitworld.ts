// A tiny deterministic git history builder for the demo test bed. Commits are built in memory (each one a full
// snapshot of the tree) and written with one `git fast-import` per repo, with fixed authors and dates and git's
// config isolated from the machine's, so every run on every machine produces the same shas.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Person {
  name: string;
  email: string;
}

/** A file's new content, `null` to delete it, or an edit of its current content. */
export type Change = string | null | ((old: string) => string);
export type Changes = Record<string, Change>;

export interface Commit {
  mark: number;
  key: string; // a unique handle for the content scripts, e.g. "promote" or "promote@v1"
  message: string;
  subject: string;
  author: Person;
  authorAt: string; // ISO
  committer: Person;
  committedAt: string;
  parent: Commit | null;
  merge: Commit | null;
  changes: Changes; // what this commit did to its parent, for replaying it elsewhere
  files: Map<string, string>;
  sha?: string;
}

/** The environment every git command here runs with: nothing from the machine's git config, no signing, no hooks. */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', TZ: 'UTC' };
}

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, env: gitEnv(), input, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** `git` without blocking: the app builds the example projects with this while it keeps serving. */
export function gitAsync(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0]} failed in ${cwd}: ${stderr || err.message}`)) : resolve(stdout),
    );
    // commands that don't read stdin may exit before it's written (EPIPE): their exit status is what counts
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

/** Replace exactly one occurrence of `from` (fails loudly if it isn't there, so content edits can't silently drift). */
export const replace =
  (from: string, to: string) =>
  (old: string): string => {
    const i = old.indexOf(from);
    if (i < 0) throw new Error(`replace: text not found:\n${from}`);
    if (old.indexOf(from, i + 1) >= 0) throw new Error(`replace: text found more than once:\n${from}`);
    return old.slice(0, i) + to + old.slice(i + from.length);
  };

/** Several `replace`s in order. */
export const edits =
  (...pairs: [string, string][]) =>
  (old: string): string =>
    pairs.reduce((s, [a, b]) => replace(a, b)(s), old);

/** Insert `text` right after the (unique) `anchor`. */
export const after = (anchor: string, text: string) => replace(anchor, anchor + text);

/** Strip the common indentation of a template literal and its leading newline, keep one trailing newline. */
export function code(strings: TemplateStringsArray, ...vals: unknown[]): string {
  let s = strings.reduce((a, str, i) => a + str + (i < vals.length ? String(vals[i]) : ''), '');
  s = s.replace(/^\n/, '').replace(/[ \t]+$/, '');
  const lines = s.split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(indent)).join('\n').replace(/\n*$/, '\n');
}

/** Go files and Makefiles are indented with tabs on disk; the content scripts write them with 4 spaces. */
export function onDisk(file: string, content: string): string {
  if (!/\.go$|(^|\/)Makefile$/.test(file)) return content;
  return content.replace(/^((?: {4})+)/gm, (m) => '\t'.repeat(m.length / 4));
}

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export class RepoBuilder {
  private nextMark = 1;
  readonly commits: Commit[] = [];
  private byKey = new Map<string, Commit>();
  readonly refs = new Map<string, Commit>();

  constructor(
    readonly name: string,
    readonly remoteUrl: string,
  ) {}

  /** A commit on `parent` (null: a root commit). `key` defaults to the subject. */
  commit(parent: Commit | null, message: string, changes: Changes, o: { author: Person; at: string; committer?: Person; committedAt?: string; key?: string; merge?: Commit }): Commit {
    const files = new Map(parent?.files ?? []);
    if (o.merge) for (const [p, c] of o.merge.files) if (!files.has(p)) files.set(p, c);
    for (const [p, ch] of Object.entries(changes)) {
      if (ch === null) {
        if (!files.delete(p)) throw new Error(`${this.name}: delete of missing file ${p}`);
      } else if (typeof ch === 'function') {
        const old = files.get(p);
        if (old === undefined) throw new Error(`${this.name}: edit of missing file ${p} in "${message.split('\n')[0]}"`);
        files.set(p, ch(old));
      } else files.set(p, ch);
    }
    const subject = message.split('\n')[0];
    const key = o.key ?? subject;
    if (this.byKey.has(key)) throw new Error(`${this.name}: duplicate commit key ${key}`);
    const c: Commit = {
      mark: this.nextMark++,
      key,
      message: message.replace(/\n*$/, '\n'),
      subject,
      author: o.author,
      authorAt: o.at,
      committer: o.committer ?? o.author,
      committedAt: o.committedAt ?? o.at,
      parent,
      merge: o.merge ?? null,
      changes,
      files,
    };
    this.commits.push(c);
    this.byKey.set(key, c);
    return c;
  }

  /**
   * Replay commits onto `onto`, as `git rebase` would: same message, author and author date, a new committer
   * date. Each copy takes over its original's key; the original stays reachable as `<key>@<tag>`.
   */
  replay(list: Commit[], onto: Commit, o: { at: string; tag: string; committer?: Person; override?: Record<string, Changes> }): Commit[] {
    let base = onto;
    return list.map((c) => {
      const key = c.key;
      this.rekey(c, `${key}@${o.tag}`);
      // `override`: the copy's changes, when the rebase had to adapt the commit (a fixup squashed into it)
      base = this.commit(base, c.message, o.override?.[key] ?? c.changes, { author: c.author, at: c.authorAt, committer: o.committer ?? c.committer, committedAt: o.at, key });
      return base;
    });
  }

  rekey(c: Commit, key: string) {
    if (this.byKey.has(key)) throw new Error(`${this.name}: duplicate commit key ${key}`);
    this.byKey.delete(c.key);
    c.key = key;
    this.byKey.set(key, c);
  }

  get(key: string): Commit {
    const c = this.byKey.get(key);
    if (!c) throw new Error(`${this.name}: no commit ${key}`);
    return c;
  }

  sha(key: string): string {
    const s = this.get(key).sha;
    if (!s) throw new Error(`${this.name}: not built yet`);
    return s;
  }

  /** A file at a commit, as it is on disk. */
  file(key: string, file: string): string {
    const s = this.get(key).files.get(file);
    if (s === undefined) throw new Error(`${this.name}: no ${file} at ${key}`);
    return onDisk(file, s);
  }

  ref(name: string, c: Commit) {
    this.refs.set(name.startsWith('refs/') ? name : `refs/heads/${name}`, c);
  }

  /** `git init`, one fast-import, then check out `checkout` (the work tree a developer would have). */
  build(dir: string, checkout: string) {
    const { steps, marks } = this.plan(dir, checkout);
    for (const [args, input] of steps) git(dir, args, input);
    this.readMarks(marks);
  }

  /** The same as `build`, without blocking the event loop. */
  async buildAsync(dir: string, checkout: string) {
    const { steps, marks } = this.plan(dir, checkout);
    for (const [args, input] of steps) await gitAsync(dir, args, input);
    this.readMarks(marks);
  }

  /** Create `dir` (it mustn't exist: never builds over anything) and list the git commands that fill it. */
  private plan(dir: string, checkout: string): { steps: [string[], string?][]; marks: string } {
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
    fs.mkdirSync(dir, { recursive: true });
    const chunks: Buffer[] = [];
    const w = (s: string) => chunks.push(Buffer.from(s, 'utf8'));
    const data = (s: string) => {
      w(`data ${Buffer.byteLength(s, 'utf8')}\n`);
      w(s);
      w('\n');
    };
    for (const c of this.commits) {
      // every commit goes through one scratch ref, reset first so its parent is exactly what it says (none for a root)
      w(`reset refs/lr-demo/build\ncommit refs/lr-demo/build\nmark :${c.mark}\n`);
      w(`author ${c.author.name} <${c.author.email}> ${unix(c.authorAt)} +0000\n`);
      w(`committer ${c.committer.name} <${c.committer.email}> ${unix(c.committedAt)} +0000\n`);
      data(c.message);
      if (c.parent) w(`from :${c.parent.mark}\n`);
      if (c.merge) w(`merge :${c.merge.mark}\n`);
      w('deleteall\n');
      for (const p of [...c.files.keys()].sort()) {
        w(`M 100644 inline ${p}\n`);
        data(onDisk(p, c.files.get(p)!));
      }
      w('\n');
    }
    for (const [name, c] of [...this.refs].sort(([a], [b]) => a.localeCompare(b))) w(`reset ${name}\nfrom :${c.mark}\n\n`);
    const marks = path.join(dir, '.git', 'lr-demo-marks');
    return {
      marks,
      steps: [
        [['init', '-q', '-b', 'main']],
        [['config', 'core.hooksPath', '/dev/null']],
        [['config', 'commit.gpgSign', 'false']],
        [['config', 'gc.auto', '0']], // keep rewritten-away commits (anchors and moved branches point at them)
        [['config', 'rebase.updateRefs', 'true']], // AGENTS.md "Branch tagging"
        [['remote', 'add', 'origin', this.remoteUrl]],
        [['fast-import', '--quiet', '--date-format=raw', `--export-marks=${marks}`], Buffer.concat(chunks).toString('utf8')],
        [['update-ref', '-d', 'refs/lr-demo/build']],
        [['checkout', '-q', '-f', checkout]],
      ],
    };
  }

  /** Every commit's sha, from fast-import's marks. The file stays in .git: nothing reads it, and this code never
   * deletes a file (the app runs it to create the example projects, so test/fsguard.test.ts scans it like the server). */
  private readMarks(marks: string) {
    const markShas = new Map<number, string>();
    for (const line of fs.readFileSync(marks, 'utf8').split('\n').filter(Boolean)) {
      const [m, sha] = line.split(' ');
      markShas.set(Number(m.slice(1)), sha);
    }
    for (const c of this.commits) c.sha = markShas.get(c.mark);
  }
}
