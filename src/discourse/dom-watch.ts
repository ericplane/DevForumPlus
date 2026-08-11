import { charge, installingModule } from "../core/registry";

/**
 * One MutationObserver for the whole main world.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * Eight modules each ran their own `observe(document.documentElement,
 * { childList: true, subtree: true })` — card-groups, facepile, op-pin,
 * post-groups, profile-groups, quiet-replies, search-signals and thread-view.
 * Discourse mutates the DOM constantly (timeline, relative dates, lazy images,
 * every re-render), so a single mutation woke eight callbacks, and each one
 * then queued its own rAF. Eight observers, eight callbacks, eight frames of
 * bookkeeping to answer one question.
 *
 * This is that question asked once. Records are accumulated across the frame
 * and handed to every watcher in one pass, so the coalescing happens here
 * rather than being re-implemented — slightly differently — in each module.
 *
 * ── Why records are passed through ──────────────────────────────────────────
 * Half the watchers only want to know THAT something changed; the other half
 * read `addedNodes` to avoid re-scanning the document. Handing over the batch
 * keeps both cheap. A watcher that ignores its argument is not paying for it.
 *
 * ── Attribution ─────────────────────────────────────────────────────────────
 * Whoever registers is charged for the time their watcher spends, which is what
 * makes `budgetMs` mean something for work that happens long after `install()`
 * returned. See registry.ts.
 * ───────────────────────────────────────────────────────────────────────────
 */

type Watcher = (records: MutationRecord[]) => void;

/** Watcher → the module that registered it, for time attribution. */
const watchers = new Map<Watcher, string | null>();

let observer: MutationObserver | null = null;
let queued = false;
let batch: MutationRecord[] = [];

function flush(): void {
  queued = false;
  const records = batch;
  batch = [];
  for (const [fn, owner] of watchers) {
    const t0 = performance.now();
    try {
      fn(records);
    } catch {
      /* One module's bad frame must not take the other seven down with it.
       * The registry already refuses to let an exception reach Discourse; this
       * keeps it from reaching a sibling either. */
    }
    charge(owner, performance.now() - t0);
  }
}

function ensureObserver(): void {
  if (observer) return;
  observer = new MutationObserver((records) => {
    /* `push(...records)` would spread a batch that Discourse can make very
     * large during a stream render, and a spread of tens of thousands of
     * arguments overflows the stack. */
    for (const r of records) batch.push(r);
    if (queued) return;
    queued = true;
    requestAnimationFrame(flush);
  });
  /* `childList` and `subtree` only, deliberately: several watchers write
   * attributes and inline styles, and observing attributes here would let them
   * trigger themselves. That constraint was already documented in
   * thread-view.ts and op-pin.ts, and is now enforced in one place. */
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

/**
 * Run `fn` after any batch of DOM changes, at most once per frame.
 *
 * Returns an unsubscribe, though nothing needs it yet: modules install once per
 * page and live as long as the document.
 */
export function onDomChange(fn: Watcher): () => void {
  watchers.set(fn, installingModule());
  ensureObserver();
  return () => {
    watchers.delete(fn);
  };
}

/** Test seam, and the honest way to prove the count is one. */
export function watcherCount(): number {
  return watchers.size;
}
