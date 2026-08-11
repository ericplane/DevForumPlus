import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { getCurrentTopic, topicIdFromPath, type TopicPayload } from "../topic-data";
import { onDomChange } from "../dom-watch";

/**
 * Thread view (PLAN.md §7.3 #13).
 *
 * "Discourse's flat stream with '1 Reply' links makes long technical debates
 * unfollowable. Build the reply graph from `reply_to_post_number`; render an
 * indented, collapsible tree. Toggle back to flat anytime."
 *
 * ── Why this indents rather than re-orders ──────────────────────────────────
 * A literal tree means moving each reply to sit under its parent. The post
 * stream is Ember-owned and virtualised: it re-renders on scroll, on reply, on
 * like, and it lazy-loads posts that are not in the DOM yet. Reordering it
 * means fighting that on every one of those events, and losing whenever the
 * user scrolls far enough for Discourse to recycle a node.
 *
 * The alternative — rendering our own tree and hiding `.post-stream` — means
 * re-inserting untrusted post HTML and forfeiting every control Discourse binds
 * to a post: reply, like, flag, edit, permalinks, lazy images, and DFP's own
 * code intelligence.
 *
 * So this keeps the stream exactly as Discourse renders it and adds the one
 * thing it is missing: **depth**. Each post gets `--dfp-depth` and a rail, so a
 * reply-to-a-reply is visibly subordinate and you can see the shape of a debate
 * while scrolling it. Chronological order is retained, which is also what makes
 * "1 Reply" links, permalinks, and find-in-page keep working.
 *
 * What is deliberately NOT attempted: moving posts, collapsing subtrees (a
 * subtree is not contiguous in chronological order, so "collapse" would hide
 * scattered posts), and any claim to be a real tree. The toggle turns the rails
 * off, and the DOM is untouched either way.
 * ───────────────────────────────────────────────────────────────────────────
 */

const ROOT_FLAG = "data-dfp-threaded";
const DEPTH_VAR = "--dfp-depth";
const MAX_DEPTH = 6;

/**
 * Depth from a reply graph, given whatever slice of it we have.
 *
 * `reply_to_post_number` is null for a top-level post. Depth is hops to a root,
 * capped so a 40-deep argument does not indent off the screen. A parent we have
 * not seen is treated as a root — the alternative is indenting by a number we
 * cannot know, which would visibly jump once the rest of the stream loads.
 */
export function depthsFrom(parent: ReadonlyMap<number, number | null>): Map<number, number> {
  const depth = new Map<number, number>();
  const resolve = (n: number, seen = 0): number => {
    const cached = depth.get(n);
    if (cached !== undefined) return cached;
    const up = parent.get(n);
    if (up === null || up === undefined || seen > 24) {
      depth.set(n, 0);
      return 0;
    }
    const d = Math.min(resolve(up, seen + 1) + 1, MAX_DEPTH);
    depth.set(n, d);
    return d;
  };
  for (const n of parent.keys()) resolve(n);
  return depth;
}

/** Kept for the unit test and for building the initial map from a payload. */
export function depthMap(topic: TopicPayload): Map<number, number> {
  return depthsFrom(parentsFrom(topic));
}

export function parentsFrom(topic: TopicPayload): Map<number, number | null> {
  const parent = new Map<number, number | null>();
  for (const p of topic.post_stream.posts) {
    parent.set(p.post_number, p.reply_to_post_number ?? null);
  }
  return parent;
}

/**
 * Paint depth, and collect the posts we have no reply data for.
 *
 * ── Why this has to fetch at all ────────────────────────────────────────────
 * The first `/t/{id}.json` carries only a window. Measured on a real 198-post
 * announcement: **20 posts loaded, 178 not**. Building the graph once from that
 * payload meant 90% of the thread rendered at depth 0 — flat, and confidently
 * wrong, on exactly the long threads this feature exists for.
 *
 * Every rendered article carries `data-post-id`, the database id, so the posts
 * on screen can be asked for by name. `/t/{id}/posts.json?post_ids[]=…` returns
 * them with `reply_to_post_number` — 40 kB for 20 posts against 57 kB for the
 * equivalent `?post_number=` window, and it fetches exactly what is visible
 * rather than a window that may not line up with it.
 * ───────────────────────────────────────────────────────────────────────────
 */
