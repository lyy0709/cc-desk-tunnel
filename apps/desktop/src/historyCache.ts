import { historyPageStart } from '../electron/history-page.mjs';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';

// The history read from the service, kept in this browser profile so that a
// session opened again shows at once and asks the service only for what came since.
//
// A session's events never change once recorded, and a session's id is never used again, so what is kept stays
// true until the session is deleted or the service rewrites its history (it then names it anew). What is kept is
// never trusted on its own: opening a session tells the service which event it ends at, and the service says if
// that no longer holds. Anything going wrong here only means reading from the service, as without it.
//
// Each session's record says which stretches of it are held whole, as ranges (after, through]: every event
// numbered above `after` up to `through`. A write says what it covers itself, from what the service sent, so it
// holds whatever was written before it, and IndexedDB runs the transactions in the order they were made.

export type Range = [after: number, through: number];
type Held = { id: string; ranges: Range[] };
type Kept = { sessionId: string; sequence: number; event: SessionEvent };
type PageKey = [string, number, string, number, number];
export type HeldPage = {
  events: SessionEvent[];
  hasEarlier: boolean;
  gap?: boolean;
  lastSequence?: number;
};
export type CacheStats = { bytes: number | null; sessions: number; events: number };
export type HistoryDisk = Pick<
  HistoryCache,
  'historyId' | 'ready' | 'use' | 'retain' | 'write' | 'drop' | 'clear' | 'latest' | 'stats'
> & {
  earlier(
    sessionId: string,
    before: number,
    offline?: boolean,
  ): Promise<HeldPage | { after: number } | null>;
  update?(session: Session): void;
};

const writeFailed = (error: unknown) => console.warn('对话缓存写入失败', error);

const encoder = new TextEncoder();
function pageKey(event: SessionEvent): PageKey {
  const question = event.payload.type === 'message.user' ? (event.payload.continued ? 2 : 1) : 0;
  return [
    event.sessionId,
    event.sequence,
    event.runId,
    question,
    encoder.encode(JSON.stringify(event)).length,
  ];
}

export function addRange(ranges: Range[], range: Range): Range[] {
  const joined: Range[] = [];
  for (const [after, through] of [...ranges, range].sort((a, b) => a[0] - b[0])) {
    if (through <= after) continue;
    const last = joined.at(-1);
    if (last && after <= last[1]) last[1] = Math.max(last[1], through);
    else joined.push([after, through]);
  }
  return joined;
}
// The stretch held right below `before`, if there is any to read.
export function heldBelow(ranges: Range[], before: number) {
  return ranges.find(([after, through]) => after < before - 1 && through >= before - 1);
}
// Where a page fetched below `before` can stop: the end of what is held further down.
export function heldUnder(ranges: Range[], before: number) {
  return Math.max(0, ...ranges.filter(([, through]) => through < before - 1).map(([, t]) => t));
}

const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
const all = (sessionId: string) => IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);

export class HistoryCache {
  // Known once a service has said which history it keeps; until then nothing kept is used.
  historyId: string | null = null;
  private database: Promise<IDBDatabase | null>;

