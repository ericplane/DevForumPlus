/**
 * A DOM small enough to run `code-intel.ts` against, and no smaller.
 *
 * `isLuauBlock` and `renderBlock` are module-private, and should stay that way —
 * they are not API. But the block sniff is where the audit's worst finding lived
 * (the alternation that reduced to `/\bend\b/` and painted SQL, Python and
 * English prose as Luau), and `renderBlock` is what puts the nested spans inside
 * a `.dfp-dep` mark. Testing either through a copy of the logic tests the copy.
 * So the tests drive the module's real entry point instead, and this is what
 * that needs: elements that answer `className` and `textContent`, a `document`
 * that makes nodes, and a serialiser.
 *
 * ~200 lines against jsdom's ~3 MB, and a dependency-free `npm test` is worth
 * keeping. It also has to serialise for `tests/visual/fixture.html`, which jsdom
 * would have needed anyway.
 *
 * This is not a general-purpose DOM. It implements exactly the calls
 * code-intel.ts makes; anything new it starts calling is `undefined` here and
 * throws, which is the intended failure — see the note on `renderCodeBlock`
 * about where those throws surface. The findings note grew listeners, a roving
 * `tabIndex` and layout reads (`offsetTop`, `clientHeight`), so the stub grew
 * the same: listeners are recorded and fired by hand, and the layout numbers
 * are plain fields a test sets before it asks.
 *
 * `children` is elements only and `childNodes` is everything, as in the DOM.
 * They were one array for a long time, and the preview guard's loop over
 * `children` — whose whole point is that a text-only render has none — would
 * have met a text node here and thrown on `.className`, testing the stub
 * rather than the guard. The MutationObserver is likewise a recorder, not a
 * no-op: what the preview path does with its observer (`takeRecords` after a
 * pass, `disconnect` on detach) is the fix for a timer loop, and a stub that
 * swallowed those calls could not say whether they were made.
 */

import type { PluginApi } from "../../src/discourse/types";
import { codeIntel } from "../../src/discourse/modules/code-intel";

type Node = DElement | DText;
type Listener = (event: Record<string, unknown>) => void;

export class DText {
  parentElement: DElement | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}

class DFragment {
  readonly childNodes: Node[] = [];
  appendChild(n: Node): Node {
    this.childNodes.push(n);
    return n;
  }
}

/** The element `focus()` was last called on; `null` until then. */
let focused: DElement | null = null;
export function activeElement(): DElement | null {
  return focused;
}