function paint(depth: Map<number, number>): number[] {
  const unknown: number[] = [];
  for (const article of document.querySelectorAll<HTMLElement>("article[id^='post_']")) {
    const m = /^post_(\d+)$/.exec(article.id);
    if (!m) continue;
    const num = Number(m[1]);
    const host = article.closest<HTMLElement>(".topic-post") ?? article;

    if (!parents.has(num)) {
      const dbId = Number(article.getAttribute("data-post-id"));
      if (Number.isFinite(dbId) && dbId > 0 && !inFlight.has(dbId)) unknown.push(dbId);
      // Leave it unindented rather than guessing; it settles when the fetch
      // lands, which is one frame of flat rather than a wrong indent that
      // later jumps.
      host.style.removeProperty(DEPTH_VAR);
      continue;
    }

    const d = depth.get(num) ?? 0;
    if (d > 0) host.style.setProperty(DEPTH_VAR, String(d));
    else host.style.removeProperty(DEPTH_VAR);
  }
  return unknown;
}

/** Database ids already requested, so scrolling does not refetch the same posts. */
const inFlight = new Set<number>();
let parents: Map<number, number | null> = new Map();
let fetchQueued = false;

/**
 * Fetch reply data for posts that have scrolled into view.
 *
 * Batched and capped: Discourse pages in twenties, so a cap of 60 covers a fast
 * scroll without ever turning into a request for the whole topic.
 */
async function fetchMissing(ids: number[]): Promise<void> {
  const id = topicIdFromPath(location.pathname);
  if (id === null || !ids.length) return;
  const batch = ids.slice(0, 60);
  for (const d of batch) inFlight.add(d);

  const qs = batch.map((d) => `post_ids%5B%5D=${d}`).join("&");
  const res = await fetch(`/t/${id}/posts.json?${qs}`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  }).catch(() => null);
  if (!res?.ok) {
    // Let a failed batch be retried rather than poisoning those ids forever.
    for (const d of batch) inFlight.delete(d);
    return;
  }
  const data = (await res.json().catch(() => null)) as {
    post_stream?: { posts?: { post_number: number; reply_to_post_number: number | null }[] };
  } | null;
  const posts = data?.post_stream?.posts ?? [];
  if (!posts.length) return;
  // A route change while the request was in flight must not paint this topic's
  // graph onto another one.
  if (topicIdFromPath(location.pathname) !== id) return;

  for (const p of posts) parents.set(p.post_number, p.reply_to_post_number ?? null);
  depth = depthsFrom(parents);
  paint(depth);
}

function clearPaint(): void {
  for (const host of document.querySelectorAll<HTMLElement>(".topic-post")) {
    host.style.removeProperty(DEPTH_VAR);
  }
}

/* `depthMap` is retained for the unit test; the runtime path uses depthsFrom. */
void depthMap;

let enabled = false;
let currentTopic: number | null = null;
let depth: Map<number, number> = new Map();

function apply(): void {
  if (!enabled) return;
  const missing = paint(depth);
  if (!missing.length || fetchQueued) return;
  /* Coalesced to one request per frame: a fast scroll fires many mutations and
   * each would otherwise start its own batch for overlapping posts. */
  fetchQueued = true;
  requestAnimationFrame(() => {
    fetchQueued = false;
    void fetchMissing(paint(depth));
  });
}

