// `local-review update [--check] [--to <version|tag>] [--yes] [--force] [--json]` (`upgrade` too): cli-contract SPEC §5,
// through the reference's runUpdate (contract/update.ts). What's Local Review's own is here: its names, its busy check
// and its service, through service/index.ts's updateHooks, so the unit `update` refreshes is the one `service status`
// reports. It asks the npm registry only because a person ran it (SPEC §3); nothing else in Local Review does.
//
// What it writes: <data>/update.lock while it runs and <data>/update-check.json (contract/lock.ts, update-check.ts),
// and, through npm, the global install of local-review itself. Never user data.
import path from 'node:path';
import { BUSY_NOUNS } from './busy.js';
import { guardBusy } from './contract/busy-client.js';
import { EXIT } from './contract/exit-codes.js';
import { createOutput } from './contract/output.js';
import { runUpdate, type UpdateOptions, type UpdateProduct } from './contract/update.js';
import { changelogUrl, realContext, updateHooks } from './service/index.js';

export const PACKAGE = 'local-review';
export const BIN_SUBPATH = path.join('dist', 'server', 'cli.js');

export const UPDATE_USAGE = 'Usage: local-review update [--check] [--to <version|tag>] [--yes] [--force] [--json]';

export interface UpdateCommandInput {
  /** The package root (config.ROOT). */
  root: string;
  /** This command's data home (config.HOME). */
  home: string;
  version: string;
}

export async function updateCommand(input: UpdateCommandInput, opts: UpdateOptions): Promise<number> {
  const out = createOutput({ tool: 'local-review', json: opts.json === true });
  const ctx = realContext(input.root, { dataHome: input.home, version: input.version });
  let svc: Awaited<ReturnType<typeof updateHooks>>;
  try {
    svc = await updateHooks(ctx, { cli: entry(), execArgv: process.execArgv });
  } catch (e) {
    // Windows, for now: there's no service to refresh, and a half-finished update is worse than none
    return out.error((e as Error).message);
  }
  const product: UpdateProduct = {
    name: 'Local Review',
    tool: 'local-review',
    packageName: PACKAGE,
    envPrefix: 'LOCAL_REVIEW',
    home: svc.home,
    currentVersion: input.version,
    // not realpath'd: findCli re-resolves the bin's symlink after the install (pnpm puts the version in the real path)
    entry: entry(),
    binSubpath: BIN_SUBPATH,
    usage: UPDATE_USAGE,
    changelogUrl,
    guardBusy: async ({ force, home }) => {
      const refused = await guardBusy({
        home,
        ...(svc.busyUrl ? { url: svc.busyUrl } : {}),
        out,
        name: 'Local Review',
        nouns: BUSY_NOUNS,
        force,
        hint: 'Try again once it has finished (`local-review busy` says when), or update it anyway with --force.',
      });
      return refused === null ? null : EXIT.BUSY;
    },
    service: svc.hooks,
  };
  return runUpdate(product, opts, { out });
}

/** The bin as it was run (process.argv[1]), made absolute but not realpath'd. */
function entry(): string {
  const a = process.argv[1] ?? path.join(process.cwd(), BIN_SUBPATH);
  return path.isAbsolute(a) ? a : path.resolve(a);
}