export class DElement {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  childNodes: Node[] = [];
  parentElement: DElement | null = null;
  /* Layout, for `syncFold`. A real browser answers from geometry; here a test
   * writes the numbers it wants to reason about. Zero is what a decorator
   * pass would read in a browser too. */
  offsetTop = 0;
  offsetHeight = 0;
  clientHeight = 0;
  /** Set by `scrollIntoView`, so a test can see a chip reached its mark. */
  scrolled = false;
  /** Writable, so a test can close the composer under a pending preview timer. */
  isConnected = true;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }

  readonly classList = {
    add: (...names: string[]): void => {
      const have = this.className.split(/\s+/).filter(Boolean);
      for (const n of names) if (!have.includes(n)) have.push(n);
      this.className = have.join(" ");
    },
    remove: (...names: string[]): void => {
      this.className = this.className
        .split(/\s+/)
        .filter((c) => c && !names.includes(c))
        .join(" ");
    },
    toggle: (name: string): boolean => {
      if (this.classList.contains(name)) {
        this.classList.remove(name);
        return false;
      }
      this.classList.add(name);
      return true;
    },
    contains: (n: string): boolean => this.className.split(/\s+/).includes(n),
  };

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.childNodes = v === "" ? [] : [new DText(v)];
  }

  // `href`/`target`/`rel`/`title`/`type`/`tabIndex` are set as properties but
  // have to serialise as attributes, so they are the same storage.
  get href(): string { return this.attrs.get("href") ?? ""; }
  set href(v: string) { this.attrs.set("href", v); }
  get target(): string { return this.attrs.get("target") ?? ""; }
  set target(v: string) { this.attrs.set("target", v); }
  get rel(): string { return this.attrs.get("rel") ?? ""; }
  set rel(v: string) { this.attrs.set("rel", v); }
  get title(): string { return this.attrs.get("title") ?? ""; }
  set title(v: string) { this.attrs.set("title", v); }
  get type(): string { return this.attrs.get("type") ?? ""; }
  set type(v: string) { this.attrs.set("type", v); }
  get tabIndex(): number { return Number(this.attrs.get("tabindex") ?? -1); }
  set tabIndex(v: number) { this.attrs.set("tabindex", String(v)); }

  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }

  /** Element children only — what `for (const c of el.children)` walks in a browser. */
  get children(): DElement[] {
    return this.childNodes.filter((c): c is DElement => c instanceof DElement);
  }

  get firstElementChild(): DElement | null {
    return this.children[0] ?? null;
  }

  get nextElementSibling(): DElement | null {
    const siblings = this.parentElement?.children ?? [];
    const at = siblings.indexOf(this);
    return at >= 0 ? (siblings[at + 1] ?? null) : null;
  }

  appendChild(n: Node): Node {
    this.childNodes.push(n);
    n.parentElement = this;
    return n;
  }

  replaceChildren(...nodes: (Node | DFragment)[]): void {
    this.childNodes = [];
    for (const n of nodes) {
      if (n instanceof DFragment) for (const c of n.childNodes) this.appendChild(c);
      else this.appendChild(n);
    }
  }

  insertBefore(node: Node, ref: Node | null): Node {
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) {
      this.appendChild(node);
    } else {
      this.childNodes.splice(at, 0, node);
      node.parentElement = this;
    }
    return node;
  }

  remove(): void {
    const p = this.parentElement;
    if (!p) return;
    p.childNodes = p.childNodes.filter((c) => c !== this);
    this.parentElement = null;
  }

  /** Tag and `.class` selectors with the `>` combinator — `pre > code` is the
   *  only compound one code-intel.ts uses, and matching it honestly is three lines. */
  querySelectorAll(selector: string): DElement[] {
    const steps = selector.split(">").map((s) => s.trim());
    const last = steps[steps.length - 1]!;
    const out: DElement[] = [];
    const walk = (el: DElement): void => {
      for (const c of el.children) {
        if (matches(c, last)) {
          let cur: DElement | null = c;
          let ok = true;
          for (let i = steps.length - 2; i >= 0; i--) {
            cur = cur ? cur.parentElement : null;
            if (!cur || !matches(cur, steps[i]!)) { ok = false; break; }
          }
          if (ok) out.push(c);
        }
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): DElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Simple selectors and comma lists, walking up from this element inclusive. */
  closest(selector: string): DElement | null {
    const options = selector.split(",").map((s) => s.trim());
    for (let cur: DElement | null = this; cur; cur = cur.parentElement) {
      if (options.some((o) => matches(cur!, o))) return cur;
    }
    return null;
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** Deliver an event here and up the ancestor chain, `target` fixed on this
   *  element — the note delegates its keydown to itself and reads `e.target`
   *  to find the chip, so a stub that did not bubble would test nothing. */
  fire(type: string, event: Record<string, unknown> = {}): void {
    const ev = { type, target: this, preventDefault: () => undefined, ...event };
    for (let cur: DElement | null = this; cur; cur = cur.parentElement) {
      for (const fn of cur.listeners.get(type) ?? []) fn(ev);
    }
  }

  click(): void {
    this.fire("click");
  }

  focus(): void {
    focused = this;
  }

  scrollIntoView(): void {
    this.scrolled = true;
  }
}

/** `tag`, `.class`, or `tag.class`. */
function matches(el: DElement, step: string): boolean {
  const [tag, ...classes] = step.split(".");
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  return classes.every((c) => el.classList.contains(c));
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeText = (s: string): string => s.replace(/[&<>]/g, (c) => ESCAPES[c]!);
const escapeAttr = (s: string): string => s.replace(/[&<>"]/g, (c) => ESCAPES[c]!);
const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Serialise back to HTML — this is what lands in the visual fixture. */
export function serialize(node: Node): string {
  if (node instanceof DText) return escapeText(node.data);
  const attrs: string[] = [];
  for (const [k, v] of node.attrs) attrs.push(` ${k}="${escapeAttr(v)}"`);
  for (const [k, v] of Object.entries(node.dataset)) attrs.push(` data-${kebab(k)}="${escapeAttr(v)}"`);
  const tag = node.tagName.toLowerCase();
  return `<${tag}${attrs.join("")}>${node.childNodes.map(serialize).join("")}</${tag}>`;
}

function installDom(): void {
  const g = globalThis as Record<string, unknown>;
  if (g["document"]) return;
  g["document"] = {
    createElement: (t: string) => new DElement(t),
    createTextNode: (t: string) => new DText(t),
    createDocumentFragment: () => new DFragment(),
    // `decorate.ts` sweeps `.cooked` on a timer. The tests hand the decorator
    // their own root, so the sweep must find nothing rather than double-visit.
    querySelectorAll: () => [] as DElement[],
  };
  g["requestAnimationFrame"] = () => 0;
  /* The preview path watches its element for hljs's late rewrite, drains the
   * observer after its own render and disconnects it once the preview is
   * gone. Nothing mutates asynchronously here — the tests re-run the pass by
   * hand where a mutation would have — so the observer only records what was
   * asked of it, for the tests that check it was. */
  g["MutationObserver"] = StubObserver;
}

/** What the preview path did with its MutationObserver, per target. */
export class StubObserver {
  static readonly all: StubObserver[] = [];
  target: unknown = null;
  disconnected = false;
  /** `takeRecords()` calls — one per pass, if the pass drains its own mutation. */
  drained = 0;

  constructor(readonly callback: () => void) {
    StubObserver.all.push(this);
  }
  observe(target: unknown): void {
    this.target = target;
  }
  disconnect(): void {
    this.disconnected = true;
  }
  takeRecords(): unknown[] {
    this.drained++;
    return [];
  }
}

/** The observer the preview path installed on `target`, if it installed one. */
export function observerFor(target: DElement): StubObserver | undefined {
  return StubObserver.all.find((o) => o.target === target);
}

const decorators = new Map<string, (el: DElement) => void>();

/** `codeIntel().install()` once, keeping every decorator it registers by id. */
function installOnce(): void {
  if (decorators.size) return;
  installDom();
  const api = {
    decorateCookedElement: (fn: (el: DElement) => void, opts?: { id?: string }) => {
      decorators.set(opts?.id ?? "", fn);
    },
  } as unknown as PluginApi;
  codeIntel(api).install();
  if (!decorators.size) throw new Error("code-intel registered no decorator");
}

/** The stream decorator — what runs over every `.cooked` post. */
function getDecorator(): (el: DElement) => void {
  installOnce();
  const fn = decorators.get("dfp-code-intel");
  if (!fn) throw new Error("code-intel registered no stream decorator");
  return fn;
}

/** The composer-preview decorator, registered without `onlyStream`. */
export function getPreviewDecorator(): (el: DElement) => void {
  installOnce();
  const fn = decorators.get("dfp-code-intel-preview");
  if (!fn) throw new Error("code-intel registered no preview decorator");
  return fn;
}

export interface Rendered {
  /** Did the block pass `isLuauBlock`? The module marks accepted blocks. */
  luau: boolean;
  /** The `<code>` element's inner markup, exactly as the extension builds it. */
  html: string;
  /** The `.dfp-code-note` summary line's text, or `null` when nothing was found. */
  note: string | null;
  /** The note element serialised, or `null`. */
  noteHtml: string | null;
  /** The live nodes, for tests that fire events at the note. */
  bar: DElement | null;
  pre: DElement;
  code: DElement;
}

/**
 * Run one `<pre><code>` through the shipped decorator.
 *
 * `decorate.ts` wraps the decorator in a `try {} catch {}` so one bad post
 * cannot take out a sweep — which means a gap in this stub surfaces as
 * `luau: false` with the source text untouched, indistinguishable from a block
 * the gate rejected. The first case in `highlight.test.ts` is an accepted block
 * asserting real spans for exactly that reason: if the stub cannot complete a
 * render, that case fails first and loudly.
 */
export function renderCodeBlock(source: string, className = ""): Rendered {
  const decorate = getDecorator();

  const cooked = new DElement("div");
  cooked.className = "cooked";
  const pre = new DElement("pre");
  const code = new DElement("code");
  if (className) code.className = className;
  code.textContent = source;
  pre.appendChild(code);
  cooked.appendChild(pre);

  decorate(cooked);

  const bar = cooked.children.find(
    (c): c is DElement => c instanceof DElement && c.classList.contains("dfp-code-note"),
  ) ?? null;
  return {
    luau: code.classList.contains("dfp-luau"),
    html: code.childNodes.map(serialize).join(""),
    note: bar ? bar.textContent : null,
    noteHtml: bar ? serialize(bar) : null,
    bar,
    pre,
    code,
  };
}
