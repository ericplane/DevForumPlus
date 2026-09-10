import type { DfpModule } from "../../core/registry";
import { mark } from "../../core/perf";
import { TOPIC_HREF, primeTopic } from "../topic-data";
import { MAX_ENTRIES, isFresh, readTopic, writeTopic, type CachedTopic } from "./warm-cache";

/**
 * Hover prefetch for topic navigation.
 *
 * Measured on the live forum before building this: every SPA navigation waits
 * on one JSON request whose median is 465ms and p90 543ms — and essentially all
 * of it is TTFB (534ms of a 543ms request; the download is 6–8ms). The payload
 * is tiny and the wait is pure server latency, so there is nothing to optimise
 * about the request itself. The only way to remove that wait from the click is
 * to have started it earlier.
 *
 * ── Why this patches XMLHttpRequest ──────────────────────────────────────
 * PLAN.md §4.2 proposed wrapping `discourse/lib/ajax`. That does not work:
 * `ajax` is an ES module namespace export — getter-only and non-configurable —
 * so assigning to it fails silently. Verified on the live site.
 *
 * Every Discourse API call goes out as XMLHttpRequest (jQuery.ajax), and
 * `XMLHttpRequest.prototype.open`/`send` are both writable and configurable.
 * So the interception happens at the transport instead.
 *
 * ── Why the real request still goes out ──────────────────────────────────
 * Serving a cached body would silently drop the request's side effects — most
 * importantly `track_visit`, which is how Discourse marks a topic read. So a
 * served response is replayed in the background with the URL Discourse actually
 * asked for. The user gets the instant render; the server still gets told.
 *
 * ── What else the transport sees ─────────────────────────────────────────
 * Sitting on `send` means every topic body Discourse loads passes through
 * here, hit or miss. Two things now ride on that: the body is handed to
 * topic-data (`primeTopic`) so stale-answer, thread-view and the rest do not
 * fetch it a second time — one duplicate request per topic view, before — and
 * a real load is written to the warm cache, so a topic you actually opened is
 * warm on the way back rather than only one you happened to hover.
 */

/** Exported for prefetch.test.ts, which waits it out rather than guessing. */
export const HOVER_DWELL_MS = 120;
const MAX_IN_FLIGHT = 4;
const MAX_PER_MINUTE = 40;
const BACKOFF_MS = 5 * 60_000;

export interface CachedResponse {
  status: number;
  statusText: string;
  body: string;
  contentType: string;
  at: number;
}

const cache = new Map<string, CachedResponse>();
const inFlight = new Map<string, AbortController>();
let recentCount = 0;
let recentWindowStart = 0;
let disabledUntil = 0;

/**
 * Topic payloads only — never message-bus, never anything that mutates.
 *
 * Both shapes Discourse loads a topic through: `/t/{id}.json` for the head of
 * the thread, `/t/{id}/{n}.json` for the twenty-post window around post n
 * (verified live: n=85 answers 66–85). The second is not the rare case it
 * looks. A list row you have partly read links to `/t/slug/{id}/{n}` — that is
 * Discourse's lastUnreadUrl — and its click requests the numbered form, so on
 * /latest every such row was a guaranteed miss while only the first shape was
 * prefetched.
 */
export function isPrefetchable(pathname: string): boolean {
  return /^\/t\/\d+(?:\/\d+)?\.json$/.test(pathname);
}

/** The topic id inside a prefetchable path, for handing its body to topic-data. */
function topicIdOf(key: string): number | null {
  const m = /^\/t\/(\d+)/.exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * The JSON Discourse will ask for when this topic link is clicked.
 *
 * `TOPIC_HREF` keeps the post number, and so does this: an earlier version
 * matched `/t/slug/(\d+)` and dropped it, warming `/t/{id}.json` for a link
 * whose click loads `/t/{id}/{n}.json` — the prefetch landed, and the click
 * paid the full TTFB anyway.
 */
export function prefetchPathFor(pathname: string): string | null {
  const m = TOPIC_HREF.exec(pathname);
  if (!m) return null;
  return m[2] ? `/t/${m[1]}/${m[2]}.json` : `/t/${m[1]}.json`;
}

/** Query is deliberately excluded: Discourse varies track_visit and forceLoad
 *  between the hover and the click, but the topic body is the same either way. */
function keyFor(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl, location.origin);
    if (u.origin !== location.origin) return null;
    if (!isPrefetchable(u.pathname)) return null;
    return u.pathname;
  } catch {
    return null;
  }
}

