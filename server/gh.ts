// Read-only GitHub access through the gh CLI, for the GitHub sync (server/github.ts). Like git.ts: execFile-style
// spawn with no shell, and one fixed invocation, `gh api graphql --hostname <host> --input -`, with the request on
// stdin. gh holds the token (Local Review never sees it); the query has to be a read (`query`), never a mutation or
// subscription, whatever the token would allow.
import { spawn } from 'node:child_process';

export type GhErrorKind = 'missing' | 'auth' | 'timeout' | 'failed';

export class GhError extends Error {
  constructor(message: string, public kind: GhErrorKind = 'failed') {
    super(message);
  }
}

export interface GraphqlResult {
  data: any;
  errors?: { message?: string; type?: string; path?: unknown[] }[];
}

/** How Local Review reaches GitHub. Only gh for now; another source (a token) would be another of these. */
export interface GithubSource {
  name: string;
  graphql(host: string, query: string, variables: Record<string, string | number>): Promise<GraphqlResult>;
}

export const GH_TIMEOUT_MS = 60_000;

const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?$/; // never an option (no leading -)

/** Refuse anything but a read: one `query` operation (plus fragments), no mutation or subscription anywhere. */
export function checkQuery(query: string) {
  if (typeof query !== 'string' || !/^\s*query\b/.test(query)) throw new GhError('refusing a GraphQL request that isn\'t a query');
  if (/\b(mutation|subscription)\b/i.test(query)) throw new GhError('refusing a GraphQL mutation or subscription');
}

// gh shouldn't prompt, page, colour or check for updates; GH_TOKEN / GH_HOST / GH_CONFIG_DIR are the user's and kept
const env = (): NodeJS.ProcessEnv => ({ ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1', CLICOLOR: '0' });

let bin = 'gh';
/** Use another gh binary (tests). */
export function setGhBinary(path: string) {
  bin = path;
}

export function ghGraphql(host: string, query: string, variables: Record<string, string | number>, timeoutMs = GH_TIMEOUT_MS): Promise<GraphqlResult> {
  return new Promise((resolve, reject) => {
    if (!HOST.test(host)) return reject(new GhError(`bad GitHub host: ${host}`));
    try {
      checkQuery(query);
    } catch (e) {
      return reject(e);
    }
    const child = spawn(bin, ['api', 'graphql', '--hostname', host, '--input', '-'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      for (const s of [child.stdin, child.stdout, child.stderr]) s?.destroy();
      reject(new GhError(`gh api graphql timed out after ${timeoutMs} ms`, 'timeout'));
    }, timeoutMs);
    timer.unref();
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new GhError("gh isn't installed, or isn't on the server's PATH (https://cli.github.com)", 'missing') : new GhError(`gh: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8');
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON: an error message */
      }
      // a partial answer (one PR not found) exits 1 with the data and its errors: still an answer
      if (json && typeof json === 'object' && 'data' in json && json.data) return resolve({ data: json.data, ...(Array.isArray(json.errors) ? { errors: json.errors } : {}) });
      const msg = (err || text || `exit ${code}`).trim();
      if (/auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(msg)) return reject(new GhError(`gh isn't logged in to ${host}: run \`gh auth login${host === 'github.com' ? '' : ` --hostname ${host}`}\``, 'auth'));
      reject(new GhError(`gh api graphql failed: ${msg.split('\n')[0]}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ query, variables }));
  });
}

export const ghSource: GithubSource = { name: 'gh', graphql: (host, query, variables) => ghGraphql(host, query, variables) };
