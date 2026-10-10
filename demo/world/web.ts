// orchard-web: the members' web app (React + Vite), on @orchard/sdk. Files that change over many commits are
// templates of a "stage" number, so each commit writes the whole file as of that stage.
import { RepoBuilder, replace } from '../lib/gitworld.ts';
import { at, june, maya, remote, sam, theo } from './people.ts';

const append = (s: string) => (old: string) => old + s;

/** ClassCard.tsx: 2 schedule, 3 book, 6 spots left, 8 studio timezone, 10 join waitlist */
function classCard(stage: number): string {
  const time =
    stage >= 8
      ? "{formatClassTime(cls.starts_at, timeZone)} · {cls.minutes} min"
      : "{new Date(cls.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {cls.minutes} min";
  const imports = [
    stage >= 3 ? "import { useState } from 'react';\n" : '',
    "import type { Class } from '@orchard/sdk';\n",
    stage >= 8 ? "import { formatClassTime } from '../format';\n" : '',
  ].join('');
  if (stage < 3)
    return `${imports}
export function ClassCard({ cls }: { cls: Class }) {
  return (
    <article className="class-card">
      <header>
        <h3>{cls.title}</h3>
        <span className="coach">with {cls.coach}</span>
      </header>
      <p className="when">
        ${time}
      </p>
    </article>
  );
}
`;
  const props =
    stage >= 10
      ? `interface Props {
  cls: Class;
  booked: boolean;
  /** Your place in this class's waitlist, if you're on it. */
  waitlistPosition?: number;
  onBook: () => Promise<void>;
  onJoinWaitlist: () => Promise<void>;${stage >= 8 ? '\n  timeZone: string;' : ''}
}`
      : `interface Props {
  cls: Class;
  booked: boolean;
  onBook: () => Promise<void>;${stage >= 8 ? '\n  timeZone: string;' : ''}
}`;
  const args = stage >= 10 ? `{ cls, booked, waitlistPosition, onBook, onJoinWaitlist${stage >= 8 ? ', timeZone' : ''} }` : `{ cls, booked, onBook${stage >= 8 ? ', timeZone' : ''} }`;
  const full = stage >= 6 ? '\n  const full = cls.spots_left === 0;' : '';
  const spots =
    stage >= 6
      ? `
        <span className="spots" id={\`spots-\${cls.id}\`}>
          {full ? 'Full' : \`\${cls.spots_left} of \${cls.capacity} left\`}
        </span>`
      : '';
  let action: string;
  if (stage >= 10)
    action = `        {booked ? (
          <span className="pill pill-booked">Booked</span>
        ) : waitlistPosition ? (
          <span className="pill pill-waiting">#{waitlistPosition} in line</span>
        ) : full ? (
          <button className="secondary" disabled={busy} onClick={() => run(onJoinWaitlist)}>
            Join waitlist
          </button>
        ) : (
          <button className="primary" disabled={busy} onClick={() => run(onBook)}>
            Book
          </button>
        )}`;
  else
    action = `        {booked ? (
          <span className="pill pill-booked">Booked</span>
        ) : (
          <button className="primary" disabled={busy${stage >= 6 ? ' || full' : ''}} onClick={() => run(onBook)}>
            Book
          </button>
        )}`;
  return `${imports}
${props}

export function ClassCard(${args}: Props) {
  const [busy, setBusy] = useState(false);${full}
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="class-card">
      <header>
        <h3>{cls.title}</h3>
        <span className="coach">with {cls.coach}</span>
      </header>
      <p className="when">
        ${time}
      </p>
      <footer>${spots}
${action}
      </footer>
    </article>
  );
}
`;
}

