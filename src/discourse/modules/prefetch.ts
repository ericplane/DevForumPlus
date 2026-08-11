import type { DfpModule } from "../../core/registry";
import { mark } from "../../core/perf";
import { readTopic, writeTopic } from "./warm-cache";

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
 */

const PREFETCH_TTL_MS = 30_000;
const HOVER_DWELL_MS = 120;
const MAX_IN_FLIGHT = 4;
const MAX_PER_MINUTE = 40;
const BACKOFF_MS = 5 * 60_000;

interface CachedResponse {
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

/** Topic payloads only — never message-bus, never anything that mutates. */
function isPrefetchable(pathname: string): boolean {
  return /^\/t\/\d+\.json$/.test(pathname);
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

async function prefetchTopic(topicPath: string): Promise<void> {
  if (cache.has(topicPath) || inFlight.has(topicPath)) return;

  // A previous session may already have this. Promoting it costs no network.
  const persisted = await readTopic(topicPath);
  if (persisted) {
    cache.set(topicPath, {
      status: persisted.status,
      statusText: "OK",
      body: persisted.body,
      contentType: persisted.contentType,
      at: persisted.at,
    });
    mark(`prefetch:warm-hit:${topicPath}`);
    return;
  }

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
    cache.set(topicPath, {
      status: res.status,
      statusText: res.statusText,
      body,
      contentType,
      at: Date.now(),
    });
    // Survive a reload. Topics are safe to persist because message-bus keeps
    // a rendered topic live — see warm-cache.ts for why lists are not.
    void writeTopic({ path: topicPath, body, contentType, status: res.status, at: Date.now() });
    mark(`prefetch:stored:${topicPath}`);
  } catch {
    // Aborted or offline. Neither is worth reporting.
  } finally {
    inFlight.delete(topicPath);
  }
}

/** Single-use: a served entry is dropped so a later visit gets fresh data. */
function takeFresh(key: string): CachedResponse | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  if (Date.now() - hit.at > PREFETCH_TTL_MS) return null;
  return hit;
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

function installTransport(): () => void {
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
    if (!cached) return realSend();

    fulfil(this, cached, realSend);
    return undefined;
  } as typeof XMLHttpRequest.prototype.send;

  return () => {
    XMLHttpRequest.prototype.open = OPEN;
    XMLHttpRequest.prototype.send = SEND;
  };
}

/** Hover intent, delegated so it survives Ember re-rendering the list. */
function installHoverIntent(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armedFor: string | null = null;

  const topicPathFrom = (el: Element): string | null => {
    const link = el.closest<HTMLAnchorElement>("a.title, a.raw-topic-link, .featured-topic a.title");
    if (!link?.href) return null;
    try {
      const u = new URL(link.href, location.origin);
      if (u.origin !== location.origin) return null;
      const m = /^\/t\/[^/]+\/(\d+)/.exec(u.pathname);
      return m ? `/t/${m[1]}.json` : null;
    } catch {
      return null;
    }
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
    "pointerout",
    () => {
      clearTimeout(timer);
      armedFor = null;
      // Only abort work that has not produced anything yet.
      for (const [key, controller] of inFlight) {
        if (!cache.has(key)) controller.abort();
      }
      inFlight.clear();
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