function budgetAllows(): boolean {
  const now = Date.now();
  if (now < disabledUntil) return false;
  if (inFlight.size >= MAX_IN_FLIGHT) return false;

  if (now - recentWindowStart > 60_000) {
    recentWindowStart = now;
    recentCount = 0;
  }
  return recentCount < MAX_PER_MINUTE;
}

/** Respect the user's data preferences before spending their bandwidth. */
function connectionAllows(): boolean {
  const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } })
    .connection;
  if (!c) return true;
  if (c.saveData) return false;
  return c.effectiveType !== "2g" && c.effectiveType !== "slow-2g";
}

/**
 * Put a body in memory.
 *
 * Entries leave by being served (single-use) or by expiring, and nothing else
 * drained the map: at the hover budget of 40 a minute and 51 kB a body, an
 * hour of browsing lists could hold a hundred megabytes of topics nobody
 * clicked. So an insert drops what has expired and then holds the map to the
 * same cap as the disk layer, oldest insert first.
 */
function hold(key: string, entry: CachedResponse): void {
  for (const [k, v] of cache) if (!isFresh(v.at)) cache.delete(k);
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * A disk entry into memory, dated when it was fetched — not now — so it
 * expires on the same clock the disk layer read it against.
 */
export function promote(persisted: CachedTopic): void {
  hold(persisted.path, {
    status: persisted.status,
    statusText: "OK",
    body: persisted.body,
    contentType: persisted.contentType,
    at: persisted.at,
  });
}

/**
 * Single-use: a served entry is dropped so a later visit gets fresh data.
 *
 * Freshness is warm-cache's `isFresh`, not a second limit. With a 30s limit of
 * its own, everything the disk layer served between 30s and 90s old was
 * promoted here and then refused at the click — see warm-cache.ts on TTL_MS.
 */
export function takeFresh(key: string): CachedResponse | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  return isFresh(hit.at) ? hit : null;
}

/** Hand a topic body to topic-data, so its consumers do not fetch it again. */
function share(key: string, body: string): void {
  const id = topicIdOf(key);
  if (id !== null) primeTopic(id, body);
}

/**
 * The disk step on its own: what an earlier visit left in the warm cache,
 * promoted into memory so the next `send` finds it. No network, no budget.
 * Resolves true when a fetch would add nothing — a fresh body is already
 * held, or one is on its way — which is how `prefetchTopic` decides whether
 * to go on, and the whole of what a touch-down does (`installHoverIntent`).
 */
async function warmFromDisk(topicPath: string): Promise<boolean> {
  if (inFlight.has(topicPath)) return true;
  const held = cache.get(topicPath);
  if (held) {
    if (isFresh(held.at)) return true;
    // Expired in memory. The hover is the moment to replace it — leaving it
    // for the click to discard is a guaranteed miss.
    cache.delete(topicPath);
  }

  const persisted = await readTopic(topicPath);
  if (!persisted) return false;
  promote(persisted);
  mark(`prefetch:warm-hit:${topicPath}`);
  return true;
}

async function prefetchTopic(topicPath: string): Promise<void> {
  if (await warmFromDisk(topicPath)) return;
  // The disk read is an await, and a second call for the same path can have
  // started its fetch inside it.
  if (inFlight.has(topicPath)) return;
  if (!budgetAllows() || !connectionAllows()) return;

  const controller = new AbortController();
  inFlight.set(topicPath, controller);
  recentCount++;

  try {
    // `track_visit=false` is mandatory: a prefetch must never mark a topic read
    // just because the pointer passed over its title.
    const res = await fetch(`${topicPath}?track_visit=false`, {
      signal: controller.signal,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });

    if (res.status === 429 || res.status >= 500) {
      disabledUntil = Date.now() + BACKOFF_MS;
      return;
    }
    if (!res.ok) return;

    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "application/json; charset=utf-8";
    const at = Date.now();
    hold(topicPath, { status: res.status, statusText: res.statusText, body, contentType, at });
    // Survive a reload. Topics are safe to persist because message-bus keeps
    // a rendered topic live — see warm-cache.ts for why lists are not.
    void writeTopic({ path: topicPath, body, contentType, status: res.status, at });
    mark(`prefetch:stored:${topicPath}`);
  } catch {
    // Aborted or offline. Neither is worth reporting.
  } finally {
    inFlight.delete(topicPath);
  }
}

type PatchedXhr = XMLHttpRequest & {
  __dfpMethod?: string;
  __dfpUrl?: string;
};

/**
 * Hand a cached body to an XHR that has not been sent.
 *
 * jQuery reads status, responseText, response, readyState and the header
 * accessors, so all of them are defined on the instance before the events fire.
 * Anything unexpected falls through to a real request rather than guessing.
 */
