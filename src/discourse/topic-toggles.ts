/**
 * One home for the three topic toggles — thread view, pin post and quiet.
 *
 * ── The anchor chain, and why it lives here ─────────────────────────────────
 * thread-view.ts, op-pin.ts and quiet-replies.ts each carried the same three
 * lines: `.timeline-footer-controls`, else `.topic-footer-main-buttons`, else
 * `#topic-footer-buttons`. Three copies of one decision is how the chain grew
 * a blind spot that none of the three owned. The measured facts behind the
 * order it has now:
 *
 *   - The topic footer does not exist until the end of the stream. Verified on
 *     the live forum at reply #122 of 9,163: the query returned null, so a
 *     control mounted there is unreachable on exactly the long topics these
 *     features exist for. It is the last resort, not a fallback.
 *   - `.timeline-footer-controls` is the last child of the timeline rail, and
 *     the rail is present the whole way down — at desktop widths. It is 90px
 *     wide and sized by its widest child, so a label mounted here is
 *     load-bearing on the reply column (interactive.css has the numbers, and
 *     "Quiet (3)" rather than "Quiet replies (3)" is why).
 *   - Discourse renders the rail only when it fits: wider than 924px, not in
 *     mobile view, and — topic-navigation.gjs `#fitsTimeline` — not while the
 *     composer preview is open in a window shorter than `325 + composerHeight
 *     + headerOffset()`, which is every reply with the preview showing on a
 *     1366x768 laptop. Otherwise it renders `#topic-progress-wrapper` instead,
 *     the "82 / 83" pill, and the rail's footer controls exist only inside the
 *     fullscreen timeline that pill opens, then go with it when it closes.
 *     With the old chain the toggles therefore lived inside a transient
 *     overlay and nowhere else: in a half-width window beside Studio, mid
 *     thread, all three headline reading features were simply absent, and
 *     nothing said the pill was where they had gone.
 *
 * So the chain has a middle rung. When the rail is absent and the pill is
 * present, the toggles mount into `.dfp-topic-toggles`, a cluster this module
 * creates on demand as the pill's previous sibling. The pill's wrapper,
 * `.topic-navigation.with-topic-progress`, is what places it (checked against
 * discourse/discourse main: `position: sticky` at the bottom, lifted by
 * `--composer-height`, inset for the safe area, on the timeline layer, its
 * children taking pointer events), so a child of it inherits all of that
 * and re-derives none — touch.css has the facts and the shape. The footer
 * stays last, for a DOM with neither.
 *
 * ── Why an existing button is moved rather than remade ──────────────────────
 * The window changes shape under an open topic. Widen it past the threshold
 * and Discourse swaps the pill for the rail; the cluster sits outside the
 * block Glimmer re-renders for that swap, so it survives with the buttons
 * still in it, in the wrapper beside a rail that is now empty of them. A
 * pass therefore re-homes a button that already exists whenever a better
 * anchor has appeared, and it is the same node that moves: `disabled`,
 * `title` and `aria-pressed` travel with it, so op-pin's "needs a window at
 * least 1280px wide" state is never reset by the move. The cluster is
 * dropped the moment it is empty. Narrowing goes the other way — the rail is
 * destroyed with the buttons in it and the next pass builds them again in a
 * fresh cluster. Module state is what a button renders, so a rebuilt button
 * is indistinguishable from the one it replaces.
 *
 * Idempotent on the steady state, and that is not optional: every caller runs
 * from `onDomChange`, so a pass that wrote a mutation would schedule the next
 * pass, forever. A pass that finds the button under the best anchor touches
 * nothing. The fullscreen timeline is the one place this churns by design —
 * opening it moves the buttons into its footer controls, where they work as
 * they always did, and closing it destroys them, so the pass after rebuilds
 * the cluster.
 *
 * Not measured live in this pass: the wrapper's geometry is read from
 * discourse/discourse main (topic-footer.scss, topic.scss,
 * topic-navigation.gjs), not from a narrow window on the real forum. This
 * build's topic-progress.gjs assigns no `docked` class, so there is no docked
 * state for the cluster to follow.
 */

/** The DFP-owned cluster beside the progress pill. Styled in touch.css. */
export const TOGGLE_CLUSTER = "dfp-topic-toggles";

const RAIL = ".timeline-footer-controls";
const PILL = "#topic-progress-wrapper";

/**
 * Where a toggle belongs right now, building the cluster if that is the
 * answer. Null when the page has no home for one at all — a list, a profile,
 * or a topic DOM this build does not recognise.
 */
function ensureHome(): Element | null {
  const rail = document.querySelector(RAIL);
  if (rail) return rail;

  const pill = document.querySelector(PILL);
  const beside = pill?.parentElement ?? null;
  if (pill && beside) {
    let cluster = document.querySelector(`.${TOGGLE_CLUSTER}`);
    /* A cluster that is no longer beside this pill belongs to a DOM that has
     * since been rebuilt around it. Discarding it costs one node; keeping it
     * would leave the toggles in a wrapper that no longer holds the pill that
     * explains them — or in no wrapper at all, unplaced. */
    if (cluster && cluster.parentElement !== beside) {
      cluster.remove();
      cluster = null;
    }
    if (!cluster) {
      cluster = document.createElement("div");
      cluster.className = TOGGLE_CLUSTER;
      cluster.setAttribute("role", "group");
      cluster.setAttribute("aria-label", "DevForum Plus");
      /* Before the pill, not after. Below 925px the wrapper is a flex row
       * packed to its end, so a previous sibling stands beside the pill and
       * leaves it in its corner; a next sibling would push the pill inward by
       * the cluster's own width the moment the cluster appeared. */
      pill.insertAdjacentElement("beforebegin", cluster);
    }
    return cluster;
  }

  return (
    document.querySelector(".topic-footer-main-buttons") ??
    document.querySelector("#topic-footer-buttons")
  );
}

/** The cluster exists only while it holds something. */
function sweepCluster(): void {
  const cluster = document.querySelector(`.${TOGGLE_CLUSTER}`);
  if (cluster && cluster.childElementCount === 0) cluster.remove();
}

/**
 * Mount a topic toggle, or re-home the one that already exists.
 *
 * `label` is written once, at creation: quiet-replies rewrites its own label
 * on every pass through a compare-before-write, and a second writer here
 * would undo that guard. `onClick` is bound at creation for the same reason a
 * rebuilt button is safe — it closes over module state, not over the node.
 *
 * Returns the button so the caller can sync its state (pressed, disabled,
 * title), or null when the page has nowhere to put one.
 */
export function mountTopicToggle(
  className: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement | null {
  const existing = document.querySelector<HTMLButtonElement>(`.${className}`);
  const home = ensureHome();
  if (!home) return existing;

  if (existing) {
    if (existing.parentElement !== home) {
      home.appendChild(existing);
      sweepCluster();
    }
    return existing;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `btn btn-default ${className}`;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  /* Appended, so DFP's controls collect below Discourse's own in the rail
   * rather than pushing them down it, and keep the order they mounted in
   * everywhere else. */
  home.appendChild(btn);
  return btn;
}

/** Take a toggle down, and the cluster with it if it was the last one there. */
export function unmountTopicToggle(className: string): void {
  document.querySelector(`.${className}`)?.remove();
  sweepCluster();
}
