import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { getCurrentTopic, topicIdFromPath } from "../topic-data";
import { onDomChange } from "../dom-watch";
import { mountTopicToggle, unmountTopicToggle } from "../topic-toggles";

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

/**
 * Twin of the `@media (min-width: 1280px)` block in reading.css — every panel
 * rule lives inside it, so below this width the root attribute changes nothing
 * on screen. The two numbers have to move together; the reason 1280 is the
 * number is measured and written up beside that block.
 *
 * Without this the 925-1279px band — any un-maximised window on a 1366 or 1440
 * laptop — had a live button that turned accent-"on" when clicked (the pressed
 * colours sit outside the media block), wrote `enabled` to localStorage, and
 * pinned nothing. `sync` refuses the attribute here and `syncButton` disables
 * the control with the reason, the same shape as the unloaded-post case.
 *
 * Created in `install`, not at import. At module scope this was the only DOM
 * call anywhere in the MAIN world's import graph, and it made the file
 * un-importable from Node — `matchMedia is not defined` at import — which the
 * stale-answer.test.ts pattern of importing a module directly would hit, and
 * which linkedom's window in WXT's build-time environment does not define
 * either. The build only survived it because WXT strips the `opPin` import
 * before evaluating options on the Node side: an accident, not a guarantee.
 * Nothing reads the query before `install` runs, so `isWide` answering true
 * until then is never observed.
 */
let WIDE: MediaQueryList | null = null;

function isWide(): boolean {
  return WIDE?.matches ?? true;
}

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
  const on = enabled && onTopic && worthPinning && isWide() && opIsLive();
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
 *
 * A narrow window is the same shape with a different reason, and it is named
 * first: scrolling to the top does nothing for a reader whose window cannot fit
 * the panel, so that is the condition to fix before the other one matters.
 * `enabled` is kept as it was — widening the window brings the pin back on its
 * own through the `change` listener in `install`. The one place the control
 * does vanish is a narrow window with no rail to dim in; `mountToggle` says
 * why.
 */
function syncButton(): void {
  const btn = document.querySelector<HTMLButtonElement>(".dfp-op-toggle");
  if (!btn) return;
  const live = opIsLive();
  const wide = isWide();
  const on = document.documentElement.hasAttribute(ROOT_FLAG);

  btn.disabled = !live || !wide;
  btn.setAttribute("aria-pressed", String(on));
  btn.title = !wide
    ? "Needs a window at least 1280px wide to pin"
    : !live
      ? "The opening post is not loaded this far down the topic — scroll to the top to pin it"
      : enabled
        ? "Unpin the opening post"
        : "Keep the opening post beside the replies";
}

/**
 * Where the toggle goes is topic-toggles.ts's decision, shared with thread-view
 * and quiet-replies: the timeline rail while there is one, a DFP cluster
 * beside the progress pill when the rail has collapsed, the footer last — and
 * the footer is last because verified live at reply #122 of 9,163 it does not
 * exist until the end of the stream. The chain is written up there once.
 *
 * This control alone skips the cluster while the window is narrow. The pinned
 * panel is entirely inside reading.css's `min-width: 1280px` block and the
 * rail goes at 924px, so in the cluster's main case — any window under 925px
 * — the button could only ever be the dimmed "needs a window at least 1280px
 * wide" one, and in a tray built for the corner of a phone a permanently
 * disabled control costs the two live ones their room. In the rail, at
 * 925-1279px, it stays and dims with that reason exactly as before: a desktop
 * reader can widen the window, and a control that says why it is off beats
 * one that vanished. The cluster gets it only when the window IS wide — the
 * composer preview open in a short window drops the rail on desktop too
 * (topic-toggles.ts) — and there it works. `unmountTopicToggle` on the way
 * out, because the window narrows under an existing button and the gate has
 * to take it down, not merely decline to build it; on a pass that finds no
 * button that is one query and no write.
 *
 * Gated on the topic being worth pinning, but NOT on post 1 being loaded —
 * that is a property of where you are scrolled, and a control that comes and
 * goes as you scroll is worse than one that dims. `syncButton` disables it
 * and explains.
 */
function mountToggle(): void {
  if (!worthPinning) return;
  if (!isWide() && !document.querySelector(".timeline-footer-controls")) {
    unmountTopicToggle("dfp-op-toggle");
    return;
  }
  mountTopicToggle("dfp-op-toggle", "Pin post", () => setEnabled(!enabled));
  syncButton();
}

export function opPin(api: PluginApi): DfpModule {
  return {
    id: "op-pin",
    budgetMs: 80,

    install() {
      const wide = matchMedia("(min-width: 1280px)");
      WIDE = wide;

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
       * `childList` only. `sync` writes an attribute on <html>, which this
       * observer does not watch; `mountToggle` CAN write children — it builds
       * the cluster, moves the button between homes, takes it down — and is
       * safe from triggering itself only because topic-toggles.ts is
       * idempotent on the steady state: a pass that finds the button under
       * the best anchor, or no button where the gate says none, writes
       * nothing. tests/unit/topic-toggles.test.ts counts the writes to keep
       * that true. */
      onDomChange(() => {
        mountToggle();
        sync();
      });

      /* Crossing 1280px in either direction is not a DOM change, so the
       * observer above never sees it; the media query itself says when the
       * panel can and cannot exist — and, with no rail to dim in, whether the
       * button exists at all. */
      wide.addEventListener("change", () => {
        mountToggle();
        sync();
      });

      void refreshGate();
      mountToggle();
    },
  };
}
