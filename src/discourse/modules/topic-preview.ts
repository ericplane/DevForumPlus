import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import { categoryColor, loadCategories, type SiteCategory } from "../site-data";
import {
  TOPIC_HREF,
  getPost,
  getTopic,
  topicIdFromPath,
  type PostSummary,
  type TopicPayload,
} from "../topic-data";

/**
 * Hover card for links to other DevForum topics.
 *
 * People link threads constantly — "see this", "duplicate of", "as discussed
 * here" — and the link text is very often none of those things. This answers
 * what the thread is, whether it was solved, and crucially HOW OLD it is,
 * without leaving the one you are reading.
 *
 * ── Why age leads ───────────────────────────────────────────────────────────
 * On this forum a 2019 thread is not merely old, it is frequently wrong: the
 * engine has moved and the advice has not. That is the entire reason
 * stale-answer.ts and the search-signals age badge exist, and it is the single
 * most useful thing to know BEFORE clicking rather than after. So the card
 * leads with a stale mark on the same two-year threshold stale-answer uses,
 * and spends a line on "asked / active" that a view count would otherwise take.
 *
 * ── Why this costs nothing extra ────────────────────────────────────────────
 * `/t/{id}.json` is 51 kB and ~640 ms cold — measured — which is far too much
 * to spend on a tooltip. It is affordable here only because it is a request DFP
 * already makes: `getTopic` is the shared, per-visit-cached path that
 * stale-answer, thread-view, op-pin and quiet-replies all read from, so a
 * hovered topic that is later opened, or was already read on this visit, costs
 * nothing at all. The one thing that payload cannot answer is a post outside
 * its twenty-post window, and for that — only that — the card asks
 * `/posts/by_number/{id}/{n}.json`, a few kB, rather than quote the wrong
 * post. See `postFor`.
 *
 * Same-origin with the forum's own cookies, so the card reflects YOUR
 * permissions: a link into a category you cannot see answers 403, and the card
 * simply does not appear. Nothing leaves the forum — unlike the two Roblox
 * cards, this makes no third-party request at all.
 *
 * ── The card is a contract, not just a decorator ────────────────────────────
 * The attributes below are written by this module's cooked sweep, but they are
 * read from the whole document: any anchor anywhere carrying `data-dfp-topic`
 * gets the card, with `data-dfp-post` naming a post when there is one. That is
 * what lets other modules — the topic-list work, for one — hang the same card
 * off links that are not in a post, without a second copy of the mechanics.
 * The listeners therefore mount at install rather than on the first sweep that
 * finds a link; the cost is one `closest` per pointerover, which is nothing.
 *
 * ── What this deliberately does not do ──────────────────────────────────────
 * A plain `/u/name` link in a post is left exactly as the author wrote it. A
 * pass here once gave it `data-user-card`, the attribute Discourse's own card
 * handler reads on avatar links, so it would open the user card in place. It
 * was withdrawn unverified: Discourse's cooked-link tracker is bound on the
 * post stream, below the document-level card handler, and exempts mentions
 * and hashtags but not that attribute — so the likely result was a routed
 * navigation AND a card on the same click, which is worse than the plain
 * navigation it replaced. Until that is checked on the live forum, this file
 * changes what no author's link does on a click.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** Claimed on the `.cooked` root, so a repeat sweep costs one attribute read. */
const SCANNED = "data-dfp-topic-scan";

/**
 * Carries the topic id, and the post number when the link names one. The
 * post attribute was `data-dfp-topic-post` until the card became a contract
 * (header); `data-dfp-post` is the name every writer uses now.
 */
const TOPIC = "data-dfp-topic";
const TOPIC_POST = "data-dfp-post";

/** Matches docs-card and asset-preview, so the hover affordances feel like one. */
const OPEN_DELAY = 220;

const YEAR_MS = 315_576e5;
/** stale-answer.ts's threshold, deliberately the same number. */
const STALE_MS = 2 * YEAR_MS;

// ── Marking links ───────────────────────────────────────────────────────────