/** MyBookings.tsx: 4 list, 5 cancel, 8 timezone, 11 waitlist places, 12 offer banner, 13 hold-window copy */
function myBookings(stage: number): string {
  const tz = stage >= 8;
  const when = (v: string) => (tz ? `formatClassTime(${v}.starts_at, timeZone)` : `new Date(${v}.starts_at).toLocaleString()`);
  const imports = [
    "import { useEffect, useState } from 'react';\n",
    `import type { Booking${stage >= 11 ? ', WaitlistPlace' : ''} } from '@orchard/sdk';\n`,
    stage >= 12 ? "import { Banner } from '../components/Banner';\n" : '',
    tz ? "import { formatClassTime } from '../format';\n" : '',
    "import { orchard } from '../orchard';\n",
  ].join('');
  const state =
    stage >= 11
      ? `  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistPlace[]>([]);

  const load = () =>
    orchard.bookings.listMine().then((r) => {
      setBookings(r.bookings);
      setWaitlist(r.waitlist);
    });`
      : `  const [bookings, setBookings] = useState<Booking[] | null>(null);

  const load = () => orchard.bookings.listMine().then((r) => setBookings(r.bookings));`;
  const cancel =
    stage >= 5
      ? `

  const cancel = async (b: Booking) => {
    if (!confirm(\`Cancel \${b.class?.title}? Your spot goes to the next person waiting.\`)) return;
    await orchard.bookings.cancel(b.id, { ignoreMissing: true });
    await load();
  };`
      : '';
  const accept =
    stage >= 12
      ? `

  const accept = async (p: WaitlistPlace) => {
    await orchard.bookings.acceptOffer(p.id);
    await load();
  };
  const offers = waitlist.filter((p) => p.status === 'offered');`
      : '';
  const holdCopy =
    stage >= 13
      ? `
          <p>
            We're holding it for you until <strong>{formatHoldTime(p.hold_until!, timeZone)}</strong>. After that it
            goes to the next person in line, and you'll stay on the waitlist.
          </p>`
      : `
          <p>A spot opened up and it's yours if you want it.</p>`;
  const banner =
    stage >= 12
      ? `
      {offers.map((p) => (
        <Banner key={p.id} tone="success" title={\`A spot opened up in \${p.class?.title}\`}>${holdCopy}
          <button className="primary" onClick={() => accept(p)}>
            Take the spot
          </button>
        </Banner>
      ))}`
      : '';
  const cancelButton =
    stage >= 5
      ? `
            <button className="link danger" onClick={() => cancel(b)}>
              Cancel
            </button>`
      : '';
  const waitlistSection =
    stage >= 11
      ? `
      {waitlist.length > 0 && (
        <>
          <h2>Waitlists</h2>
          <ul className="booking-list">
            {waitlist.map((p) => (
              <li key={p.id}>
                <strong>{p.class?.title}</strong>
                <span className="muted">{p.class && ${when('p.class')}}</span>
                {p.status === 'offered' ? (
                  <span className="pill pill-offer">Spot held for you</span>
                ) : (
                  <span className="pill pill-waiting" title="Your place in the line">
                    #{p.position} in line
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}`
      : '';
  const sig = tz ? 'export function MyBookings({ timeZone }: { timeZone: string }) {' : 'export function MyBookings() {';
  const holdFn =
    stage >= 13
      ? `
/** "15:30", or "tomorrow 07:10" when the hold runs past midnight. */
function formatHoldTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });
  const day = (x: Date) => x.toLocaleDateString('en-CA', { timeZone });
  return day(d) === day(new Date()) ? time : \`tomorrow \${time}\`;
}
`
      : '';
  return `${imports}
${sig}
${state}${cancel}${accept}

  useEffect(() => {
    load();
  }, []);

  if (!bookings) return <p className="muted">Loading…</p>;
  return (
    <section>
      <h1>My bookings</h1>${banner}
      {bookings.length === 0 ? (
        <p className="empty">Nothing booked yet. Find a class on the schedule.</p>
      ) : (
        <ul className="booking-list">
          {bookings.map((b) => (
            <li key={b.id}>
              <strong>{b.class?.title}</strong>
              <span className="muted">{b.class && ${when('b.class')}}</span>${cancelButton}
            </li>
          ))}
        </ul>
      )}${waitlistSection}
    </section>
  );
}
${holdFn}`;
}

