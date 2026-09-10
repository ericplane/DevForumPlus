/**
 * The one home for the topic toggles, and the chain that decides it.
 *
 * thread-view, op-pin and quiet-replies used to carry the same three-line
 * anchor chain each, and all three had the same hole: below the width where
 * Discourse swaps the timeline rail for the "N / M" progress pill, the rail's
 * footer controls exist only inside the fullscreen timeline the pill opens, so
 * the toggles were absent mid-thread in any half-width window. This holds the
 * order — rail, then a DFP cluster beside the pill, then the footer — and the
 * two properties the migration depends on: an existing button is the same node
 * after a re-home (op-pin's disabled state and title must survive it), and a
 * pass on the steady state writes nothing (every caller runs from a childList
 * observer, so a mutation per pass would be a pass per frame forever).
 *
 * The stand-in DOM below implements exactly the calls topic-toggles.ts makes —
 * `querySelector` for `.class` and `#id`, `createElement`, `appendChild`,
 * `insertAdjacentElement("beforebegin")`, `remove`, `childElementCount`,
 * `parentElement` — and counts every structural write, which is how the
 * steady-state check is honest rather than assumed.
 */

import {
  TOGGLE_CLUSTER,
  mountTopicToggle,
  unmountTopicToggle,
} from "../../src/discourse/topic-toggles";

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

/** Structural writes since the last reset — the steady-state meter. */
let writes = 0;

class El {
  id = "";
  className = "";
  type = "";
  textContent = "";
  title = "";
  disabled = false;
  readonly attrs = new Map<string, string>();
  readonly listeners: string[] = [];
  children: El[] = [];
  parentElement: El | null = null;

  constructor(readonly tagName: string) {}

