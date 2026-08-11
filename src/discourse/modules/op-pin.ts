import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { getCurrentTopic, topicIdFromPath } from "../topic-data";
import { onDomChange } from "../dom-watch";

/**
 * Pinned original post.
 *
 * Asked for on the forum as "a splitscreen function… you can always see the
 * main post… but because posts can be quite big, pinned to the side".
 *
 * ── Why this module is an attribute and one number ──────────────────────────
 * The panel itself is CSS — see the block at the end of reading.css. The OP's
 * own `.row` is taken out of flow and fixed to the side, on the node Discourse
 * already rendered, so this never touches the post stream. That is the same
 * standard the accepted-answer hoist holds itself to: nothing is moved, so
 * there is nothing for Ember to undo on re-render and nothing to re-apply on a
 * route change.
 *
 * It also means there is exactly ONE copy of the OP on the page. A cloned or
 * re-fetched copy was considered and rejected: it would ship dead `wrap`,
 * `copy without comments` and `Show all N lines` buttons (code-chrome binds
 * listeners to the nodes it decorated, and `decorateCooked` is a registration
 * rather than a scan), a `pre.dfp-code--clipped` capped at 22rem with no
 * working way to expand it, duplicate `#post_1` and heading ids that capture
 * Discourse's own permalink scrolling, and a find-in-page that matches every
 * phrase twice. The JSON path is worse still — it needs an element allow-list
 * kept in sync with a `-dev` Discourse, with XSS as the failure mode of drift.
 *
 * So the only thing CSS cannot answer is left here: whether Discourse has
 * loaded post 1 at all. Verified on the live forum — a deep link to
 * /t/…/4301387/400 renders posts 395-414 and there is no `#post_1` in the
 * document. When it is absent the feature must be absent too, not empty.
 * ───────────────────────────────────────────────────────────────────────────
 */

const ROOT_FLAG = "data-dfp-op-pin";
const STORAGE_KEY = "dfp:op-pin";

/** Read by reading.css as the pinned panel's left edge. See `syncAnchor`. */
const LEFT_VAR = "--dfp-op-left";

/**
 * ── Never move the box Discourse is measuring ───────────────────────────────
 *
 * Discourse works out which post you are looking at — and when to page more in
 * — from the rendered position of `article#post_1` itself. Anything that holds
 * that box still, or makes it tall, lies to it. Four shapes were built and
 * measured before the one in reading.css was found; the full list with numbers
 * is there. The short version:
 *
 *   - Sticky on the row: counter frozen AND paging dead.
 *   - Removing Discourse's `onscreen-post` class: counter fixed, paging worse.
 *   - Row stretched to the stream so a sticky article has travel: paging works,
 *     counter reads "1" for as long as the row covers the viewport — 12,940px
 *     on a real announcement thread.
 *   - `position: fixed` on the article: pinned and paging, counter still frozen,
 *     because the article is the measured box.
 *
 * What works is pinning the article's CONTENTS and letting the article collapse
 * to 34px in place. Verified together from the first scroll: counter
 * 3 → 4 → 6 → 8 → 71, panel at 90px throughout, posts paging in.
 *
 * Any change here must re-run BOTH the counter check and the scroll-to-bottom
 * check — each failure mode is invisible to the other's test, which is how one
 * was shipped while fixing the other.
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Below this the panel is noise: a pinned question next to three replies you
 * can already see costs a column and answers nothing. Read from `posts_count`
 * on a payload DFP already fetches and shares, so the gate costs no request.
 */
const MIN_POSTS = 8;

let enabled = false;

/** The topic whose `posts_count` `worthPinning` currently describes. */
let countedTopic: number | null = null;
let worthPinning = false;

/**
 * `#post_1` with a body, not merely an `<article>`.
 *
 * Measured on this Discourse build, the stream only grows: at reply #543 of a
 * 9,163-post topic post 1 was still in the DOM with its `.cooked` intact, so
 * the live node is a reliable source. That is a property of the current build
 * rather than a guarantee — if a future one starts cloaking off-screen posts,
 * the article survives as an empty placeholder and a panel keyed on the article
 * alone would go quietly blank. Blank is the worst outcome this feature has, so
 * the check is for the body and the answer is to switch off instead.
 */
function opIsLive(): boolean {
  const op = document.getElementById("post_1");
  return !!op?.querySelector(".cooked");
}

function sync(): void {
  const onTopic = topicIdFromPath(location.pathname) !== null;
  const on = enabled && onTopic && worthPinning && opIsLive();
  document.documentElement.toggleAttribute(ROOT_FLAG, on);

  syncAnchor(on);
  syncButton();
}

/**
 * The one measurement this module takes.
 *
 * The panel is `position: fixed`, which is what lets it stay put without any
 * ancestor being tall — and being fixed, it has no idea where the post stream
 * is horizontally. Everything else about the layout is CSS; this supplies the
 * single number CSS cannot compute, because the stream's left edge depends on
 * the content cap, the timeline rail and the scrollbar all at once.
 *
 * Set on the root rather than the panel so a re-render of the post cannot drop
 * it, and compared before writing: this runs on every coalesced pass, and an
 * unconditional write would dirty style on a page Discourse is already mutating
 * constantly.
 */