function fulfil(xhr: PatchedXhr, cached: CachedResponse, realSend: () => void): boolean {
  try {
    const define = (prop: string, value: unknown) =>
      Object.defineProperty(xhr, prop, { configurable: true, value });

    define("readyState", 4);
    define("status", cached.status);
    define("statusText", cached.statusText || "OK");
    define("responseText", cached.body);
    define("response", cached.body);
    define("responseType", "");
    define("responseURL", new URL(xhr.__dfpUrl ?? "", location.origin).href);
    define("getAllResponseHeaders", () => `content-type: ${cached.contentType}\r\n`);
    define("getResponseHeader", (name: string) =>
      String(name).toLowerCase() === "content-type" ? cached.contentType : null,
    );

    // Let the caller finish wiring handlers before they fire.
    queueMicrotask(() => {
      try {
        xhr.dispatchEvent(new Event("readystatechange"));
        xhr.dispatchEvent(new ProgressEvent("load"));
        xhr.dispatchEvent(new ProgressEvent("loadend"));
      } catch {
        /* handlers own their own failures */
      }
    });

    mark("prefetch:hit");

    // The response was served from cache, so the server never saw this request
    // and never ran its side effects — notably marking the topic read. Replay
    // it in the background with the URL Discourse actually asked for.
    void fetch(xhr.__dfpUrl ?? "", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      keepalive: true,
    }).catch(() => {});

    return true;
  } catch {
    realSend();
    return true;
  }
}

/**
 * What Discourse just loaded, kept for the next time it is asked for.
 *
 * Runs from the done-state `readystatechange`, not from `load`, and the
 * difference is the whole point. jQuery's transport assigns `xhr.onload`
 * before it calls `send()`, so a `load` listener added from `send()` sits
 * behind jQuery's — and a native dispatch drains microtasks between listeners,
 * so jQuery's deferred, Ember's transition and the first decorator callbacks
 * could all run before this did. The route's handlers were rescued only by
 * accident, `page:changed` being fired from a later task; a decorator asking
 * `getCurrentTopic()` in that gap — stale-answer's byline fallback — fetched
 * the very body it was about to be primed with. The XHR spec fires
 * `readystatechange` for the done state, and finishes firing it, before it
 * fires `load`; and jQuery 3 listens to `onload` alone wherever `onabort`
 * exists. So a done-state listener here precedes jQuery's deferred and
 * everything hanging off it, whatever order the listeners were added in.
 *
 * The warm-cache write goes to disk, not the transport's memory. An entry in
 * memory would answer a refresh Discourse issues *while on the topic* — the
 * same path, requested to get newer state — with the body it already had. The
 * disk layer is only ever consulted from a hover, which is the case this is
 * for: the way back.
 */
function keep(xhr: PatchedXhr, key: string): void {
  let body: string;
  let contentType: string;
  try {
    if (xhr.status !== 200) return;
    // `responseText` throws for a non-text responseType. jQuery never sets
    // one, but this patch sees every XHR on the page, not only jQuery's.
    body = xhr.responseText;
    contentType = xhr.getResponseHeader("content-type") ?? "";
  } catch {
    return;
  }
  // A 200 that is not JSON is a login page or an error body, not a topic.
  if (!body || !/json/i.test(contentType)) return;
  share(key, body);
  void writeTopic({ path: key, body, contentType, status: 200, at: Date.now() });
  mark(`prefetch:kept:${key}`);
}

/**
 * Exported for prefetch.test.ts, which drives it against a stand-in
 * XMLHttpRequest: the ordering keep() relies on is invisible from any single
 * file, and nothing else in the suite would notice it slipping back to `load`.
 */
export function installTransport(): () => void {
  const OPEN = XMLHttpRequest.prototype.open;
  const SEND = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    this: PatchedXhr,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__dfpMethod = String(method).toUpperCase();
    this.__dfpUrl = String(url);
    // eslint-disable-next-line prefer-rest-params
    return OPEN.apply(this, arguments as never);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function (this: PatchedXhr, body?: unknown) {
    const realSend = () => SEND.call(this, body as XMLHttpRequestBodyInit | null);
    if (this.__dfpMethod !== "GET" || !this.__dfpUrl) return realSend();

    const key = keyFor(this.__dfpUrl);
    if (!key) return realSend();

    const cached = takeFresh(key);
    if (cached) {
      share(key, cached.body);
      fulfil(this, cached, realSend);
      return undefined;
    }

    // A miss still carries the body everyone downstream wants. Not `once`:
    // readystatechange also fires for states 2 and 3, and the done state is
    // the only one with a body — see keep() for why it is this event at all.
    const onState = () => {
      if (this.readyState !== 4) return;
      this.removeEventListener("readystatechange", onState);
      keep(this, key);
    };
    this.addEventListener("readystatechange", onState);
    return realSend();
  } as typeof XMLHttpRequest.prototype.send;

  return () => {
    XMLHttpRequest.prototype.open = OPEN;
    XMLHttpRequest.prototype.send = SEND;
  };
}

