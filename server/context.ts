import { commitDetail, detailOf, isAncestor, patchId, rangeEnd, summarize, type CommitSummary, type RepoInfo, type RepoRange } from './commits.js';
import type { InspectOrphan, LiveCommit, ReviewContext } from './reviews.js';
import type { PrContext } from './prs.js';

export function liveCommits(cfg: RepoRange, info: RepoInfo): LiveCommit[] {
  // landed PRs are in the list (so nothing takes their files) but frozen (so they take nothing)
  return info.commits.map((c) => ({ sha: c.sha, subject: c.subject, changeId: c.changeId, getPatchId: () => patchId(cfg.path, c.sha), ...(c.landed ? { frozen: true } : {}) }));
}

/**
 * Look up the sha of an orphaned review / PR file in the reviewed repo (read-only): is it still an ancestor of
 * the range end (it only left the range), and its subject, Change-Id and patch-id for files that lack them.
 */
export function inspectOrphan(cfg: RepoRange, info: RepoInfo): InspectOrphan {
  return async (sha) => {
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    let s;
    try {
      s = await summarize(cfg.path, sha);
    } catch {
      return { exists: false, reachable: false }; // not in this repo (or gc'd)
    }
    return {
      exists: true,
      reachable: info.head ? await isAncestor(cfg.path, sha, info.head) : false,
      subject: s.subject,
      changeId: s.changeId,
      getPatchId: () => patchId(cfg.path, sha),
    };
  };
}

/** Everything the review store needs to know about one commit of a loaded repo range. */
export function contextFor(dir: string, cfg: RepoRange, info: RepoInfo, commit: CommitSummary): ReviewContext {
  return {
    repo: cfg.name,
    dir,
    repoPath: cfg.path,
    branch: rangeEnd(cfg),
    sha: commit.sha,
    subject: commit.subject,
    changeId: commit.changeId,
    getPatchId: () => patchId(cfg.path, commit.sha),
    liveCommits: liveCommits(cfg, info),
    inspectOrphan: inspectOrphan(cfg, info),
    // sha is either a range commit or an old sha taken from a review file name (40 hex), never user input
    getFiles: async (sha) => {
      if (!/^[0-9a-f]{40}$/.test(sha)) return null;
      try {
        // a landed PR's own diff (merge-base(base, head)...head), not its key commit's
        return (await (sha === commit.sha ? detailOf(cfg.path, commit) : commitDetail(cfg.path, sha))).files;
      } catch {
        return null;
      }
    },
  };
}

export function prContextFor(dir: string, cfg: RepoRange, info: RepoInfo, commit: CommitSummary): PrContext {
  return {
    repo: cfg.name,
    dir,
    sha: commit.sha,
    subject: commit.subject,
    changeId: commit.changeId,
    getPatchId: () => patchId(cfg.path, commit.sha),
    liveCommits: liveCommits(cfg, info),
    inspectOrphan: inspectOrphan(cfg, info),
  };
}
