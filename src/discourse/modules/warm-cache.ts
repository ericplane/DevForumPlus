import type { DfpModule } from "../../core/registry";

/**
 * Persist prefetched topic payloads so they survive a page reload.
 *
 * ── Scope, and why it is narrow ──────────────────────────────────────────
 * PLAN.md §4.5 describes rendering a cached list immediately and reconciling
 * when the live response lands. That is not what this does, and the difference
 * matters: reconciliation requires pushing a second response into Ember's data
 * flow after it has already rendered, and there is no supported way to do that.
 * Serving stale data with no reconciliation would leave the user looking at
 * old content with no indication and no correction. That is worse than waiting.
 *
 * So this caches **topic bodies only**, with a short TTL, for one specific
 * reason: a topic served from cache keeps receiving live updates over
 * Discourse's message-bus the moment it renders. New replies arrive normally.
 * Staleness is bounded by the TTL *and* self-correcting, which is exactly the
 * property topic lists do not have — so lists are deliberately excluded.
 *
 * The store is IndexedDB, on the page origin, capped and LRU-evicted. It never
 * leaves the device.
 */

const DB_NAME = "dfp";
const STORE = "topics";
const DB_VERSION = 1;

/**
 * Short on purpose. Long enough to make back-navigation and reloads instant,
 * short enough that a cold open is never meaningfully behind.
 *
 * Exported because prefetch.ts must use the same number. It used to keep its
 * own 30s limit, so an entry this layer served at 45s was promoted into memory
 * and then refused at the click, and Discourse's request went to the server
 * anyway — the full 465ms median TTFB the prefetch exists to remove. For
 * two-thirds of this window the cache suppressed the prefetch that would have
 * worked. One number, checked through `isFresh`, on both sides.
 */
export const TTL_MS = 90_000;
/** Also the cap on what prefetch.ts holds in memory — never more than disk. */
export const MAX_ENTRIES = 20;

/** The one freshness rule, for the disk read and the in-memory serve alike. */
export function isFresh(at: number): boolean {
  return Date.now() - at <= TTL_MS;
}

export interface CachedTopic {
  path: string;
  body: string;
  contentType: string;
  status: number;
  at: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "path" }).createIndex("at", "at");
        }
      };
      req.onsuccess = () => resolve(req.result);
      // Private mode, disabled storage, corrupt profile — all non-fatal.
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function readTopic(path: string): Promise<CachedTopic | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = tx(db, "readonly").get(path);
      req.onsuccess = () => {
        const v = req.result as CachedTopic | undefined;
        if (!v) return resolve(null);
        resolve(isFresh(v.at) ? v : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function writeTopic(entry: CachedTopic): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    tx(db, "readwrite").put(entry);
    await evictIfNeeded(db);
  } catch {
    /* quota or a closed connection; nothing to recover */
  }
}

/** Oldest-first eviction, so the cache cannot grow without bound. */
function evictIfNeeded(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    try {
      const store = tx(db, "readwrite");
      const countReq = store.count();
      countReq.onsuccess = () => {
        const over = countReq.result - MAX_ENTRIES;
        if (over <= 0) return resolve();
        let removed = 0;
        const cursorReq = store.index("at").openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || removed >= over) return resolve();
          cursor.delete();
          removed++;
          cursor.continue();
        };
        cursorReq.onerror = () => resolve();
      };
      countReq.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearWarmCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    tx(db, "readwrite").clear();
  } catch {
    /* nothing to do */
  }
}

/**
 * The module itself only opens the database and prunes expired rows. Reads and
 * writes are driven by the prefetch transport, which is the only thing that
 * knows when a response is worth keeping — and it writes from both of its
 * paths, the hover fetch and the XHR Discourse actually loads a topic with.
 * Writing only from the hover was the reason "recently-read" meant
 * "recently-hovered": a topic opened from a notification or a search hit was
 * never here for the way back.
 */
export function warmCache(): DfpModule {
  return {
    id: "warm-cache",
    budgetMs: 60,

    isAvailable() {
      return typeof indexedDB !== "undefined";
    },

    install() {
      void openDb().then(async (db) => {
        if (!db) return;
        // Drop anything already stale so the store does not accumulate rows
        // that will never be served.
        try {
          const store = tx(db, "readwrite");
          const cutoff = Date.now() - TTL_MS;
          const req = store.index("at").openCursor(IDBKeyRange.upperBound(cutoff));
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            cursor.delete();
            cursor.continue();
          };
        } catch {
          /* pruning is best-effort */
        }
      });
    },
  };
}
