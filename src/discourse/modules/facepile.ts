import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { onDomChange } from "../dom-watch";

/**
 * Fold the "who liked this" list down to a handful of faces.
 *
 * Expanding the likers on a popular post drops the whole list into the page —
 * the post this was built against has 83, which is two full-width rows of 24px
 * thumbnails sitting under the action bar. No amount of styling makes that
 * calm: Roblox avatars are individually colourful, so at that count the block
 * reads as visual noise and outweighs the post it belongs to. It was restyled
 * twice before arriving at the obvious answer, which is to show fewer.
 *
 * Nothing is lost. The overflow is hidden in CSS, not removed, and one click
 * brings it back — the same "+N" affordance the group chips use, so a reader
 * meets one pattern for "there is more here" rather than two.
 *
 * Only the like list is ever this long in practice, but the module is written
 * against `.small-user-list` generally so the read list behaves the same way if
 * it is ever populated.
 */

const LIMIT = 12;
const STATE = "data-dfp-faces";
const EXTRA = "dfp-face--extra";

function enhance(list: HTMLElement): void {
  const content = list.querySelector<HTMLElement>(".small-user-list-content");
  if (!content) return;

  const faces = [...content.querySelectorAll<HTMLElement>("a")];
  /* Idempotency is checked by looking for the button rather than by stamping
   * the list. Discourse re-renders this content when the list is collapsed and
   * reopened, which would throw away the button while leaving any marker
   * attribute behind — and the list would then never be folded again. */
  const existing = content.querySelector<HTMLElement>(".dfp-face-more");

  /* Clicking the like count a second time collapses the list by emptying it in
   * place: `--expanded` comes off and the anchors go from 84 to 0, but the
   * `.small-user-list` and its content element both stay. The button is a child
   * Discourse knows nothing about, so it survived the cull and sat there alone
   * under the action bar — a "Show fewer" pill controlling nothing. Anything
   * this module added has to come back out when the faces do.
   *
   * This branch is also the "fewer than the threshold" case, which is why it is
   * a count test rather than a check for `--expanded`. */
  if (faces.length <= LIMIT + 2) {
    if (existing) existing.remove();
    list.removeAttribute(STATE);
    for (const face of faces) face.classList.remove(EXTRA);
    return;
  }

  if (existing) return;

  const hidden = faces.length - LIMIT;
  faces.forEach((face, i) => {
    if (i >= LIMIT) face.classList.add(EXTRA);
  });

  const more = document.createElement("button");
  more.type = "button";
  more.className = "dfp-face-more";
  more.setAttribute("aria-expanded", "false");
  const shut = `+${hidden} others`;
  more.textContent = shut;

  more.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = list.getAttribute(STATE) === "open";
    list.setAttribute(STATE, open ? "shut" : "open");
    more.setAttribute("aria-expanded", open ? "false" : "true");
    more.textContent = open ? shut : "Show fewer";
  });

  list.setAttribute(STATE, "shut");
  /* After "liked this", not before it: collapsed the row reads
   * "[faces] liked this +71 others", and expanded it reads
   * "[faces] liked this Show fewer". Putting the button first would produce
   * "Show fewer liked this". */
  content.appendChild(more);
}

function scan(root: ParentNode): void {
  for (const list of root.querySelectorAll<HTMLElement>(".small-user-list")) enhance(list);
}

export function facepile(_api: PluginApi): DfpModule {
  return {
    id: "facepile",
    budgetMs: 60,

    install() {
      // Deferred: a topic can hold a hundred posts, and a synchronous sweep is
      // charged against the install budget.
      queueMicrotask(() => scan(document));

      /* The list is empty until someone opens it, so the interesting event is
       * always a mutation rather than a page change. */
      onDomChange((records) => {
        for (const rec of records) {
          for (const node of rec.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.classList.contains("small-user-list")) enhance(node);
            else scan(node);
          }
          /* Discourse fills an existing list in place, which shows up as nodes
           * added to `.small-user-list-content` rather than a new list.
           *
           * Deliberately NOT gated on `rec.addedNodes.length`. Collapsing the
           * list only ever removes nodes, so that guard meant the module never
           * heard about a collapse and its button was left behind controlling
           * nothing. Re-running `enhance` handles both directions.
           *
           * It cannot loop: adding or removing the button mutates the content
           * and calls `enhance` again, which returns immediately because the
           * button now agrees with the face count either way. */
          if (rec.target instanceof HTMLElement) {
            const list = rec.target.closest<HTMLElement>(".small-user-list");
            if (list) enhance(list);
          }
        }
      });
    },
  };
}
