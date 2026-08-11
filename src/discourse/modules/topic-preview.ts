import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import { getTopic, topicIdFromPath, type TopicPayload } from "../topic-data";

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
 * nothing at all. A second fetch path for a hover card would not have been
 * worth building.
 *
 * Same-origin with the forum's own cookies, so the card reflects YOUR
 * permissions: a link into a category you cannot see answers 403, and the card
 * simply does not appear. Nothing leaves the forum — unlike the two Roblox
 * cards, this makes no third-party request at all.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** Claimed on the `.cooked` root, so a repeat sweep costs one attribute read. */
const SCANNED = "data-dfp-topic-scan";

/** Carries the topic id, and the post number when the link names one. */
const TOPIC = "data-dfp-topic";
const TOPIC_POST = "data-dfp-topic-post";

/** Matches docs-card and asset-preview, so the hover affordances feel like one. */
const OPEN_DELAY = 220;

/**
 * `/t/slug/12345`, `/t/12345`, either optionally followed by `/67`.
 *
 * The slug arm refuses to match a bare number, which is not fussiness: with a
 * plain `[^/]+/` there, `/t/4301387/3191` parses as topic 3191 — a real topic,
 * and entirely the wrong one. A card that confidently describes a different
 * thread is worse than no card, so the slug has to prove it is a slug.
 */
const TOPIC_HREF = /^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?(\d+)(?:\/(\d+))?(?:[/?#]|$)/;

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
function build(topic: TopicPayload, postNumber: number | null): HTMLElement {
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
   * onebox never shows. `getTopic` carries only the first window, so a deep
   * post number usually is not there — in which case the topic's own opening
   * lines are still the better answer than nothing, and the "post #45" above
   * has already said which post you are heading for. */
  const posts = topic.post_stream?.posts ?? [];
  const chosen = (postNumber !== null && posts.find((p) => p.post_number === postNumber)) || posts[0];
  const body = chosen ? asText(chosen.cooked ?? "") : "";
  if (body) {
    const excerpt = document.createElement("div");
    excerpt.className = "dfp-topic-card__excerpt";
    const who = chosen?.username;
    excerpt.textContent = who && chosen !== posts[0] ? `${who}: ${body}` : body;
    card.appendChild(excerpt);
  }

  return card;
}

// ── The hover mechanics ─────────────────────────────────────────────────────

/**
 * key → built card, or `null` once it is known there is nothing to show.
 *
 * Keyed by topic AND post number, because the same topic hovered through two
 * different links renders two different cards. `null` is the important half: a
 * deleted or unreadable topic must not be re-requested on every hover.
 */
const cards = new Map<string, HTMLElement | null>();
const CARD_CAP = 16;

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

  const hit = cards.get(key);
  if (hit !== undefined) {
    // Known bad stays bad; the reference remains an ordinary working link.
    if (hit) show(anchor, hit);
    return;
  }

  void getTopic(id).then((topic) => {
    if (!topic) {
      cards.set(key, null);
      return;
    }
    const card = build(topic, postNumber);
    if (cards.size >= CARD_CAP) {
      const oldest = cards.keys().next();
      if (!oldest.done) cards.delete(oldest.value);
    }
    cards.set(key, card);
    // Only if the pointer is still on the same link by the time this lands.
    if (pending === key && hovered === anchor) show(anchor, card);
  });
}

function target(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>(`[${TOPIC}]`) : null;
}

let mounted = false;

/**
 * Mounted lazily, the first sweep that actually finds a topic link. A reader who
 * never opens a thread containing one pays for no listeners at all.
 */
function mountHover(): void {
  if (mounted) return;
  mounted = true;

  const enter = (node: EventTarget | null) => {
    const anchor = target(node);
    if (anchor === hovered) return;
    hovered = anchor;
    hide();
    if (anchor) openTimer = window.setTimeout(() => open(anchor), OPEN_DELAY);
  };

  document.addEventListener("pointerover", (e) => enter(e.target), { passive: true });
  document.addEventListener("focusin", (e) => enter(e.target));
  document.addEventListener("focusout", () => {
    hovered = null;
    hide();
  });
  document.documentElement.addEventListener("pointerleave", () => {
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
  if (mark(root) > 0) mountHover();
}

export function topicPreview(api: PluginApi): DfpModule {
  return {
    id: "topic-preview",
    budgetMs: 60,

    install() {
      decorateCooked(api, (element) => enhance(element), {
        id: "dfp-topic-preview",
        onlyStream: true,
      });
    },
  };
}