/**
 * Every topic link in a post, except the ones already answered elsewhere.
 *
 * `aside.onebox` is skipped because it is already Discourse's own full preview
 * of the same thread — a second, smaller card on top of it is the redundancy
 * this feature exists to remove.
 *
 * `aside.quote` is NOT skipped, though it was at first and that was the bug
 * behind "reply links have no card". The reasoning had been that a quote
 * already shows the words, but it shows an EXCERPT OF ONE POST, and the link in
 * its header is the jump-to-source backlink — the single most previewable link
 * on the forum. Measured on a real thread: every `/t/…/4301387/3191`-shaped
 * anchor on the page was inside a quote, so the exclusion silently ate the
 * whole feature on exactly the threads it was written for.
 *
 * A link to the topic you are currently reading is still skipped, but only when
 * it names no post: a card reading "this topic, 9,163 replies" answers a
 * question nobody asked. With a post number it is the "see reply #3191" case
 * and is previewed.
 *
 * Nothing is rewritten: the anchor gains attributes and keeps the author's own
 * text and href.
 */
function mark(root: HTMLElement): number {
  const here = topicIdFromPath(location.pathname);
  let found = 0;

  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (a.hasAttribute(TOPIC)) continue;
    if (a.closest("pre, aside.onebox")) continue;
    // Same-origin only. `a.href` is resolved, so a relative `/t/…` works too.
    if (a.origin !== location.origin) continue;

    // The guarded shape from topic-data.ts — prefetch.ts reads links with the
    // same one, so a link this marks is a link that warms.
    const m = TOPIC_HREF.exec(a.pathname);
    if (!m) continue;
    const id = Number(m[1]);
    if (!Number.isFinite(id)) continue;
    /* Only a link to the topic you are ALREADY READING is pointless. A link to
     * a specific post in it is the "see reply #3191" case, which is common on
     * long threads and is exactly where a preview saves a 3,000-post scroll —
     * skipping those was the reason those links appeared to have no card. */
    if (id === here && !m[2]) continue;

    a.setAttribute(TOPIC, String(id));
    if (m[2]) a.setAttribute(TOPIC_POST, m[2]);
    found++;
  }
  return found;
}

// ── Building the card ───────────────────────────────────────────────────────

/**
 * Post HTML → plain text, without ever adopting a node.
 *
 * `DOMParser` builds an inert document with no browsing context, so nothing in
 * it runs, and the only thing crossing back is a string read off `textContent`.
 * That is what makes reading someone else's cooked post safe here when
 * `innerHTML` would not be — no element from that document is ever inserted.
 */
function asText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function ago(iso: string | undefined): { text: string; ms: number } | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const ms = Date.now() - then;
  const days = ms / 864e5;
  if (days < 1) return { text: "today", ms };
  if (days < 30) return { text: `${Math.floor(days)}d ago`, ms };
  if (days < 365) return { text: `${Math.floor(days / 30)}mo ago`, ms };
  const years = ms / YEAR_MS;
  return { text: `${years < 2 ? "1 year" : `${Math.floor(years)} years`} ago`, ms };
}

function badge(text: string, kind: string): HTMLElement {
  const el = document.createElement("span");
  el.className = `dfp-topic-card__badge dfp-topic-card__badge--${kind}`;
  el.textContent = text;
  return el;
}

/**
 * The card, built from elements and text nodes only.
 *
 * Order is the argument: title, then the marks that change whether you click at
 * all, then the numbers, then the words. A view count and a like count are
 * deliberately absent — they are what Discourse's onebox pads with, and neither
 * changes a decision.
 */
