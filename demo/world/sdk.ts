// orchard-sdk: the TypeScript client for orchard-api, used by orchard-web and the mobile app.
import { RepoBuilder, after, edits, replace } from '../lib/gitworld.ts';
import { at, june, maya, remote, sam, theo } from './people.ts';

const append = (s: string) => (old: string) => old + s;

export function buildSdk() {
  const r = new RepoBuilder('orchard-sdk', remote('orchard-sdk'));

  const b1 = r.commit(null, 'Initial client with a fetch transport', {
    'package.json': `{
  "name": "@orchard/sdk",
  "version": "0.1.0",
  "description": "TypeScript client for the Orchard API",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
`,
    'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "declaration": true,
    "outDir": "dist",
    "strict": true
  },
  "include": ["src"]
}
`,
    'README.md': `# @orchard/sdk

The TypeScript client for the Orchard API. Works in browsers and in Node 18+ (anything with \`fetch\`).

\`\`\`ts
import { OrchardClient } from '@orchard/sdk';

const orchard = new OrchardClient({ baseUrl: 'https://api.orchard.example', token });
const { classes } = await orchard.classes.schedule(studioId, { from: '2026-06-01' });
\`\`\`
`,
    'src/errors.ts': `/** An error answer from the API: \`code\` is stable (switch on it), \`message\` is for people. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static from(status: number, body: unknown): ApiError {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    return new ApiError(status, e?.code ?? 'unknown', e?.message ?? \`HTTP \${status}\`);
  }
}
`,
    'src/client.ts': `import { ApiError } from './errors.js';

export interface ClientOptions {
  baseUrl: string;
  token: string;
  /** Defaults to the global fetch. Tests pass a fake. */
  fetch?: typeof fetch;
}

export class OrchardClient {
  constructor(private readonly options: ClientOptions) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const f = this.options.fetch ?? fetch;
    const res = await f(new URL(path, this.options.baseUrl), {
      method,
      headers: {
        Authorization: \`Bearer \${this.options.token}\`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw ApiError.from(res.status, data);
    return data as T;
  }
}
`,
    'src/index.ts': `export { OrchardClient, type ClientOptions } from './client.js';
`,
  }, { author: theo, at: at('2026-05-20 10:40') });

  const b2 = r.commit(b1, 'Add the classes resource', {
    'src/types.ts': `/** A class on a studio's schedule. Times are ISO 8601 strings, in UTC. */
export interface Class {
  id: number;
  title: string;
  coach: string;
  starts_at: string;
  minutes: number;
  capacity: number;
  spots_left: number;
}
`,
    'src/resources/classes.ts': `import type { OrchardClient } from '../client.js';
import type { Class } from '../types.js';

export class ClassesResource {
  constructor(private readonly client: OrchardClient) {}

  /** A week of a studio's classes, starting on \`from\` (YYYY-MM-DD; default today). */
  schedule(studioId: number, opts: { from?: string } = {}): Promise<{ classes: Class[] }> {
    const q = opts.from ? \`?from=\${encodeURIComponent(opts.from)}\` : '';
    return this.client.request('GET', \`/studios/\${studioId}/schedule\${q}\`);
  }

  get(id: number): Promise<Class> {
    return this.client.request('GET', \`/classes/\${id}\`);
  }
}
`,
    'src/client.ts': edits(
      ["import { ApiError } from './errors.js';\n", "import { ApiError } from './errors.js';\nimport { ClassesResource } from './resources/classes.js';\n"],
      ['export class OrchardClient {\n  constructor(private readonly options: ClientOptions) {}\n', 'export class OrchardClient {\n  readonly classes = new ClassesResource(this);\n\n  constructor(private readonly options: ClientOptions) {}\n'],
    ),
    'src/index.ts': append("export { ApiError } from './errors.js';\nexport type * from './types.js';\n"),
  }, { author: june, at: at('2026-05-28 14:15') });

  const b3 = r.commit(b2, 'Add the bookings resource', {
    'src/types.ts': append(`
export interface Booking {
  id: number;
  class_id: number;
  status: 'confirmed' | 'cancelled';
  /** Present when listing your bookings. */
  class?: Class;
}
`),
    'src/resources/bookings.ts': `import type { OrchardClient } from '../client.js';
import type { Booking } from '../types.js';

export class BookingsResource {
  constructor(private readonly client: OrchardClient) {}

  /** Book a spot. Throws ApiError \`class_full\` or \`already_booked\`. */
  book(classId: number): Promise<Booking> {
    return this.client.request('POST', \`/classes/\${classId}/bookings\`);
  }

  /** Your upcoming bookings, soonest first. */
  listMine(): Promise<{ bookings: Booking[] }> {
    return this.client.request('GET', '/me/bookings');
  }
}
`,
    'src/client.ts': edits(
      ["import { ClassesResource } from './resources/classes.js';\n", "import { BookingsResource } from './resources/bookings.js';\nimport { ClassesResource } from './resources/classes.js';\n"],
      ['  readonly classes = new ClassesResource(this);\n', '  readonly classes = new ClassesResource(this);\n  readonly bookings = new BookingsResource(this);\n'],
    ),
  }, { author: theo, at: at('2026-06-04 11:05') });

  const b4 = r.commit(b3, 'Retry idempotent requests on 502 and 503\n\nDeploys briefly answer 502/503 from the load balancer. GETs and DELETEs are safe to repeat;\nPOSTs are not (a booking could be made twice), so they are never retried.', {
    'src/client.ts': edits(
      [
        "export interface ClientOptions {\n",
        "const RETRYABLE = new Set([502, 503]);\nconst IDEMPOTENT = new Set(['GET', 'DELETE']);\n\nexport interface ClientOptions {\n",
      ],
      [
        '  async request<T>(method: string, path: string, body?: unknown): Promise<T> {\n    const f = this.options.fetch ?? fetch;\n    const res = await f(',
        `  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const attempts = IDEMPOTENT.has(method) ? 3 : 1;
    for (let i = 1; ; i++) {
      const res = await this.send(method, path, body);
      if (i < attempts && RETRYABLE.has(res.status)) {
        await sleep(200 * 2 ** i);
        continue;
      }
      if (res.status === 204) return undefined as T;
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) throw ApiError.from(res.status, data);
      return data as T;
    }
  }

  private send(method: string, path: string, body: unknown): Promise<Response> {
    const f = this.options.fetch ?? fetch;
    return f(`,
      ],
      [
        "      body: body === undefined ? undefined : JSON.stringify(body),\n    });\n    if (res.status === 204) return undefined as T;\n    const data: unknown = await res.json().catch(() => null);\n    if (!res.ok) throw ApiError.from(res.status, data);\n    return data as T;\n  }\n}\n",
        '      body: body === undefined ? undefined : JSON.stringify(body),\n    });\n  }\n}\n\nconst sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));\n',
      ],
    ),
  }, { author: sam, at: at('2026-06-12 16:22') });

  const b5 = r.commit(b4, 'Test the bookings resource against a fake transport', {
    'test/fake.ts': `import { OrchardClient } from '../src/client.js';

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** A client whose fetch answers from \`routes\` ("METHOD /path" → [status, body]) and records every call. */
export function fakeClient(routes: Record<string, [number, unknown?]>) {
  const calls: Call[] = [];
  const fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    const [status, json] = routes[\`\${method} \${u.pathname}\`] ?? [404, { error: { code: 'not_found', message: 'Not found.' } }];
    return new Response(status === 204 ? null : JSON.stringify(json ?? {}), { status });
  };
  return { client: new OrchardClient({ baseUrl: 'https://api.test', token: 't', fetch: fetch as typeof globalThis.fetch }), calls };
}
`,
    'test/bookings.test.ts': `import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors.js';
import { fakeClient } from './fake.js';

describe('bookings', () => {
  it('books a class', async () => {
    const { client, calls } = fakeClient({ 'POST /classes/7/bookings': [201, { id: 1, class_id: 7, status: 'confirmed' }] });
    await expect(client.bookings.book(7)).resolves.toMatchObject({ id: 1, status: 'confirmed' });
    expect(calls).toEqual([{ method: 'POST', path: '/classes/7/bookings' }]);
  });

  it('turns an error answer into an ApiError with its code', async () => {
    const { client } = fakeClient({ 'POST /classes/7/bookings': [409, { error: { code: 'class_full', message: 'This class is full.' } }] });
    const err = await client.bookings.book(7).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'class_full' });
  });

  it('never retries a POST', async () => {
    const { client, calls } = fakeClient({ 'POST /classes/7/bookings': [503] });
    await expect(client.bookings.book(7)).rejects.toThrow(ApiError);
    expect(calls).toHaveLength(1);
  });
});
`,
  }, { author: sam, at: at('2026-06-13 10:30') });

  const b6 = r.commit(b5, 'Support cancelling bookings', {
    'src/resources/bookings.ts': edits(
      ["import type { OrchardClient } from '../client.js';\n", "import type { OrchardClient } from '../client.js';\nimport { ApiError } from '../errors.js';\n"],
      [
        '  /** Your upcoming bookings, soonest first. */\n',
        `  /** Cancel one of your bookings. */
  async cancel(bookingId: number, opts: CancelOptions = {}): Promise<void> {
    try {
      await this.client.request('DELETE', \`/me/bookings/\${bookingId}\`);
    } catch (e) {
      if (!(opts.ignoreMissing && e instanceof ApiError && e.code === 'not_found')) throw e;
    }
  }

  /** Your upcoming bookings, soonest first. */
`,
      ],
      [
        'export class BookingsResource {',
        `export interface CancelOptions {
  /** Ignore a booking that's already gone (e.g. a retry after a timeout). */
  ignoreMissing?: boolean;
}

export class BookingsResource {`,
      ],
    ),
    'src/types.ts': replace("  status: 'confirmed' | 'cancelled';\n", "  status: 'confirmed' | 'cancelled';\n  /** ISO 8601. */\n  created_at?: string;\n"),
  }, { author: maya, at: at('2026-06-24 15:50') });

  const b7 = r.commit(b6, 'Release 0.7.0', {
    'package.json': replace('"version": "0.1.0"', '"version": "0.7.0"'),
    'CHANGELOG.md': `# Changelog

## 0.7.0

- \`bookings.cancel()\`, with \`ignoreMissing\` for retries.
- GETs and DELETEs are retried on 502/503 (POSTs never are).
- Errors are \`ApiError\`s with the API's stable \`code\`.

## 0.6.0

- \`classes.schedule()\` and \`classes.get()\`, \`bookings.book()\` and \`bookings.listMine()\`.
`,
  }, { author: june, at: at('2026-07-02 09:15') });

  const b8 = r.commit(b7, 'Send a request id and surface it on errors\n\nThe API logs X-Request-Id on every request; quoting it in a bug report finds the log line.', {
    'src/errors.ts': edits(
      ['    readonly code: string,\n    message: string,\n  ) {', "    readonly code: string,\n    message: string,\n    /** The X-Request-Id of the failed request: quote it in bug reports. */\n    readonly requestId?: string,\n  ) {"],
      ['  static from(status: number, body: unknown): ApiError {', '  static from(status: number, body: unknown, requestId?: string): ApiError {'],
      ["return new ApiError(status, e?.code ?? 'unknown', e?.message ?? `HTTP ${status}`);", "return new ApiError(status, e?.code ?? 'unknown', e?.message ?? `HTTP ${status}`, requestId);"],
    ),
    'src/client.ts': edits(
      ['      if (!res.ok) throw ApiError.from(res.status, data);', "      if (!res.ok) throw ApiError.from(res.status, data, res.headers.get('X-Request-Id') ?? undefined);"],
      ['        Authorization: `Bearer ${this.options.token}`,\n', '        Authorization: `Bearer ${this.options.token}`,\n        \'X-Request-Id\': crypto.randomUUID(),\n'],
    ),
  }, { author: theo, at: at('2026-08-28 13:40') });

  // ---------------------------------------------------------------- Maya's waitlists branch
  const s1 = r.commit(b8, 'Add waitlist types', {
    'src/types.ts': append(`
export type WaitlistStatus = 'waiting' | 'offered';

/** Your place in a full class's waitlist. */
export interface WaitlistPlace {
  id: number;
  class_id: number;
  /** 1 means you're next. */
  position: number;
  status: WaitlistStatus;
  /** When status is 'offered': the spot is held for you until then (ISO 8601). */
  hold_until?: string;
  /** Present when listing your bookings. */
  class?: Class;
}
`),
  }, { author: maya, at: at('2026-09-09 13:10'), key: 's1' });

  const s2 = r.commit(s1, 'Add joinWaitlist and leaveWaitlist', {
    'src/resources/bookings.ts': edits(
      ["import type { Booking } from '../types.js';", "import type { Booking, WaitlistPlace } from '../types.js';"],
      [
        '  /** Your upcoming bookings, soonest first. */\n',
        `  /** Join a full class's waitlist. Throws ApiError \`class_not_full\` if you could just book it. */
  joinWaitlist(classId: number): Promise<WaitlistPlace> {
    return this.client.request('POST', \`/classes/\${classId}/waitlist\`);
  }

  /** Leave a class's waitlist. Leaving one you're not on is fine. */
  leaveWaitlist(classId: number): Promise<void> {
    return this.client.request('DELETE', \`/classes/\${classId}/waitlist\`);
  }

  /** Your upcoming bookings, soonest first. */
`,
      ],
    ),
    'test/waitlist.test.ts': `import { describe, expect, it } from 'vitest';
import { fakeClient } from './fake.js';

describe('waitlist', () => {
  it('joins and leaves', async () => {
    const { client, calls } = fakeClient({
      'POST /classes/7/waitlist': [201, { id: 3, class_id: 7, position: 4, status: 'waiting' }],
      'DELETE /classes/7/waitlist': [204],
    });
    await expect(client.bookings.joinWaitlist(7)).resolves.toMatchObject({ position: 4 });
    await client.bookings.leaveWaitlist(7);
    expect(calls.map((c) => \`\${c.method} \${c.path}\`)).toEqual(['POST /classes/7/waitlist', 'DELETE /classes/7/waitlist']);
  });

  it('retries a leave on 503, since leaving twice is harmless', async () => {
    const { client, calls } = fakeClient({ 'DELETE /classes/7/waitlist': [503] });
    await expect(client.bookings.leaveWaitlist(7)).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(3);
  });
});
`,
  }, { author: maya, at: at('2026-09-09 17:25'), key: 's2' });

  const s3 = r.commit(s2, 'Return waitlist places from listMine', {
    'src/resources/bookings.ts': edits(
      ['  /** Your upcoming bookings, soonest first. */\n  listMine(): Promise<{ bookings: Booking[] }> {', '  /** Your upcoming bookings, and the waitlists you\'re on, soonest first. */\n  listMine(): Promise<{ bookings: Booking[]; waitlist: WaitlistPlace[] }> {'],
    ),
    'CHANGELOG.md': replace('# Changelog\n', '# Changelog\n\n## Unreleased\n\n- `bookings.listMine()` also returns `waitlist`: the waitlists you\'re on, with your position.\n'),
  }, { author: maya, at: at('2026-09-10 11:00'), key: 's3' });

  const s4 = r.commit(s3, 'Add acceptOffer for spots offered from the waitlist', {
    'src/resources/bookings.ts': replace(
      '  /** Your upcoming bookings',
      `  /**
   * Take a spot you were offered from a waitlist. Throws ApiError \`offer_gone\` (410) if the hold
   * ran out first: the spot went to the next person.
   */
  acceptOffer(placeId: number): Promise<Booking> {
    return this.client.request('POST', \`/me/offers/\${placeId}/accept\`);
  }

  /** Your upcoming bookings`,
    ),
    'CHANGELOG.md': after("with your position.\n", '- `bookings.acceptOffer()` takes a spot offered from a waitlist.\n'),
    'README.md': append(`
## Waitlists

When a class is full, join its waitlist. If a spot opens up you're offered it, and it's held for you
for two hours:

\`\`\`ts
await orchard.bookings.joinWaitlist(classId);
const { waitlist } = await orchard.bookings.listMine();
const offer = waitlist.find((p) => p.status === 'offered');
if (offer) await orchard.bookings.acceptOffer(offer.id);
\`\`\`
`),
  }, { author: maya, at: at('2026-09-11 09:35'), key: 's4' });

  r.ref('main', b8);
  r.ref('refs/remotes/origin/main', b8);
  r.ref('refs/remotes/origin/HEAD', b8);
  r.ref('maya/waitlists', s4);
  r.ref('maya/sdk-waitlist-types', s1);
  r.ref('maya/sdk-join-leave', s2);
  r.ref('maya/sdk-list-waitlist', s3);
  r.ref('refs/remotes/origin/maya/sdk-waitlist-types', s1);
  return r;
}
