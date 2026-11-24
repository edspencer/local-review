// One server-sent-events connection (/api/events) shared by every open tab. Browsers allow ~6 HTTP/1.1 connections per
// host, and each tab holding its own stream used them up, so later tabs' requests queued forever ("Loading…").
// Instead one tab (whoever holds the Web Lock) owns the EventSource and relays its events to the others over a
// BroadcastChannel. When that tab closes the lock passes to another tab, which announces `down` then `hello`, so the
// others refresh what they may have missed.

export interface LiveHandlers {
  onHello: () => void;
  onChange: (data: string) => void;
  onDown: () => void;
}

type Msg = { t: 'hello' } | { t: 'down' } | { t: 'ping' } | { t: 'change'; data: string };

function startSource(h: LiveHandlers, relay: (m: Msg) => void): () => void {
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout>;
  let stopped = false;
  const connect = () => {
    if (stopped) return;
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => { h.onHello(); relay({ t: 'hello' }); });
    es.addEventListener('change', (m) => {
      const data = (m as MessageEvent).data as string;
      h.onChange(data);
      relay({ t: 'change', data });
    });
    es.onerror = () => {
      h.onDown();
      relay({ t: 'down' });
      es?.close();
      retry = setTimeout(connect, 2000);
    };
  };
  connect();
  return () => { stopped = true; es?.close(); clearTimeout(retry); };
}

export function connectEvents(h: LiveHandlers): () => void {
  if (typeof BroadcastChannel === 'undefined' || !('locks' in navigator)) return startSource(h, () => {});

  const ch = new BroadcastChannel('lr-events');
  let closed = false;
  let leading = false;
  let live = false;
  let stop: (() => void) | null = null;
  let done: (() => void) | null = null;

  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data;
    if (m.t === 'ping') { if (leading && live) ch.postMessage({ t: 'hello' } satisfies Msg); return; }
    if (m.t === 'hello') h.onHello();
    else if (m.t === 'change') h.onChange(m.data);
    else h.onDown();
  };

  void navigator.locks.request('lr-events', () => new Promise<void>((resolve) => {
    if (closed) return resolve();
    leading = true;
    done = resolve;
    ch.postMessage({ t: 'down' } satisfies Msg); // a new leader: the others should refresh once it's connected
    stop = startSource(
      { ...h, onHello: () => { live = true; h.onHello(); }, onDown: () => { live = false; h.onDown(); } },
      (m) => ch.postMessage(m),
    );
  }));
  ch.postMessage({ t: 'ping' } satisfies Msg); // a tab that joins late learns the stream is live

  return () => {
    closed = true;
    stop?.();
    done?.();
    ch.close();
  };
}