function build(
  topic: TopicPayload,
  postNumber: number | null,
  post: PostSummary | null,
  category: SiteCategory | null,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "dfp-topic-card";

  const title = document.createElement("div");
  title.className = "dfp-topic-card__title";
  title.textContent = topic.title ?? "Topic";
  card.appendChild(title);

  const created = ago(topic.created_at);
  const active = ago(topic.last_posted_at);

  const badges = document.createElement("div");
  badges.className = "dfp-topic-card__badges";
  /* The category leads the badge row: on this forum it is what says whether a
   * linked thread is a bug report, a feature request or a support answer, and
   * a title rarely does. Only the dot takes the category's own colour — the
   * text stays on the neutral badge palette, because an arbitrary hex value
   * from the server is outside the build-time contrast checks and a colour
   * that fails them would fail on someone's theme. */
  if (category?.name) {
    const el = badge(category.name, "category");
    const dot = document.createElement("span");
    dot.className = "dfp-topic-card__dot";
    const color = categoryColor(category.color);
    if (color) dot.style.background = color;
    el.prepend(dot);
    badges.appendChild(el);
  }
  if (topic.accepted_answer) {
    const by = topic.accepted_answer.username;
    badges.appendChild(badge(by ? `Solved by ${by}` : "Solved", "solved"));
  }
  /* Keyed off last activity, not the opening date: a 2019 question answered
   * last month is current, and saying "6 years old" about it would be the kind
   * of confidently wrong mark this codebase refuses. */
  if (active && active.ms > STALE_MS) {
    badges.appendChild(badge(`last active ${active.text}`, "stale"));
  }
  if (topic.closed) badges.appendChild(badge("Closed", "closed"));
  if (topic.archived) badges.appendChild(badge("Archived", "closed"));
  if (badges.childElementCount) card.appendChild(badges);

  const bits: string[] = [];
  const replies = (topic.posts_count ?? 1) - 1;
  if (replies >= 0) bits.push(replies === 1 ? "1 reply" : `${replies} replies`);
  if (created) bits.push(`asked ${created.text}`);
  if (active && (!created || active.text !== created.text)) bits.push(`active ${active.text}`);
  if (postNumber !== null) bits.push(`post #${postNumber}`);
  if (bits.length) {
    const meta = document.createElement("div");
    meta.className = "dfp-topic-card__meta";
    meta.textContent = bits.join(" · ");
    card.appendChild(meta);
  }

  /* A link to post #45 wants THAT post, which is the one thing Discourse's own
   * onebox never shows — and the words here are always that post's, or absent.
   * They used to fall back to the opening post whenever the numbered one was
   * outside the loaded window, which on a long thread is nearly always: the
   * card then read "post #3191" over the OP's text, a confident description of
   * the wrong post. `postFor` has since fetched the post itself; when even that
   * failed, the title and badges above stand on their own. */
  const body = post ? asText(post.cooked ?? "") : "";
  if (post && body) {
    const excerpt = document.createElement("div");
    excerpt.className = "dfp-topic-card__excerpt";
    const who = post.username;
    excerpt.textContent = who && post.post_number !== 1 ? `${who}: ${body}` : body;
    card.appendChild(excerpt);
  }

  return card;
}

/**
 * The post the card quotes: from the loaded window when it is there, otherwise
 * from Discourse's single-post route.
 *
 * The window is twenty posts, so a "see reply #3191" link into a long thread —
 * exactly the link a preview saves the most scrolling on — is almost never in
 * it. And because topic-data is primed with whatever window Discourse loaded
 * for the page, on a deep-linked page even post #1 can be missing, so the
 * opening post takes the same route. Verified live:
 * `/posts/by_number/{id}/{n}.json` is a few kB with the same cookies, and
 * answers with `cooked` and `username`. A deleted post yields a card without
 * an excerpt, cached like any other under `id#post`: the title and badges are
 * still right, and re-requesting a deleted post on every hover is the thing
 * the null entries in `cards` exist to prevent. A 5xx or no network is not
 * that — `getPost` rejects for those, and `open` forgets the key so the next
 * hover asks again instead of standing on a blip for the visit.
 */
async function postFor(
  id: number,
  topic: TopicPayload,
  postNumber: number,
): Promise<PostSummary | null> {
  const posts = topic.post_stream?.posts ?? [];
  return posts.find((p) => p.post_number === postNumber) ?? (await getPost(id, postNumber));
}

// ── The hover mechanics ─────────────────────────────────────────────────────

/**
 * key → the card, or `null` once it is known there is nothing to show — as a
 * promise, from the moment the first hover starts building it.
 *
 * Keyed by topic AND post number, because the same topic hovered through two
 * different links renders two different cards. `null` is the important half: a
 * deleted or unreadable topic must not be re-requested on every hover.
 *
 * The promise rather than its result, for the reason `getTopic` keeps one: the
 * key used to be written only once the card existed, so a pointer that left
 * and came back inside `OPEN_DELAY` plus the `/posts/by_number` round trip
 * started a second, identical request. Now the second hover joins the first.
 */
const cards = new Map<string, Promise<HTMLElement | null>>();
const CARD_CAP = 16;

function remember(key: string, card: Promise<HTMLElement | null>): void {
  if (cards.size >= CARD_CAP) {
    const oldest = cards.keys().next();
    if (!oldest.done) cards.delete(oldest.value);
  }
  cards.set(key, card);
}

let host: HTMLElement | null = null;
let openTimer = 0;
let hovered: HTMLElement | null = null;
let pending: string | null = null;
let shownFor: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (host) return host;
  const el = document.createElement("div");
  el.className = "dfp-topic-preview";
  /* Decoration to a screen reader: everything in it is either the link's own
   * text or metadata the link already points at. It is also pointer-events:none
   * in CSS, which removes the class of bugs where a card eats the click. */
  el.setAttribute("aria-hidden", "true");
  host = el;
  return el;
}

