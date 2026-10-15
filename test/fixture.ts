// Throwaway git repos under the OS temp dir for the review-store tests. These are the only repos the
// tests ever write to; reviewed repos are never touched.
import { execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Stop a server started by a test and wait until it has exited: it may still be writing (the disk cache flushes on
 * SIGTERM), so delete its data home only after this.
 */
export function stopServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return Promise.resolve();
  return new Promise((res) => {
    server.once('exit', () => res());
    server.kill();
  });
}

export function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export class Repo {
  constructor(public dir: string) {}

  static create(): Repo {
    const dir = tmpDir('lr-test-repo-');
    const r = new Repo(dir);
    r.git('init', '-q', '-b', 'main');
    return r;
  }

  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_SEQUENCE_EDITOR: 'true', // accept the autosquash todo list as is
        GIT_EDITOR: 'true',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }).trim();
  }

  write(file: string, content: string) {
    const p = path.join(this.dir, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  read(file: string) {
    return fs.readFileSync(path.join(this.dir, file), 'utf8');
  }

  commit(message: string, files: Record<string, string> = {}): string {
    for (const [f, c] of Object.entries(files)) this.write(f, c);
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  /** Make a fixup! commit for `target` and squash it in with a real `git rebase -i --autosquash`. */
  fixup(target: string, change: () => void) {
    change();
    this.git('add', '-A');
    this.git('commit', '-q', `--fixup=${target}`);
    this.git('rebase', '-q', '-i', '--autosquash', 'main');
  }

  rm() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

export const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';
