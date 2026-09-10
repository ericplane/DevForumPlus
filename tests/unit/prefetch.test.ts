import {
  HOVER_DWELL_MS,
  installHoverIntent,
  installTransport,
  isPrefetchable,
  prefetchPathFor,
  prefetchStats,
  promote,
  takeFresh,
} from "../../src/discourse/modules/prefetch";
import {
  MAX_ENTRIES,
  TTL_MS,
  isFresh,
  type CachedTopic,
} from "../../src/discourse/modules/warm-cache";
import {
  clearTopicCache,
  getPost,
  getTopic,
  primeTopic,
  type TopicPayload,
} from "../../src/discourse/topic-data";

/**
 * The prefetch transport's memory, the two rules that decide whether a click
 * is served from it, and the hand-off of what it sees to topic-data.
 *
 * The first bug this holds the line on was invisible from any single file: the
 * disk layer served entries up to 90s old, the transport refused anything over
 * 30s, and a promoted entry carried its original timestamp across that gap. So
 * a topic re-opened 30–90s after its first hover was promoted on the hover and
 * discarded at the click, and the request went to the server anyway — the
 * cache suppressing the prefetch that would have worked. Both rules are now
 * one `isFresh`, and this checks they agree at 10s, 45s and 100s.
 *
 * The second was an ordering claim that did not hold: the transport primed
 * topic-data from a `load` listener added in `send()`, which is after jQuery
 * assigns `onload`, so jQuery's deferred and everything downstream could run —
 * and fetch the topic again — before the prime landed. It primes from the
 * done-state `readystatechange` now, which the spec finishes firing before
 * `load` starts. The stand-in XMLHttpRequest below fires the two in the spec's
 * order, and a `load` listener added BEFORE `send()`, where jQuery's sits, has
 * to find the topic already there.
 *
 * The third is the pointer story. Hover intent waited 120ms of dwell and
 * aborted on `pointerout`, and a touch pointer fires over → down → up → out
 * inside one tap — so on a phone the timer never fired, the abort cancelled
 * whatever had started, and the disk was never consulted for a tap at all.
 * The last block drives `installHoverIntent` against a stand-in document and
 * a stand-in disk, with a fetch that stays pending until told — which is what
 * makes an abort observable on its signal: a touch-down must promote what
 * disk holds and ask the network for nothing (a fetch started at the down
 * cannot beat the click, so it was only ever a doubled request), a pen must
 * be a mouse in the air and a finger at the down, `pointercancel` must abort
 * what a hover started, and the mouse path must be exactly what it was.
 *
 * No DOM, no network: `promote` is the disk→memory step with the disk read
 * taken out, `takeFresh` is exactly what `send` calls, and `fetch` is a
 * counter that answers every topic with its own id. The one IndexedDB is the
 * Map-backed stand-in below. The clock is `Date.now`, replaced for the
 * duration of the TTL checks.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

const realNow = Date.now;
const T0 = 1_700_000_000_000;
let now = T0;
Date.now = () => now;

const entry = (path: string, at: number) => ({
  path,
  body: `{"id":1,"post_stream":{"posts":[]},"at":${at}}`,
  contentType: "application/json; charset=utf-8",
  status: 200,
  at,
});

try {
  // ── promote → takeFresh across the old 30s/90s gap ──────────────────────
  console.log("── promoted entries are served for as long as disk would serve them ──");

  for (const [age, want] of [
    [10_000, true],
    [45_000, true],
    [100_000, false],
  ] as const) {
    now = T0;
    promote(entry("/t/1.json", T0));
    now = T0 + age;
    const served = takeFresh("/t/1.json");
    eq(served !== null, want, `at ${age / 1000}s the click is ${want ? "served" : "a miss"}`);
    eq(isFresh(T0), want, `…and warm-cache's isFresh says the same at ${age / 1000}s`);
    if (served) eq(served.body, entry("/t/1.json", T0).body, "the body served is the promoted one");
  }

  now = T0;
  promote(entry("/t/2.json", T0));
  now = T0 + TTL_MS;
  check(takeFresh("/t/2.json") !== null, "exactly TTL_MS old is still fresh");
  now = T0;
  promote(entry("/t/2.json", T0));
  now = T0 + TTL_MS + 1;
  check(takeFresh("/t/2.json") === null, "one millisecond past TTL_MS is not");
  eq(prefetchStats().cached, 0, "a refused entry is dropped, not left to be refused again");

  console.log("\n── single-use ─────────────────────────────────────────────────────");
  now = T0;
  promote(entry("/t/3.json", T0));
  check(takeFresh("/t/3.json") !== null, "first take serves");
  check(takeFresh("/t/3.json") === null, "second take is a miss — a later visit gets fresh data");

  console.log("\n── the map does not grow without bound ────────────────────────────");
  now = T0;
  promote(entry("/t/4.json", T0));
  now = T0 + TTL_MS + 1;
  promote(entry("/t/5.json", now));
  eq(prefetchStats().cached, 1, "an insert drops what has already expired");
  for (let i = 0; i < MAX_ENTRIES + 5; i++) promote(entry(`/t/${100 + i}.json`, now));
  eq(prefetchStats().cached, MAX_ENTRIES, "…and holds the map to the disk layer's cap");
  check(takeFresh("/t/5.json") === null, "the oldest insert is the one evicted");
  check(takeFresh(`/t/${100 + MAX_ENTRIES + 4}.json`) !== null, "the newest is kept");
  for (let i = 0; i < MAX_ENTRIES + 5; i++) takeFresh(`/t/${100 + i}.json`);

  // ── which JSON a link's click will ask for ──────────────────────────────
  console.log("\n── prefetchPathFor ────────────────────────────────────────────────");
  eq(prefetchPathFor("/t/some-slug/4301387"), "/t/4301387.json", "slug + topic");
  // The deep-link half: this used to answer `/t/4301387.json`, warming a URL
  // the click never asked for.
  eq(prefetchPathFor("/t/some-slug/4301387/3191"), "/t/4301387/3191.json", "slug + topic + post");
  eq(prefetchPathFor("/t/4301387/12"), "/t/4301387/12.json", "slug-less form keeps the topic id");
  eq(prefetchPathFor("/t/4301387"), "/t/4301387.json", "slug-less topic");
  eq(prefetchPathFor("/latest"), null, "a list is not a topic");
  eq(prefetchPathFor("/c/help-and-feedback/55"), null, "a category is not a topic");

  console.log("\n── isPrefetchable ─────────────────────────────────────────────────");
  check(isPrefetchable("/t/4301387.json"), "head of thread");
  check(isPrefetchable("/t/4301387/3191.json"), "window around a post");
  check(!isPrefetchable("/t/4301387/posts.json"), "the post-ids window loader is not a topic body");
  check(!isPrefetchable("/message-bus/abc/poll"), "message-bus");
  check(!isPrefetchable("/t/4301387"), "the page, not its JSON");
  check(!isPrefetchable("/latest.json"), "a list");
} finally {
  Date.now = realNow;
}

// ── A disk ──────────────────────────────────────────────────────────────────
// Only what warm-cache.ts calls of IndexedDB, over a Map, each request firing
// its `onsuccess` on a microtask the way a real one fires after the caller has
// assigned it. Installed here, before anything below writes, because
// warm-cache memoises its first `open`: a stand-in arriving after the
// transport block's first `keep()` would never be consulted. It is what makes
// the touch path at the end of the file observable — a touch-down promotes
// what is on disk and asks the network for nothing, and "nothing" is only a
// result when the disk had something to give.
type Req<T> = { result: T; onsuccess: (() => void) | null; onerror: (() => void) | null };
const disk = new Map<string, CachedTopic>();
const request = <T,>(result: T): Req<T> => {
  const req: Req<T> = { result, onsuccess: null, onerror: null };
  queueMicrotask(() => req.onsuccess?.());
  return req;
};
const store = {
  get: (path: string) => request(disk.get(path)),
  put: (row: CachedTopic) => {
    disk.set(row.path, row);
    return request(undefined);
  },
  count: () => request(disk.size),
  clear: () => {
    disk.clear();
    return request(undefined);
  },
  index: () => ({ openCursor: () => request(null) }),
};
const db = {
  objectStoreNames: { contains: () => true },
  createObjectStore: () => ({ createIndex: () => {} }),
  transaction: () => ({ objectStore: () => store }),
};
(globalThis as { indexedDB?: unknown }).indexedDB = { open: () => request(db) };

// ── The hand-off to topic-data ──────────────────────────────────────────────
// A server that answers every topic — and every post — with its own number,
// and counts the asks. `status` is what the next answer carries.
let fetchCalls = 0;
let status = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetchCalls++;
  const url = String(input);
  const n = Number(/\/t\/(\d+)(?:\/\d+)?\.json/.exec(url)?.[1] ?? /\/(\d+)\.json/.exec(url)?.[1]);
  const body = JSON.stringify({ id: n, post_number: n, post_stream: { posts: [] } });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const topicJson = (id: number) =>
  JSON.stringify({
    id,
    post_stream: { posts: [{ id: id * 10, post_number: 1, reply_to_post_number: null }] },
  });

try {
  console.log("\n── primeTopic holds the text; the first ask parses it ─────────────");
  {
    clearTopicCache();
    fetchCalls = 0;
    const body = topicJson(7);
    const realParse = JSON.parse;
    let parses = 0;
    JSON.parse = ((text: string, reviver?: Parameters<typeof realParse>[1]) => {
      if (text === body) parses++;
      return realParse(text, reviver);
    }) as typeof JSON.parse;
    try {
      primeTopic(7, body);
      eq(parses, 0, "priming parses nothing");
      const first = getTopic(7);
      const again = getTopic(7);
      check(first === again, "a second ask shares the first's promise");
      const topic = await first;
      eq(topic?.id, 7, "the answer is the primed body");
      eq(parses, 1, "…parsed once, by the first ask");
      eq(fetchCalls, 0, "…and nothing went to the server");
    } finally {
      JSON.parse = realParse;
    }
  }

  console.log("\n── a primed body that is not a topic sends the ask to the server ──");
  for (const [label, body] of [
    ["JSON without a post stream", '{"errors":["not a topic"]}'],
    ["not JSON at all", "<!doctype html>"],
  ] as const) {
    clearTopicCache();
    fetchCalls = 0;
    primeTopic(8, body);
    const topic = await getTopic(8);
    eq(fetchCalls, 1, `${label}: the ask went to the server`);
    eq(topic?.id, 8, "…and its answer is what came back");
    await getTopic(8);
    eq(fetchCalls, 1, "…and is what stays cached");
  }

  console.log("\n── the transport primes before anything downstream of `load` ──────");
  {
    /**
     * Only what keep() and the patched open/send read, firing the done state
     * the way the spec does: readystatechange, then load, then loadend. Node
     * has no XMLHttpRequest and no `location`; both are installed for the
     * block and removed after.
     */
    class StandInXhr extends EventTarget {
      readyState = 0;
      status = 0;
      responseText = "";
      open(_method: string, _url: string): void {
        this.readyState = 1;
      }
      send(_body?: unknown): void {}
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null;
      }
      finish(code: number, body: string): void {
        this.status = code;
        this.responseText = body;
        this.readyState = 4;
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new Event("load"));
        this.dispatchEvent(new Event("loadend"));
      }
    }
    const ORIGINAL_OPEN = StandInXhr.prototype.open;
    const ORIGINAL_SEND = StandInXhr.prototype.send;
    const g = globalThis as { XMLHttpRequest?: unknown; location?: unknown };
    g.XMLHttpRequest = StandInXhr;
    g.location = { origin: "https://devforum.roblox.com" };
    const restore = installTransport();
    try {
      clearTopicCache();
      fetchCalls = 0;
      const xhr = new StandInXhr();
      xhr.open("GET", "/t/77.json?track_visit=true");
      // jQuery assigns onload before it calls send(), so this listener is
      // where its deferred — and every handler downstream of it — would ask.
      let atLoad: Promise<TopicPayload | null> | null = null;
      xhr.addEventListener("load", () => {
        atLoad = getTopic(77);
      });
      xhr.send();
      xhr.finish(200, topicJson(77));
      check(atLoad !== null, "the load listener ran");
      const topic = await atLoad!;
      eq(topic?.id, 77, "an ask made at load time gets the body the XHR carried");
      eq(fetchCalls, 0, "…and no second request was made for it");

      const deepLink = new StandInXhr();
      deepLink.open("GET", "/t/77/85.json");
      deepLink.send();
      deepLink.finish(200, JSON.stringify({ id: 77, post_stream: { posts: [] }, window: 85 }));
      const primedWindow = (await getTopic(77)) as (TopicPayload & { window?: number }) | null;
      eq(primedWindow?.window, 85, "the numbered form primes too, and the newest body wins");
      eq(fetchCalls, 0, "…still without a request of our own");

      const denied = new StandInXhr();
      denied.open("GET", "/t/78.json");
      denied.send();
      denied.finish(403, '{"errors":["You are not permitted to view the requested resource."]}');
      await getTopic(78);
      eq(fetchCalls, 1, "a 403 primes nothing, so the ask goes to the server");

      // The served path: share() runs inside send() itself, and the request
      // Discourse asked for is replayed so the server still marks the topic read.
      fetchCalls = 0;
      promote(entry("/t/79.json", Date.now()));
      const served = new StandInXhr();
      served.open("GET", "/t/79.json?track_visit=true");
      served.send();
      const fromCache = await getTopic(79);
      eq(fromCache?.id, 1, "a served body is primed before send() returns");
      eq(fetchCalls, 1, "…and the one request made is the replay");
    } finally {
      restore();
      delete g.XMLHttpRequest;
      delete g.location;
    }
    check(
      StandInXhr.prototype.open === ORIGINAL_OPEN && StandInXhr.prototype.send === ORIGINAL_SEND,
      "uninstalling puts the prototype back",
    );
  }

  console.log("\n── getPost tells a missing post from a server that did not answer ─");
  {
    fetchCalls = 0;
    status = 200;
    const post = await getPost(77, 3191);
    eq(post?.post_number, 3191, "a 200 answers the post");
    status = 404;
    eq(await getPost(77, 3191), null, "a 404 is the server's answer: null, and the caller keeps it");
    for (const code of [429, 500, 503]) {
      status = code;
      let rejected = false;
      await getPost(77, 3191).catch(() => {
        rejected = true;
      });
      check(rejected, `a ${code} is no answer: rejects, so the caller keeps nothing`);
    }
    status = 200;
  }
} finally {
  globalThis.fetch = realFetch;
  clearTopicCache();
}