/**
 * Below the link, flipped above when there is no room, clamped to the viewport.
 *
 * Duplicated in spirit from asset-preview.ts, deliberately and with a limit: if
 * a third hover card ever lands, this and that one should become one helper.
 * Two near-identical copies are cheaper than the wrong abstraction; three are
 * not.
 */
function place(anchor: HTMLElement): void {
  if (!host) return;
  const a = anchor.getBoundingClientRect();
  const c = host.getBoundingClientRect();

  let left = a.left;
  if (left + c.width > innerWidth - 8) left = innerWidth - c.width - 8;
  if (left < 8) left = 8;

  let top = a.bottom + 6;
  if (top + c.height > innerHeight - 8) {
    const above = a.top - c.height - 6;
    top = above > 8 ? above : Math.max(8, innerHeight - c.height - 8);
  }
  host.style.translate = `${Math.round(left)}px ${Math.round(top)}px`;
}

function show(anchor: HTMLElement, card: HTMLElement): void {
  // Ember can re-render the stream between the hover and the fetch resolving.
  if (!anchor.isConnected || !document.body) return;
  const el = ensureHost();
  if (el.firstChild !== card) el.replaceChildren(card);
  document.body.appendChild(el);
  place(anchor);
  shownFor = anchor;
}

function hide(): void {
  clearTimeout(openTimer);
  pending = null;
  // A spent tap is spent only while its card stands — see `armed`.
  armed = null;
  if (!shownFor) return;
  shownFor = null;
  // Removed rather than hidden, so a card cannot survive a route change as a
  // stale rectangle over unrelated content.
  host?.remove();
}

function open(anchor: HTMLElement): void {
  const raw = anchor.getAttribute(TOPIC);
  const id = Number(raw);
  if (!raw || !Number.isFinite(id)) return;
  const postRaw = anchor.getAttribute(TOPIC_POST);
  const postNumber = postRaw && /^\d+$/.test(postRaw) ? Number(postRaw) : null;

  const key = postNumber === null ? String(id) : `${id}#${postNumber}`;
  pending = key;

  let hit = cards.get(key);
  if (!hit) {
    /* The category table rides alongside the topic request rather than after
     * it — one `/site.json` per visit at most, and never one per hover. The
     * honest cost: on the visit's FIRST hover the card waits for whichever of
     * the two is slower, and `/site.json` (every category, group and
     * post-action type, hundreds of kB here) is usually that one, even when
     * the topic is instant from `primeTopic` — a "see reply #N" link into the
     * thread being read, the commonest case. Paid once; every later hover
     * finds the table cached and costs what the topic alone costs. */
    hit = Promise.all([getTopic(id), loadCategories()]).then(async ([topic, categories]) => {
      // Known bad stays bad; the reference remains an ordinary working link.
      if (!topic) return null;
      const category =
        topic.category_id !== undefined ? (categories?.get(topic.category_id) ?? null) : null;
      return build(topic, postNumber, await postFor(id, topic, postNumber ?? 1), category);
    });
    remember(key, hit);
  }

  const claim = hit;
  void claim.then(
    // Only if the pointer is still on the same link by the time this lands.
    (card) => {
      if (card && pending === key && hovered === anchor) show(anchor, card);
    },
    // No answer from the server — see `getPost`. Forget the attempt, unless a
    // later hover has already replaced it, so the next one asks again.
    () => {
      if (cards.get(key) === claim) cards.delete(key);
    },
  );
}

function target(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>(`[${TOPIC}]`) : null;
}

let mounted = false;

