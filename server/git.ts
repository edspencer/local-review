// Read-only git access. Every call goes through execFile (no shell) with `git -C <repo>`,
// and only a fixed allow-list of read-only subcommands may be run.
import { execFile, spawn, type ChildProcess } from 'node:child_process';

const READ_ONLY = new Set([
  'log', 'show', 'diff', 'rev-list', 'rev-parse', 'merge-base', 'patch-id',
  'cat-file', 'ls-tree', 'for-each-ref', 'diff-tree',
]);

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Inherited GIT_* variables could point git somewhere else (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, e.g. when
// started from inside a git hook) or change its behaviour (GIT_EXTERNAL_DIFF, GIT_CONFIG_PARAMETERS), so drop
// them all and set only our own.
const ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
Object.assign(ENV, {
  GIT_OPTIONAL_LOCKS: '0', // never take index locks or refresh the index
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
});

// Prepended to every call. --no-optional-locks is the flag form of GIT_OPTIONAL_LOCKS=0 (belt and braces);
// the -c settings neutralise repo config that would change our parsed output or run programs:
// signatures in `show`, colour, quoted paths, textconv filters and external diff drivers.
const BASE_ARGS = [
  '--no-optional-locks',
  '-c', 'core.quotepath=off',
  '-c', 'color.ui=never',
  '-c', 'log.showSignature=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.relative=false',
];

// Options that make otherwise read-only commands write files or run external programs.
const FORBIDDEN_ARG = /^--(output|output-directory|no-index|ext-diff|textconv|filters|exec|upload-pack|receive-pack)(=|$)/;

export class GitError extends Error {
  /** git's exit status, when it ran and failed (e.g. `merge-base --is-ancestor`: 1 is "no", 128 an unknown object) */
  constructor(message: string, public stderr = '', public exitCode?: number) {
    super(message);
  }
}

// How long one git call may take. Callers share in-flight reads (stamps.ts), so a call that never finished would hang
// every request behind it until restart. That happens: a child stuck in the kernel (forked, never exec'd, e.g. held
// up by an endpoint-security agent) never exits and never closes its pipes, so 'close' never fires.
export const GIT_TIMEOUT_MS = 60_000;
let timeoutMs = GIT_TIMEOUT_MS;

/** Change the per-call timeout (tests). */
export function setGitTimeout(ms: number) {
  timeoutMs = ms;
}

/**
 * Reject if the child hasn't closed within the timeout. This rejects directly rather than via 'close' (which a stuck
 * child never sends), kills the child and closes our ends of its pipes.
 */
function deadline(child: ChildProcess, args: string[], reject: (e: GitError) => void) {
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    for (const s of [child.stdin, child.stdout, child.stderr]) s?.destroy();
    reject(new GitError(`git ${args[0]} timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
  child.once('error', () => clearTimeout(timer));
}

function check(repo: string, args: string[]): string[] {
  const sub = args[0];
  if (!READ_ONLY.has(sub)) throw new GitError(`refusing to run non-read-only git command: ${sub}`);
  const bad = args.find((a) => FORBIDDEN_ARG.test(a));
  if (bad) throw new GitError(`refusing git option ${bad}`);
  if (typeof repo !== 'string' || !repo || repo.startsWith('-')) throw new GitError(`bad repo path: ${repo}`);
  return ['-C', repo, ...BASE_ARGS, ...args];
}

export function git(repo: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const argv = check(repo, args); // a throw here rejects the promise
    const child = execFile(
      'git',
      argv,
      { env: ENV, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(`git ${args.join(' ')} failed: ${String(stderr || err.message).trim()}`, String(stderr), typeof err.code === 'number' ? err.code : undefined));
        else resolve(stdout);
      },
    );
    deadline(child, args, reject);
  });
}

/** Like git() but returns a Buffer (for blobs that may be binary). */
export function gitBuffer(repo: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const argv = check(repo, args); // a throw here rejects the promise
    const child = execFile(
      'git',
      argv,
      { env: ENV, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(`git ${args.join(' ')} failed: ${String(stderr).trim()}`));
        else resolve(stdout);
      },
    );
    deadline(child, args, reject);
  });
}

/** Pipe `input` to a read-only git command's stdin (`git patch-id`, `git cat-file --batch-check`). */
export async function gitWithInput(repo: string, args: string[], input: string): Promise<string> {
  return (await gitBufferWithInput(repo, args, input)).toString('utf8');
}

/** Like gitWithInput() but returns a Buffer (`git cat-file --batch`: blobs that may be binary). */
export function gitBufferWithInput(repo: string, args: string[], input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const argv = check(repo, args); // a throw here rejects the promise
    const child = spawn('git', argv, { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    deadline(child, args, reject);
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new GitError(`git ${args[0]} failed: ${err.trim()}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Is this a ref name we are willing to pass to git: no leading dash, no `..`, no odd characters. */
export function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9._\/@{}^~+-]+$/.test(ref) && !ref.startsWith('-') && !ref.includes('..');
}

/** What a ref may be, for messages (keep in step with isSafeRef). */
export const SAFE_REF_RULE = "letters, digits and . _ / @ { } ^ ~ + -, not starting with - and without '..'";

/** A ref name we are willing to pass to git (isSafeRef), or a GitError. */
export function safeRef(ref: string): string {
  if (!isSafeRef(ref)) throw new GitError(`unsafe ref: ${ref}`);
  return ref;
}

export function isSha(s: string) {
  return /^[0-9a-f]{40}$/.test(s);
}

/** Assert a full 40-hex sha (what we pass to git as a revision when it came from git itself). */
export function sha40(s: string | null | undefined): string {
  if (typeof s !== 'string' || !isSha(s)) throw new GitError(`not a full sha: ${String(s)}`);
  return s;
}