// ── Pointer intent: touch, pen, pointercancel, and the unchanged mouse path ─
{
  console.log("\n── a touch-down promotes the disk entry and asks the network for nothing ──");

  /**
   * A document that only records listeners, an `Element` the handlers can
   * `instanceof`, and a fetch that stays pending until told — so an abort is
   * observable on the signal it was given rather than inferred from a count.
   * The disk is the stand-in from the top of the file. Node has neither
   * `document` nor `Element`; both are installed for the block and removed
   * after.
   */
  type PointerHandler = (e: { target: unknown; pointerType: string }) => void;
  const handlers = new Map<string, PointerHandler>();
  class StandInElement {
    constructor(private readonly href: string | null) {}
    closest(): { href: string } | null {
      return this.href ? { href: this.href } : null;
    }
  }
  const g = globalThis as { document?: unknown; location?: unknown; Element?: unknown };
  g.document = { addEventListener: (type: string, fn: PointerHandler) => handlers.set(type, fn) };
  g.location = { origin: "https://devforum.roblox.com" };
  g.Element = StandInElement;

  const signals: AbortSignal[] = [];
  const settle: (() => void)[] = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls++;
    const signal = init?.signal ?? null;
    if (signal) signals.push(signal);
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      settle.push(() =>
        resolve(
          new Response('{"id":1,"post_stream":{"posts":[]}}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });
  }) as typeof fetch;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // The disk step is an await on the stand-in disk, whose requests answer on
  // a microtask; a short macrotask wait is enough for that chain to run.
  const tick = () => sleep(15);
  const fire = (type: string, pointerType: string, href: string | null) =>
    handlers.get(type)?.({ target: new StandInElement(href), pointerType });
  const topic = (n: number) => `https://devforum.roblox.com/t/some-slug/${n}`;
  const onDisk = (n: number) => disk.set(`/t/${n}.json`, entry(`/t/${n}.json`, Date.now()));
  const latest = () => signals[signals.length - 1];
  /** Lands every fetch still pending; settling an aborted one is a no-op. */
  const land = () => {
    for (const done of settle.splice(0)) done();
  };

  try {
    installHoverIntent();
    check(
      ["pointerover", "pointerdown", "pointercancel", "pointerout"].every((t) => handlers.has(t)),
      "listens for over, down, cancel and out",
    );

    // A tap on a cold cache: over → down → out, inside the dwell.
    fetchCalls = 0;
    fire("pointerover", "touch", topic(501));
    fire("pointerdown", "touch", topic(501));
    await tick();
    eq(fetchCalls, 0, "a touch-down on a cold cache fetches nothing: no request could beat the click");
    fire("pointerout", "touch", topic(501));
    await sleep(HOVER_DWELL_MS + 40);
    eq(fetchCalls, 0, "…and the dwell the tap's own pointerover armed never fires");
    eq(prefetchStats().inFlight, 0, "…so nothing is in flight and nothing was spent");

    // The same tap on a topic an earlier visit left on disk.
    onDisk(502);
    fire("pointerover", "touch", topic(502));
    fire("pointerdown", "touch", topic(502));
    await tick();
    check(takeFresh("/t/502.json") !== null, "a touch-down promotes what disk holds, in time for the click");
    eq(fetchCalls, 0, "…with no request");
    fire("pointerout", "touch", topic(502));

    // A scroll that starts on a title: down → cancel.
    fire("pointerdown", "touch", topic(503));
    fire("pointercancel", "touch", topic(503));
    await tick();
    eq(fetchCalls, 0, "a scroll that starts on a title spends nothing");
    eq(prefetchStats().inFlight, 0, "…and leaves nothing in flight");

    // A pen hovers, so in the air it is a mouse: the dwell fires, leaving aborts.
    fetchCalls = 0;
    fire("pointerover", "pen", topic(505));
    await sleep(HOVER_DWELL_MS + 40);
    eq(fetchCalls, 1, "a hovering pen arms the dwell like a mouse");
    fire("pointerout", "pen", topic(505));
    eq(latest()?.aborted, true, "…and its leaving aborts what has not landed, like a mouse");
    await tick();
    eq(prefetchStats().inFlight, 0, "…and clears it from flight");

    // …and at the down it is a finger.
    fetchCalls = 0;
    onDisk(506);
    fire("pointerdown", "pen", topic(506));
    await tick();
    eq(fetchCalls, 0, "a pen-down is the disk step, not a fetch");
    check(takeFresh("/t/506.json") !== null, "…and promotes what disk holds");

    // The browser taking a gesture aborts what a hover started.
    fetchCalls = 0;
    fire("pointerover", "pen", topic(507));
    await sleep(HOVER_DWELL_MS + 40);
    eq(fetchCalls, 1, "a pen that hovers and then drags had fired the dwell");
    fire("pointercancel", "pen", topic(507));
    eq(latest()?.aborted, true, "…and pointercancel — the browser took the gesture — aborts it");
    await tick();
    eq(prefetchStats().inFlight, 0, "…leaving nothing in flight");

    // The mouse path, unchanged: dwell arms, leaving aborts, staying lands.
    fetchCalls = 0;
    fire("pointerover", "mouse", topic(508));
    fire("pointerdown", "mouse", topic(508));
    await tick();
    eq(fetchCalls, 0, "a mouse-down is not a prefetch: the dwell decides");
    await sleep(HOVER_DWELL_MS + 40);
    eq(fetchCalls, 1, "…and the dwell fires it");
    fire("pointerout", "mouse", topic(508));
    eq(latest()?.aborted, true, "a mouse leaving aborts what has not landed");
    await tick();
    eq(prefetchStats().inFlight, 0, "…and clears it from flight");

    fetchCalls = 0;
    fire("pointerover", "mouse", topic(509));
    fire("pointerout", "mouse", topic(509));
    await sleep(HOVER_DWELL_MS + 40);
    eq(fetchCalls, 0, "a mouse that leaves inside the dwell fetches nothing");

    fetchCalls = 0;
    fire("pointerover", "mouse", topic(510));
    await sleep(HOVER_DWELL_MS + 40);
    eq(fetchCalls, 1, "a mouse that stays fetches");
    land();
    await tick();
    eq(prefetchStats().inFlight, 0, "…and it lands");
    check(takeFresh("/t/510.json") !== null, "…held for the click: the network step the split left whole");

    fetchCalls = 0;
    fire("pointerdown", "touch", null);
    await tick();
    eq(fetchCalls, 0, "a touch-down off a topic link does nothing");
  } finally {
    globalThis.fetch = realFetch;
    delete g.document;
    delete g.location;
    delete g.Element;
    land();
  }
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