/**
 * Touch, and the two taps — the same shape as asset-preview.ts, for the same
 * reason: on `(hover: none)` nothing rests on a link, so a first tap opens the
 * card without navigating and the second follows the link. `armed` is the
 * link whose first tap was spent; `hide` forgets it, so a card taken away by a
 * scroll or Escape is shown again by the next tap rather than skipped.
 *
 * The first tap is claimed only inside `.cooked`. The attribute is a contract
 * (header) and a topic-list row may carry it; on a phone that row's tap IS
 * the navigation, and a card in front of it would be the wrong trade. Hover,
 * where there is one, opens for the attribute anywhere.
 *
 * The listener is on `document` in the CAPTURE phase, and that is the whole
 * mechanism. Discourse's cooked-link tracker is bound on the post stream,
 * below `document`, and for every link in a post it runs first in the bubble:
 * it calls `preventDefault` and hands an internal href to `routeTo` — the
 * same call protocol.ts describes for `nav:route`. A bubble listener here saw
 * only the aftermath, so the first tap navigated exactly as it does today and
 * no card ever opened. In capture nothing has run yet, so the first tap is
 * taken whole — `preventDefault` so the anchor does not navigate,
 * `stopPropagation` so the tracker never sees it — and the second tap is
 * left untouched to be tracked and routed as it always was. There is no
 * `defaultPrevented` to consult in capture; the `button` and media guards
 * are what keep this off the mouse.
 *
 * On touch no timer is ever armed — see `enter` for the gesture that made
 * that rule — so a tap that navigates leaves nothing to fire mid-route-change
 * and spend a `/t/{id}.json` on a card `show` then refuses because the anchor
 * is gone. The `clearTimeout` calls in the branches that navigate stay for
 * the one device that has a hover AND reports `(hover: none)` for a gesture.
 *
 * The query is created in `mountHover`, not at import — op-pin.ts records why
 * `matchMedia` at module scope breaks importing from Node.
 */
let touch: MediaQueryList | null = null;
let armed: HTMLElement | null = null;

/**
 * Mounted at install. This used to wait for the first sweep that found a
 * topic link, so a reader who never opened a thread with one paid for no
 * listeners — but the attribute is written by other modules now (header), on
 * elements no cooked sweep visits, and a card that opens only once a post
 * happens to contain a topic link is a contract nobody can rely on.
 */
function mountHover(): void {
  if (mounted) return;
  mounted = true;
  touch = matchMedia("(hover: none)");

  /* On touch the click handler is the only opener; the timer is never armed.
   * asset-preview.ts records the gesture that decided it: a long-press or a
   * short drag on a carded link is `pointerover` with no click, so the timer
   * ran out, fetched, and mounted a card nobody asked for that nothing took
   * away — and because that path never set `armed`, the next tap re-opened
   * the card instead of following the link. */
  const enter = (node: EventTarget | null) => {
    const anchor = target(node);
    if (anchor === hovered) return;
    hovered = anchor;
    hide();
    if (anchor && !touch?.matches) openTimer = window.setTimeout(() => open(anchor), OPEN_DELAY);
  };

  document.addEventListener("pointerover", (e) => enter(e.target), { passive: true });
  document.addEventListener("focusin", (e) => enter(e.target));
  document.addEventListener("focusout", () => {
    hovered = null;
    hide();
  });
  /* Not on touch: a touch pointer leaves the document at the end of every
   * tap, which would close the card the same tap had just opened. */
  document.documentElement.addEventListener("pointerleave", () => {
    if (touch?.matches) return;
    hovered = null;
    hide();
  });
  /* The two touch gestures `pointerleave` used to cover — the long-press
   * context menu and a scroll or pinch takeover — are the ones the browser
   * reports as `pointercancel`, and neither is followed by a click. */
  document.addEventListener("pointercancel", () => {
    hovered = null;
    hide();
  });

  document.addEventListener(
    "click",
    (e) => {
      if (!touch?.matches || e.button !== 0) return;
      const anchor = target(e.target);
      if (!anchor) return;
      // Second tap: the card was asked for; this one leaves.
      if (armed === anchor) {
        hovered = null;
        hide();
        return;
      }
      // A marked link outside a post: the tap is the navigation.
      if (!anchor.closest(".cooked")) {
        clearTimeout(openTimer);
        hovered = null;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(openTimer);
      hovered = anchor;
      armed = anchor;
      open(anchor);
    },
    { capture: true },
  );

  // Escape closes the card, as it does every other overlay in the product.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    hovered = null;
    hide();
  });
  /* A card fixed to the viewport would otherwise drift off the link it belongs
   * to. Capture, because the scroll may happen inside a panel rather than the
   * page — the pinned OP column is exactly such a scroller. */
  document.addEventListener(
    "scroll",
    () => {
      if (!shownFor && !pending) return;
      hovered = null;
      hide();
    },
    { capture: true, passive: true },
  );
}

function enhance(root: HTMLElement): void {
  if (root.hasAttribute(SCANNED)) return;
  root.setAttribute(SCANNED, "1");
  mark(root);
}

export function topicPreview(api: PluginApi): DfpModule {
  return {
    id: "topic-preview",
    budgetMs: 60,

    install() {
      // First, so a link another module marks before the first sweep is live.
      mountHover();
      decorateCooked(api, (element) => enhance(element), {
        id: "dfp-topic-preview",
        onlyStream: true,
      });
    },
  };
}