/**
 * Hover intent, delegated so it survives Ember re-rendering the list.
 *
 * ── Touch ─────────────────────────────────────────────────────────────────
 * A finger has no dwell. On touch the pointer fires over → down → up → out
 * inside one tap, well under the 120ms the mouse path waits, so the timer was
 * cleared before it fired and `pointerout` then aborted anything that had
 * started: the feature was dead on exactly the device that pays the 465ms
 * median TTFB with nothing else to do. Worse, the warm cache is promoted only
 * from this file's pointer paths, so a topic already on disk from an earlier
 * visit was never served to a tap either — the disk layer's whole way-back
 * case.
 *
 * So a non-mouse `pointerdown` runs the disk step, `warmFromDisk`, at once —
 * and only the disk step. The ~100–150ms between finger-down and the click
 * that sends Discourse's own XHR is the head start, and the disk read fits
 * inside it; the network wait does not. A fetch started at the down cannot
 * land before the click on a cold cache (465ms median against 150), and
 * `send` does not wait on a request in flight, so Discourse's XHR went out
 * regardless and both bodies landed: every cold tap was a doubled
 * `/t/{id}.json` and one unit of the 40/min budget, for nothing the real
 * load's `keep` did not already write to disk for the next visit. And on
 * touch `pointerdown` opens every scroll gesture, so it spent that budget on
 * scrolling too. The disk step spends nothing: a scroll that starts on a
 * title costs one IndexedDB read.
 *
 * A pen is a finger at the down and a mouse in the air. It hovers, so
 * `pointerover` arms the dwell for it and `pointerout` aborts for it exactly
 * as for a mouse; the first version skipped that abort for every non-mouse
 * pointer, and a pen scanning a list fired prefetches nothing ever cancelled.
 * The one pointer whose `pointerout` does not abort is touch — a lifted
 * finger always "leaves", and on a touch laptop that out would otherwise
 * cancel a request the mouse's hover had started. `pointercancel` — the
 * browser taking the gesture for a scroll — disarms and aborts, for the
 * hover-started fetch a pen or a mouse drags into a scroll; on touch there is
 * nothing in flight for it to find.
 *
 * Exported for prefetch.test.ts, which drives it against a stand-in document
 * and a stand-in disk: the four listeners and what each fetches, promotes or
 * aborts is not visible from any single call site.
 */
export function installHoverIntent(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armedFor: string | null = null;

  const topicPathFrom = (el: Element): string | null => {
    const link = el.closest<HTMLAnchorElement>("a.title, a.raw-topic-link, .featured-topic a.title");
    if (!link?.href) return null;
    try {
      const u = new URL(link.href, location.origin);
      if (u.origin !== location.origin) return null;
      return prefetchPathFor(u.pathname);
    } catch {
      return null;
    }
  };

  const disarm = () => {
    clearTimeout(timer);
    armedFor = null;
  };

  const abortPending = () => {
    // Only abort work that has not produced anything yet.
    for (const [key, controller] of inFlight) {
      if (!cache.has(key)) controller.abort();
    }
    inFlight.clear();
  };

  document.addEventListener(
    "pointerover",
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const path = topicPathFrom(target);
      if (!path || path === armedFor) return;

      clearTimeout(timer);
      armedFor = path;
      timer = setTimeout(() => void prefetchTopic(path), HOVER_DWELL_MS);
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse") return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const path = topicPathFrom(target);
      if (!path) return;

      // The dwell timer this tap's own `pointerover` just armed would fire a
      // fetch that a held finger — a long press — never clicks through to.
      clearTimeout(timer);
      armedFor = path;
      void warmFromDisk(path);
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "pointercancel",
    () => {
      disarm();
      abortPending();
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "pointerout",
    (e) => {
      disarm();
      if (e.pointerType === "touch") return;
      abortPending();
    },
    { passive: true, capture: true },
  );
}

export function prefetch(): DfpModule {
  return {
    id: "prefetch",
    budgetMs: 60,

    isAvailable() {
      const open = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "open");
      const send = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "send");
      return Boolean(open?.writable && send?.writable);
    },

    install() {
      installTransport();
      installHoverIntent();
    },
  };
}

/** Exposed for the perf overlay. */
export function prefetchStats() {
  return { cached: cache.size, inFlight: inFlight.size, recentCount, disabledUntil };
}