  constructor(name = 'history') {
    this.database =
      typeof indexedDB === 'undefined'
        ? Promise.resolve(null)
        : new Promise<IDBDatabase | null>((resolve) => {
            const request = indexedDB.open(name, 2);
            request.onupgradeneeded = ({ oldVersion }) => {
              const database = request.result;
              if (!oldVersion) {
                database.createObjectStore('about');
                database.createObjectStore('sessions', { keyPath: 'id' });
                database.createObjectStore('events', { keyPath: ['sessionId', 'sequence'] });
              }
              const events = request.transaction!.objectStore('events');
              const keys = database.createObjectStore('pageKeys');
              if (oldVersion) {
                const rows = events.openCursor();
                rows.onsuccess = () => {
                  const cursor = rows.result;
                  if (!cursor) return;
                  keys.put(pageKey(cursor.value.event), cursor.primaryKey);
                  cursor.continue();
                };
              }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = request.onblocked = () => resolve(null);
          });
  }
  get ready() {
    return this.historyId !== null;
  }

  // Every operation makes its transaction when the database is open, in the order they were asked for.
  private run<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction) => Promise<T> | T,
    verify = true,
  ): Promise<T | null> {
    const history = `${this.historyId}/${PROTOCOL_VERSION}`;
    return this.database.then(async (database) => {
      if (!database) return null;
      const transaction = database.transaction(verify ? [...stores, 'about'] : stores, mode);
      const [value] = await Promise.all([
        (async () => {
          if (verify && (await result(transaction.objectStore('about').get('history'))) !== history)
            return null;
          return work(transaction);
        })(),
        done(transaction),
      ]);
      return value;
    });
  }
  // Writes are best effort: a failed one leaves the service to supply what it would have held.
  private quietly(work: Promise<unknown>) {
    void work.catch(writeFailed);
  }

  // The history the service keeps now. Kept history of another one, or of another protocol, goes.
  use(historyId: string) {
    this.historyId = historyId;
    const name = `${historyId}/${PROTOCOL_VERSION}`;
    this.quietly(
      this.run(
        ['about', 'sessions', 'events', 'pageKeys'],
        'readwrite',
        async (transaction) => {
          const about = transaction.objectStore('about');
          if ((await result(about.get('history'))) === name) return;
          transaction.objectStore('sessions').clear();
          transaction.objectStore('events').clear();
          transaction.objectStore('pageKeys').clear();
          about.put(name, 'history');
        },
        false,
      ),
    );
  }
  // Sessions the service no longer has, deleted while this client was away, go.
  retain(sessions: Session[]) {
    const known = new Set(sessions.map(({ id }) => id));
    this.quietly(
      this.run(['sessions', 'events', 'pageKeys'], 'readwrite', async (transaction) => {
        for (const id of await result(transaction.objectStore('sessions').getAllKeys()))
          if (!known.has(String(id))) this.remove(transaction, String(id));
      }),
    );
  }
  write({ id: sessionId }: Session, events: SessionEvent[], range: Range) {
    if (!this.ready || (!events.length && range[1] <= range[0])) return;
    this.quietly(
      this.run(['sessions', 'events', 'pageKeys'], 'readwrite', async (transaction) => {
        const store = transaction.objectStore('events');
        const keys = transaction.objectStore('pageKeys');
        for (const event of events) {
          store.put({ sessionId, sequence: event.sequence, event } satisfies Kept);
          keys.put(pageKey(event), [sessionId, event.sequence]);
        }
        const sessions = transaction.objectStore('sessions');
        const held = (await result(sessions.get(sessionId))) as Held | undefined;
        sessions.put({ id: sessionId, ranges: addRange(held?.ranges ?? [], range) } satisfies Held);
      }),
    );
  }
  drop(sessionId: string) {
    this.quietly(
      this.run(['sessions', 'events', 'pageKeys'], 'readwrite', (transaction) =>
        this.remove(transaction, sessionId),
      ),
    );
  }
  clear() {
    this.quietly(
      this.run(['sessions', 'events', 'pageKeys'], 'readwrite', (transaction) => {
        transaction.objectStore('sessions').clear();
        transaction.objectStore('events').clear();
        transaction.objectStore('pageKeys').clear();
      }),
    );
  }
  private remove(transaction: IDBTransaction, sessionId: string) {
    transaction.objectStore('sessions').delete(sessionId);
    transaction.objectStore('events').delete(all(sessionId));
    transaction.objectStore('pageKeys').delete(all(sessionId));
  }

  // The newest page held of a session, to show while the service is asked for what came since.
  async latest(sessionId: string): Promise<HeldPage | null> {
    if (!this.ready) return null;
    return this.read(sessionId, (ranges) => ranges.at(-1), Infinity).catch(() => null);
  }
  // The page held right below `before`, or where the service's page can stop if none is held.
  async earlier(sessionId: string, before: number): Promise<HeldPage | { after: number } | null> {
    if (!this.ready) return null;
    try {
      let ranges: Range[] = [];
      const page = await this.read(sessionId, (held) => heldBelow((ranges = held), before), before);
      return page?.events.length ? page : { after: heldUnder(ranges, before) };
    } catch {
      return null;
    }
  }
  // Whole runs from the end of a held stretch down, as the service pages them.
  private async read(
    sessionId: string,
    stretch: (ranges: Range[]) => Range | undefined,
    before: number,
  ): Promise<HeldPage | null> {
    return this.run(['sessions', 'events', 'pageKeys'], 'readonly', async (transaction) => {
      const held = (await result(transaction.objectStore('sessions').get(sessionId))) as
        Held | undefined;
      const range = held && stretch(held.ranges);
      if (!range) return null;
      const store = transaction.objectStore('events');
      const end = Math.min(before, range[1] + 1);
      const keys = (await result(
        transaction
          .objectStore('pageKeys')
          .getAll(IDBKeyRange.bound([sessionId, range[0]], [sessionId, end], true, true)),
      )) as PageKey[];
      const first = historyPageStart(keys);
      if (first === undefined) return null;
      const rows = (await result(
        store.getAll(IDBKeyRange.bound([sessionId, first], [sessionId, end], false, true)),
      )) as Kept[];
      return {
        events: rows.map((row) => row.event),
        hasEarlier: first > keys[0][1] || range[0] > 0,
      };
    });
  }

  async stats(): Promise<CacheStats | null> {
    const counts = await this.run(
      ['sessions', 'events', 'pageKeys'],
      'readonly',
      async (transaction) => ({
        sessions: await result(transaction.objectStore('sessions').count()),
        events: await result(transaction.objectStore('events').count()),
      }),
    ).catch(() => null);
    if (!counts) return null;
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    return { ...counts, bytes: estimate?.usage ?? null };
  }
}

