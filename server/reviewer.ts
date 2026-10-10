import { execFileSync } from 'node:child_process';
import os from 'node:os';

/**
 * Who is reviewing: the person at the browser. Their comments are stored with `author: <id>`, and only theirs can be
 * edited or deleted in the UI (an agent's words are never touched from here).
 *
 * The name comes from $LOCAL_REVIEW_USER, else `git config user.name`, else $USER. The id is the name's first word,
 * lowercased and reduced to [a-z0-9_-] ("Ada Lovelace" → "ada"), so it stays the same if you later set
 * LOCAL_REVIEW_USER to just your first name. Comment files already written under some id keep working as long as the
 * id resolves the same: set LOCAL_REVIEW_USER to that id to pin it.
 */
export interface Reviewer {
  id: string;
  name: string;
}

export function reviewerId(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  const id = first.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  // `claude` is the agent's id: a reviewer can't take it
  return id && id !== 'claude' ? id : 'reviewer';
}

export function resolveReviewer(sources: { env?: string; gitName?: string; user?: string }): Reviewer {
  const name = [sources.env, sources.gitName, sources.user].map((s) => s?.trim()).find((s) => s) || 'reviewer';
  return { id: reviewerId(name), name };
}

function gitUserName(): string | undefined {
  try {
    return execFileSync('git', ['config', '--get', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
  } catch {
    return undefined;
  }
}

function osUser(): string | undefined {
  try {
    return process.env.USER || os.userInfo().username;
  } catch {
    return undefined;
  }
}

export const REVIEWER: Reviewer = resolveReviewer({
  env: process.env.LOCAL_REVIEW_USER,
  gitName: process.env.LOCAL_REVIEW_USER ? undefined : gitUserName(),
  user: osUser(),
});