  get childElementCount(): number {
    return this.children.length;
  }
  hasClass(name: string): boolean {
    return this.className.split(/\s+/).includes(name);
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(type: string): void {
    this.listeners.push(type);
  }
  private detach(): void {
    const p = this.parentElement;
    if (!p) return;
    p.children.splice(p.children.indexOf(this), 1);
    this.parentElement = null;
  }
  appendChild(el: El): El {
    writes++;
    el.detach();
    this.children.push(el);
    el.parentElement = this;
    return el;
  }
  insertAdjacentElement(where: string, el: El): El | null {
    if (where !== "beforebegin" && where !== "afterend") {
      throw new Error(`stand-in DOM: unsupported position ${where}`);
    }
    const p = this.parentElement;
    if (!p) return null;
    writes++;
    el.detach();
    p.children.splice(p.children.indexOf(this) + (where === "afterend" ? 1 : 0), 0, el);
    el.parentElement = p;
    return el;
  }
  remove(): void {
    if (this.parentElement) writes++;
    this.detach();
  }
  querySelector(selector: string): El | null {
    const byId = selector.startsWith("#");
    const key = selector.slice(1);
    for (const c of this.children) {
      if (byId ? c.id === key : c.hasClass(key)) return c;
      const deeper = c.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }
}

const root = new El("html");
const g = globalThis as { document?: unknown };
g.document = {
  createElement: (tag: string) => new El(tag),
  querySelector: (selector: string) => root.querySelector(selector),
};

const make = (tag: string, cls = "", id = ""): El => {
  const el = new El(tag);
  el.className = cls;
  el.id = id;
  return el;
};
const reset = (): void => {
  root.children = [];
  writes = 0;
};
const cluster = () => root.querySelector(`.${TOGGLE_CLUSTER}`);
/** The module speaks HTMLButtonElement; the stand-in is what it actually gets. */
const mount = (className: string, label: string, onClick: () => void): El | null =>
  mountTopicToggle(className, label, onClick) as unknown as El | null;

try {
  console.log("── the rail wins while there is one ──────────────────────────────");
  {
    reset();
    const timeline = root.appendChild(make("div", "topic-timeline"));
    const rail = timeline.appendChild(make("div", "timeline-footer-controls"));
    root.appendChild(make("div", "", "topic-progress-wrapper"));
    writes = 0;

    let clicks = 0;
    const btn = mount("dfp-thread-toggle", "Thread view", () => clicks++);
    check(btn !== null && btn.parentElement === rail, "mounts into .timeline-footer-controls");
    eq(btn?.className, "btn btn-default dfp-thread-toggle", "…as a Discourse-styled button");
    eq(btn?.type, "button", "…that never submits");
    eq(btn?.textContent, "Thread view", "…with the label");
    eq(btn?.listeners.join(","), "click", "…and the click bound");
    eq(cluster(), null, "no cluster is built while the rail is there, pill or not");
    void clicks;

    writes = 0;
    const again = mount("dfp-thread-toggle", "Thread view", () => {});
    check(again === btn, "a second pass returns the same node");
    eq(writes, 0, "…and writes nothing");
    eq(rail.childElementCount, 1, "…so there is one button, not two");
  }

  console.log("\n── the cluster beside the pill, when the rail has collapsed ───────");
  {
    reset();
    const nav = root.appendChild(make("div", "topic-navigation"));
    const pill = nav.appendChild(make("div", "", "topic-progress-wrapper"));
    const footer = root.appendChild(make("div", "", "topic-footer-buttons"));
    footer.appendChild(make("div", "topic-footer-main-buttons"));
    writes = 0;

    const thread = mount("dfp-thread-toggle", "Thread view", () => {});
    const made = cluster();
    check(made !== null, "a .dfp-topic-toggles cluster is built");
    check(made?.parentElement === nav, "…as a child of the pill's parent");
    // Before it: the wrapper is a flex row packed to its end below 925px, so
    // a previous sibling stands beside the pill and leaves it in its corner.
    eq(made ? nav.children.indexOf(made) : -1, nav.children.indexOf(pill) - 1, "…directly before the pill");
    eq(made?.getAttribute("role"), "group", "…announced as a group");
    check(thread?.parentElement === made, "…holding the toggle, not the footer");

    const pin = mount("dfp-op-toggle", "Pin post", () => {});
    check(pin?.parentElement === made, "a second toggle joins the same cluster");
    eq(root.querySelector(".topic-navigation")?.children.length, 2, "…and no second cluster is built");
    eq(made?.children.map((c) => c.className.split(" ").pop()).join(","), "dfp-thread-toggle,dfp-op-toggle", "…in mount order");

    writes = 0;
    mount("dfp-thread-toggle", "Thread view", () => {});
    mount("dfp-op-toggle", "Pin post", () => {});
    eq(writes, 0, "the steady state writes nothing");
  }

  console.log("\n── widening: the rail comes back and the buttons move to it ───────");
  {
    reset();
    const nav = root.appendChild(make("div", "topic-navigation"));
    nav.appendChild(make("div", "", "topic-progress-wrapper"));
    const pin = mount("dfp-op-toggle", "Pin post", () => {}) as El;
    pin.disabled = true;
    pin.title = "Needs a window at least 1280px wide to pin";
    pin.setAttribute("aria-pressed", "false");
    const before = cluster();

    // Discourse swaps the pill for the rail; the cluster, a sibling outside
    // the swapped block, survives with the button still in it.
    nav.children = nav.children.filter((c) => c.id !== "topic-progress-wrapper");
    const rail = nav.appendChild(make("div", "timeline-footer-controls"));
    writes = 0;

    const after = mount("dfp-op-toggle", "Pin post", () => {});
    check(after === pin, "the existing button is re-homed, not remade");
    check(pin.parentElement === rail, "…into the rail");
    eq(pin.disabled, true, "…keeping its disabled state");
    eq(pin.title, "Needs a window at least 1280px wide to pin", "…and its title");
    eq(pin.getAttribute("aria-pressed"), "false", "…and aria-pressed");
    check(before !== null && cluster() === null, "the emptied cluster is dropped");
    eq(writes, 2, "one move and one removal, nothing else");
  }

  console.log("\n── unmounting ─────────────────────────────────────────────────────");
  {
    reset();
    const nav = root.appendChild(make("div", "topic-navigation"));
    nav.appendChild(make("div", "", "topic-progress-wrapper"));
    mount("dfp-thread-toggle", "Thread view", () => {});
    mount("dfp-quiet-toggle", "Quiet (3)", () => {});

    unmountTopicToggle("dfp-quiet-toggle");
    eq(root.querySelector(".dfp-quiet-toggle"), null, "the toggle is removed");
    check(cluster() !== null, "…and the cluster stays while another toggle is in it");

    unmountTopicToggle("dfp-thread-toggle");
    eq(cluster(), null, "…and goes with the last one");

    writes = 0;
    unmountTopicToggle("dfp-thread-toggle");
    eq(writes, 0, "unmounting what is not there writes nothing");
  }

  console.log("\n── the footer is last, and only when there is nothing else ────────");
  {
    reset();
    const footer = root.appendChild(make("div", "", "topic-footer-buttons"));
    const main = footer.appendChild(make("div", "topic-footer-main-buttons"));
    const btn = mount("dfp-thread-toggle", "Thread view", () => {});
    check(btn?.parentElement === main, ".topic-footer-main-buttons before #topic-footer-buttons");

    reset();
    const bare = root.appendChild(make("div", "", "topic-footer-buttons"));
    const alone = mount("dfp-thread-toggle", "Thread view", () => {});
    check(alone?.parentElement === bare, "#topic-footer-buttons when the main group is absent");

    reset();
    root.appendChild(make("div", "post-stream"));
    writes = 0;
    eq(mount("dfp-thread-toggle", "Thread view", () => {}), null, "no home at all → null");
    eq(writes, 0, "…and nothing is built, cluster included");
  }

  console.log("\n── a cluster orphaned by a rebuilt DOM is replaced, not reused ────");
  {
    reset();
    const oldNav = root.appendChild(make("div", "topic-navigation"));
    oldNav.appendChild(make("div", "", "topic-progress-wrapper"));
    mount("dfp-thread-toggle", "Thread view", () => {});
    const stale = cluster() as El;

    // The pill is rebuilt elsewhere; the old cluster is still in the document
    // beside nothing.
    oldNav.children = oldNav.children.filter((c) => c.id !== "topic-progress-wrapper");
    const newNav = root.appendChild(make("div", "topic-navigation"));
    newNav.appendChild(make("div", "", "topic-progress-wrapper"));

    const btn = mount("dfp-thread-toggle", "Thread view", () => {});
    const fresh = cluster();
    check(fresh !== null && fresh !== stale, "a new cluster is built beside the new pill");
    check(fresh?.parentElement === newNav, "…under the new pill's parent");
    check(btn?.parentElement === fresh, "…and the button moves into it");
    eq(stale.parentElement, null, "…while the orphan is gone");
  }
} finally {
  delete g.document;
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