function syncAnchor(pinned: boolean): void {
  const root = document.documentElement;
  if (!pinned) {
    root.style.removeProperty(LEFT_VAR);
    return;
  }
  const stream = document.getElementById("post_1")?.closest(".post-stream");
  if (!stream) return;
  const next = `${Math.round(stream.getBoundingClientRect().left)}px`;
  if (root.style.getPropertyValue(LEFT_VAR) !== next) root.style.setProperty(LEFT_VAR, next);
}

/**
 * Refresh the `posts_count` gate for whatever topic is open now.
 *
 * The payload is awaited, so the topic can change underneath it. Claiming the
 * topic id BEFORE the await and re-checking after is the same discipline
 * thread-view.ts arrived at, for the same reason — every topic has a post #1,
 * so a stale answer does not look stale, it looks wrong.
 */
async function refreshGate(): Promise<void> {
  const id = topicIdFromPath(location.pathname);
  if (id === null) {
    countedTopic = null;
    worthPinning = false;
    sync();
    return;
  }
  if (countedTopic === id) return;

  countedTopic = id;
  worthPinning = false;
  sync();

  const topic = await getCurrentTopic();
  if (countedTopic !== id) return;
  worthPinning = (topic?.posts_count ?? 0) >= MIN_POSTS;
  /* `mountToggle`, not just `sync`. `worthPinning` is the gate the button mounts
   * behind and it can only become true HERE, after an await — so leaving the
   * mount to the observer means the control appears whenever Discourse next
   * happens to touch the DOM. That is usually immediate and occasionally never,
   * which is the worst kind of intermittent. `sync` alone cannot cover it:
   * `syncButton` returns early when there is no button yet. */
  mountToggle();
  sync();
}

function setEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Private mode or a partitioned store — the toggle still works for this
    // page, it just will not be remembered.
  }
  sync();
}

/**
 * The control stays put and goes dim; it does not vanish.
 *
 * Deep in a topic Discourse has unloaded post 1, so there is nothing to pin —
 * verified at /t/…/4301387/5794, where the loaded window starts at post 5790.
 * The first build simply declined to mount the button there, which reads as the
 * feature having disappeared, and the version after that left it enabled and
 * inert, which is worse: a control that does nothing when clicked.
 *
 * There is no way to fetch post 1 back on the spot. Discourse's own
 * `postStream.loadPostByPostNumber(1)` is reachable and resolves without error,
 * but it is a no-op at that distance — measured: still 20 posts loaded, no
 * `#post_1`, no gap marker. The stream is a contiguous window around where you
 * are, and the only route back is `prependMore()` about 290 times. So the
 * honest answer is to say why, and say where the feature lives.
 */
function syncButton(): void {
  const btn = document.querySelector<HTMLButtonElement>(".dfp-op-toggle");
  if (!btn) return;
  const live = opIsLive();
  const on = document.documentElement.hasAttribute(ROOT_FLAG);

  btn.disabled = !live;
  btn.setAttribute("aria-pressed", String(on));
  btn.title = !live
    ? "The opening post is not loaded this far down the topic — scroll to the top to pin it"
    : enabled
      ? "Unpin the opening post"
      : "Keep the opening post beside the replies";
}

/**
 * Mount the toggle in the timeline, not the topic footer.
 *
 * `.topic-footer-main-buttons` is where thread-view puts its own toggle, and
 * verified live at reply #122 of 9,163 that element does not exist — Discourse
 * does not render the footer until you reach the end of the stream. So a
 * control mounted there is unreachable on exactly the long topics these
 * features are for. `.timeline-footer-controls` is the last child of the
 * always-present timeline rail; the footer is kept only as the narrow-viewport
 * fallback, where the rail itself collapses.
 */
function mountToggle(): void {
  if (document.querySelector(".dfp-op-toggle")) return;
  const anchor =
    document.querySelector(".timeline-footer-controls") ??
    document.querySelector(".topic-footer-main-buttons") ??
    document.querySelector("#topic-footer-buttons");
  if (!anchor) return;
  /* Gated on the topic being worth pinning, but NOT on post 1 being loaded —
   * that is a property of where you are scrolled, and a control that comes and
   * goes as you scroll is worse than one that dims. `syncButton` disables it
   * and explains. */
  if (!worthPinning) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-default dfp-op-toggle";
  btn.textContent = "Pin post";
  btn.addEventListener("click", () => setEnabled(!enabled));
  anchor.appendChild(btn);
  syncButton();
}

export function opPin(api: PluginApi): DfpModule {
  return {
    id: "op-pin",
    budgetMs: 80,

    install() {
      try {
        enabled = localStorage.getItem(STORAGE_KEY) === "1";
      } catch {
        enabled = false;
      }

      api.onPageChange(() => {
        void refreshGate();
        mountToggle();
      });

      /* Posts arrive as you scroll and Ember re-renders the stream on reply and
       * like, so both "is post 1 here" and "is the timeline here" can change
       * without a route change. Coalesced to one pass per frame: Discourse
       * mutates the DOM constantly and answering the same question dozens of
       * times a frame would burn the budget doing nothing.
       *
       * `childList` only, and safe from self-triggering for a stronger reason
       * than thread-view's: the only write here is an attribute on <html>,
       * which this observer does not watch at all. */
      onDomChange(() => {
        mountToggle();
        sync();
      });

      void refreshGate();
      mountToggle();
    },
  };
}