/** Schedule.tsx: 2 list, 3 book, 8 timezone, 10 join waitlist */
function schedule(stage: number): string {
  const tz = stage >= 8;
  const cardProps =
    stage >= 10
      ? `
            booked={booked.has(c.id)}
            waitlistPosition={waiting.get(c.id)}
            onBook={() => book(c)}
            onJoinWaitlist={() => joinWaitlist(c)}${tz ? '\n            timeZone={timeZone}' : ''}`
      : stage >= 3
        ? `
            booked={booked.has(c.id)}
            onBook={() => book(c)}${tz ? '\n            timeZone={timeZone}' : ''}`
        : '';
  const state =
    stage >= 3
      ? `
  const [booked, setBooked] = useState(new Set<number>());${stage >= 10 ? '\n  const [waiting, setWaiting] = useState(new Map<number, number>());' : ''}
  const [error, setError] = useState<string | null>(null);

  const book = async (c: Class) => {
    setError(null);
    try {
      await orchard.bookings.book(c.id);
      setBooked((s) => new Set(s).add(c.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Booking failed. Try again.');
    }
  };${
    stage >= 10
      ? `

  const joinWaitlist = async (c: Class) => {
    setError(null);
    try {
      const place = await orchard.bookings.joinWaitlist(c.id);
      setWaiting((m) => new Map(m).set(c.id, place.position));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't join the waitlist. Try again.");
    }
  };`
      : ''
  }`
      : '';
  return `import { useEffect, useState } from 'react';
import { ${stage >= 3 ? 'ApiError, ' : ''}type Class } from '@orchard/sdk';
import { ClassCard } from '../components/ClassCard';
import { orchard } from '../orchard';

${tz ? 'export function Schedule({ studioId, timeZone }: { studioId: number; timeZone: string }) {' : 'export function Schedule({ studioId }: { studioId: number }) {'}
  const [classes, setClasses] = useState<Class[] | null>(null);${state}

  useEffect(() => {
    orchard.classes.schedule(studioId).then((r) => setClasses(r.classes));
  }, [studioId]);

  if (!classes) return <p className="muted">Loading the schedule…</p>;
  return (
    <section>
      <h1>This week</h1>${stage >= 3 ? '\n      {error && <p className="error">{error}</p>}' : ''}
      <div className="class-grid">
        {classes.map((c) => (
          <ClassCard key={c.id} cls={c}${cardProps}${stage >= 3 ? '\n          ' : ' '}/>
        ))}
      </div>
    </section>
  );
}
`.replace('<ClassCard key={c.id} cls={c}\n            booked', '<ClassCard\n            key={c.id}\n            cls={c}\n            booked');
}

export function buildWeb() {
  const r = new RepoBuilder('orchard-web', remote('orchard-web'));

  const c1 = r.commit(null, 'Scaffold the web app with Vite and React', {
    'package.json': `{
  "name": "orchard-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "@orchard/sdk": "^0.6.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "vitest": "^2.0.5"
  }
}
`,
    'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8080' } },
});
`,
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Orchard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    'src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    'src/App.tsx': `export function App() {
  return (
    <main className="app">
      <h1>Orchard</h1>
    </main>
  );
}
`,
    'src/styles.css': `:root {
  --green: #2f6b3a;
  --ink: #1d2420;
  --muted: #66706a;
  --line: #dfe5df;
  font-family: system-ui, sans-serif;
  color: var(--ink);
}

.app {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px;
}

.muted {
  color: var(--muted);
}
`,
    'README.md': `# orchard-web

The members' web app: the class schedule, booking, and My bookings.

    npm install
    npm run dev     # proxies /api to orchard-api on :8080