type CacheCommand =
  | { type: 'use' | 'list' | 'clear' | 'stats' }
  | { type: 'read'; sessionId: string; before?: number; offline?: boolean }
  | { type: 'write'; session: Session; events: SessionEvent[]; range: Range }
  | { type: 'metadata'; session: Session }
  | { type: 'retain'; sessions: Session[] }
  | { type: 'drop'; sessionId: string };

export type CachePort = (
  command: CacheCommand & { url: string; protocol: number; history?: string },
) => Promise<unknown>;

// Electron keeps one SQLite cache per service inside the connection's own profile.
export class DesktopHistoryCache implements HistoryDisk {
  historyId: string | null = null;
  private url: string;
  private port: CachePort;

  constructor(url: string, port: CachePort) {
    this.url = new URL(url).href;
    this.port = port;
  }
  get ready() {
    return this.historyId !== null;
  }
  private request<T>(command: CacheCommand) {
    return this.port({
      ...command,
      url: this.url,
      protocol: PROTOCOL_VERSION,
      ...(this.historyId ? { history: `${this.historyId}/${PROTOCOL_VERSION}` } : {}),
    }) as Promise<T>;
  }
  use(historyId: string) {
    this.historyId = historyId;
    void this.request({ type: 'use' }).catch(writeFailed);
  }
  retain(sessions: Session[]) {
    void this.request({ type: 'retain', sessions }).catch(writeFailed);
  }
  update(session: Session) {
    void this.request({ type: 'metadata', session }).catch(writeFailed);
  }
  write(session: Session, events: SessionEvent[], range: Range) {
    if (events.length || range[1] > range[0])
      void this.request({ type: 'write', session, events, range }).catch(writeFailed);
  }
  drop(sessionId: string) {
    void this.request({ type: 'drop', sessionId }).catch(writeFailed);
  }
  clear() {
    void this.request({ type: 'clear' }).catch(writeFailed);
  }
  latest(sessionId: string) {
    return this.request<HeldPage | null>({ type: 'read', sessionId });
  }
  earlier(sessionId: string, before: number, offline = false) {
    return this.request<HeldPage | { after: number } | null>({
      type: 'read',
      sessionId,
      before,
      offline,
    });
  }
  stats() {
    return this.request<CacheStats | null>({ type: 'stats' }).catch((error: unknown) => {
      console.warn('无法读取对话缓存占用', error);
      return null;
    });
  }
  async list() {
    return (await this.request<Session[] | null>({ type: 'list' })) ?? [];
  }
}