async function load(): Promise<void> {
  const id = topicIdFromPath(location.pathname);
  if (id === null) {
    currentTopic = null;
    parents = new Map();
    depth = new Map();
    inFlight.clear();
    clearPaint();
    return;
  }
  if (currentTopic === id && parents.size) {
    apply();
    return;
  }

  /* Invalidate BEFORE the await, not after.
   *
   * The observer keeps calling apply() while the new topic's payload is in
   * flight, and post numbers are per-topic — every topic has a #1, #2, #3. So
   * a map left over from the previous topic gets painted onto this one,
   * indenting posts by a completely unrelated thread's shape until the fetch
   * lands, and forever if it fails. */
  currentTopic = id;
  parents = new Map();
  depth = new Map();
  inFlight.clear();
  clearPaint();

  const topic = await getCurrentTopic();
  // A newer navigation already claimed `currentTopic`; this response is stale.
  if (!topic || currentTopic !== id) return;
  parents = parentsFrom(topic);
  depth = depthsFrom(parents);
  apply();
}

function setEnabled(on: boolean): void {
  enabled = on;
  document.documentElement.toggleAttribute(ROOT_FLAG, on);
  try {
    localStorage.setItem("dfp:thread-view", on ? "1" : "0");
  } catch {
    // Private mode or a blocked storage partition — the toggle still works for
    // this page, it just will not be remembered.
  }
  if (on) void load();
  else clearPaint();
  syncButton();
}

function syncButton(): void {
  const btn = document.querySelector<HTMLElement>(".dfp-thread-toggle");
  if (!btn) return;
  btn.setAttribute("aria-pressed", String(enabled));
  btn.title = enabled ? "Show replies flat" : "Show reply depth";
}

/**
 * The toggle lives in the timeline rail, not the topic footer.
 *
 * It used to mount into `.topic-footer-main-buttons`, and that element does not
 * exist until you reach the end of the stream — verified on the live forum at
 * reply #122 of 9,163, where the query returned null. Discourse renders the
 * footer only once the last post is reached, so the control was unreachable on
 * exactly the long, tangled threads this feature exists for; the only way to
 * turn thread view on was to scroll to the bottom of the argument first.
 *
 * `.timeline-footer-controls` is the last child of the timeline rail, which is
 * present the whole way down at desktop widths. The footer stays as the
 * fallback for narrow viewports, where the rail itself collapses.
 */
function mountToggle(): void {
  if (document.querySelector(".dfp-thread-toggle")) return;
  const anchor =
    document.querySelector(".timeline-footer-controls") ??
    document.querySelector(".topic-footer-main-buttons") ??
    document.querySelector("#topic-footer-buttons");
  if (!anchor) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-default dfp-thread-toggle";
  btn.textContent = "Thread view";
  btn.addEventListener("click", () => setEnabled(!enabled));
  /* Appended, so DFP's controls collect below Discourse's own rather than
   * pushing them down the rail. `op-pin` mounts the same way, which keeps the
   * two toggles adjacent instead of one above and one below the native pair. */
  anchor.appendChild(btn);
  syncButton();
}

export function threadView(api: PluginApi): DfpModule {
  return {
    id: "thread-view",
    budgetMs: 100,

    install() {
      try {
        enabled = localStorage.getItem("dfp:thread-view") === "1";
      } catch {
        enabled = false;
      }
      if (enabled) document.documentElement.toggleAttribute(ROOT_FLAG, true);

      api.onPageChange(() => {
        mountToggle();
        void load();
      });

      /* Posts arrive as you scroll, and Ember re-renders the stream on reply
       * and like. Rather than re-fetching, repaint from the depth map we
       * already have — it is a style write per post and idempotent.
       *
       * Coalesced to one repaint per frame. Discourse mutates the DOM
       * constantly (timeline, relative dates, lazy images), and repainting
       * every post on every mutation record would burn a frame's budget doing
       * the same work dozens of times. `childList` only, deliberately: `apply`
       * writes inline styles, so observing attributes here would make this
       * observer trigger itself. */
      onDomChange(() => {
        mountToggle();
        apply();
      });

      mountToggle();
      void load();
    },
  };
}