`,
  }, { author: june, at: at('2026-05-22 15:30') });

  const c2 = r.commit(c1, 'Add the schedule page', {
    'src/orchard.ts': `import { OrchardClient } from '@orchard/sdk';

/** The app's API client. The session token comes from the sign-in page. */
export const orchard = new OrchardClient({
  baseUrl: \`\${location.origin}/api/\`,
  token: localStorage.getItem('orchard.token') ?? '',
});
`,
    'src/components/ClassCard.tsx': classCard(2),
    'src/pages/Schedule.tsx': schedule(2),
    'src/App.tsx': `import { Schedule } from './pages/Schedule';

export function App() {
  return (
    <main className="app">
      <Schedule studioId={1} />
    </main>
  );
}
`,
    'src/styles.css': append(`
.class-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.class-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
}

.class-card h3 {
  margin: 0;
  font-size: 16px;
}
`),
  }, { author: june, at: at('2026-05-30 12:10') });

  const c3 = r.commit(c2, 'Book a class from the schedule', {
    'src/components/ClassCard.tsx': classCard(3),
    'src/pages/Schedule.tsx': schedule(3),
    'src/styles.css': append(`
.class-card footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
}

button.primary {
  background: var(--green);
  color: white;
  border: 0;
  border-radius: 6px;
  padding: 6px 14px;
}

button:disabled {
  opacity: 0.5;
}

.pill {
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}

.pill-booked {
  background: #e3f1e5;
  color: var(--green);
}

.error {
  color: #b42318;
}
`),
  }, { author: theo, at: at('2026-06-06 10:45') });

  const c4 = r.commit(c3, 'Add My bookings', {
    'src/pages/MyBookings.tsx': myBookings(4),
    'src/App.tsx': `import { useState } from 'react';
import { MyBookings } from './pages/MyBookings';
import { Schedule } from './pages/Schedule';

type Tab = 'schedule' | 'bookings';

export function App() {
  const [tab, setTab] = useState<Tab>('schedule');
  return (
    <main className="app">
      <nav className="tabs">
        <button aria-pressed={tab === 'schedule'} onClick={() => setTab('schedule')}>
          Schedule
        </button>
        <button aria-pressed={tab === 'bookings'} onClick={() => setTab('bookings')}>
          My bookings
        </button>
      </nav>
      {tab === 'schedule' ? <Schedule studioId={1} /> : <MyBookings />}
    </main>
  );
}
`,
    'src/styles.css': append(`
.booking-list {
  list-style: none;
  padding: 0;
}

.booking-list li {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}

.empty {
  color: var(--muted);
  font-style: italic;
}
`),
  }, { author: june, at: at('2026-06-16 14:20') });

  const c5 = r.commit(c4, 'Let members cancel from My bookings', {
    'src/pages/MyBookings.tsx': myBookings(5),
    'src/styles.css': append(`
button.link {
  background: none;
  border: 0;
  padding: 0;
  text-decoration: underline;
  cursor: pointer;
}

button.danger {
  color: #b42318;
}
`),
  }, { author: maya, at: at('2026-06-25 11:30') });

  const c6 = r.commit(c5, 'Show spots left on each class card', {
    'src/components/ClassCard.tsx': classCard(6),
    'src/styles.css': append(`
.spots {
  font-size: 13px;
  color: var(--muted);
}
`),
  }, { author: june, at: at('2026-07-08 16:05') });

  const c7 = r.commit(c6, 'Add a banner component for page-level messages', {
    'src/components/Banner.tsx': `import type { ReactNode } from 'react';

interface Props {
  tone: 'info' | 'success' | 'warning';
  title: string;
  children?: ReactNode;
}

/** A message across the top of a page. role="status" so screen readers announce it when it appears. */
export function Banner({ tone, title, children }: Props) {
  return (
    <div className={\`banner banner-\${tone}\`} role="status">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
`,
    'src/styles.css': append(`
.banner {
  border-radius: 10px;
  padding: 12px 16px;
  margin-bottom: 16px;
  display: grid;
  gap: 6px;
}

.banner-info {
  background: #eef4fb;
}

.banner-success {
  background: #e3f1e5;
}

.banner-warning {
  background: #fdf3e1;
}
`),
  }, { author: sam, at: at('2026-07-15 09:50') });

  const c8 = r.commit(c7, "Format class times in the studio's timezone\n\nMembers travelling saw classes at their own local time. A class is at the studio, so show the\nstudio's wall-clock time.", {
    'src/format.ts': `/** "Mon 21 Sep, 07:00", in the studio's timezone (not the browser's). */
export function formatClassTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}
`,
    'src/format.test.ts': `import { expect, it } from 'vitest';
import { formatClassTime } from './format';

it("shows the studio's wall-clock time", () => {
  expect(formatClassTime('2026-09-21T06:00:00Z', 'Europe/London')).toBe('Mon 21 Sept, 07:00');
});
`,
    'src/components/ClassCard.tsx': classCard(8),
    'src/pages/Schedule.tsx': schedule(8),
    'src/pages/MyBookings.tsx': myBookings(8),
    'src/App.tsx': (s: string) =>
      replace("const [tab, setTab] = useState<Tab>('schedule');\n", "const [tab, setTab] = useState<Tab>('schedule');\n  const timeZone = 'Europe/London'; // TODO: from the studio, once the API returns it\n")(s).replace(
        "{tab === 'schedule' ? <Schedule studioId={1} /> : <MyBookings />}",
        "{tab === 'schedule' ? <Schedule studioId={1} timeZone={timeZone} /> : <MyBookings timeZone={timeZone} />}",
      ),
  }, { author: june, at: at('2026-08-12 13:25') });

  // ---------------------------------------------------------------- Maya's waitlists branch
  const w0 = r.commit(c8, 'Bump @orchard/sdk to 0.8.0-beta.1', {
    'package.json': replace('"@orchard/sdk": "^0.6.0"', '"@orchard/sdk": "0.8.0-beta.1"'),
  }, { author: maya, at: at('2026-09-11 14:00'), key: 'w0' });

  const w1 = r.commit(w0, 'Add a Join waitlist button to full classes', {
    'src/components/ClassCard.tsx': classCard(10),
    'src/pages/Schedule.tsx': schedule(10),
    'src/styles.css': append(`
button.secondary {
  background: white;
  color: var(--green);
  border: 1px solid var(--green);
  border-radius: 6px;
  padding: 5px 13px;
}

.pill-waiting {
  background: #fdf3e1;
  color: #8a5a00;
}
`),
  }, { author: maya, at: at('2026-09-11 16:40'), key: 'w1' });

  const w2 = r.commit(w1, 'Show waitlist position on My bookings', {
    'src/pages/MyBookings.tsx': myBookings(11),
  }, { author: maya, at: at('2026-09-12 10:15'), key: 'w2' });

  const w3 = r.commit(w2, 'Add the spot-offered banner', {
    'src/pages/MyBookings.tsx': myBookings(12),
    'src/styles.css': append(`
.pill-offer {
  background: #e3f1e5;
  color: var(--green);
  font-weight: 600;
}
`),
  }, { author: maya, at: at('2026-09-12 14:50'), key: 'w3' });

  const w4 = r.commit(w3, 'Explain the hold window in the offer banner', {
    'src/pages/MyBookings.tsx': myBookings(13),
  }, { author: maya, at: at('2026-09-15 11:20'), key: 'w4' });

  r.ref('main', c8);
  r.ref('refs/remotes/origin/main', c8);
  r.ref('refs/remotes/origin/HEAD', c8);
  r.ref('maya/waitlists', w4);
  r.ref('maya/web-join-button', w1);
  r.ref('maya/web-waitlist-position', w2);
  return r;
}
