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
 * ~150 lines against jsdom's ~3 MB, and a dependency-free `npm test` is worth
 * keeping. It also has to serialise for `tests/visual/fixture.html`, which jsdom
 * would have needed anyway.
 *
 * This is not a general-purpose DOM. It implements exactly the calls
 * code-intel.ts makes; anything new it starts calling is `undefined` here and
 * throws, which is the intended failure — see the note on `renderCodeBlock`
 * about where those throws surface.
 */

import type { PluginApi } from "../../src/discourse/types";
import { codeIntel } from "../../src/discourse/modules/code-intel";

type Node = DElement | DText;

class DText {
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}

class DFragment {
  readonly children: Node[] = [];
  appendChild(n: Node): Node {
    this.children.push(n);
    return n;
  }
}

class DElement {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  children: Node[] = [];
  parentElement: DElement | null = null;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }

  /* Only `add` and `contains`: the module adds `dfp-luau` and the tests ask
   * whether it did, which is the whole of the gate's observable behaviour. */
  readonly classList = {
    add: (...names: string[]): void => {
      const have = this.className.split(/\s+/).filter(Boolean);
      for (const n of names) if (!have.includes(n)) have.push(n);
      this.className = have.join(" ");
    },
    contains: (n: string): boolean => this.className.split(/\s+/).includes(n),
  };

  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = v === "" ? [] : [new DText(v)];
  }

  // `href`/`target`/`rel`/`title` are set as properties by renderBlock but have
  // to serialise as attributes, so they are the same storage.
  get href(): string { return this.attrs.get("href") ?? ""; }
  set href(v: string) { this.attrs.set("href", v); }
  get target(): string { return this.attrs.get("target") ?? ""; }
  set target(v: string) { this.attrs.set("target", v); }
  get rel(): string { return this.attrs.get("rel") ?? ""; }
  set rel(v: string) { this.attrs.set("rel", v); }
  get title(): string { return this.attrs.get("title") ?? ""; }
  set title(v: string) { this.attrs.set("title", v); }

  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }

  appendChild(n: Node): Node {
    this.children.push(n);
    if (n instanceof DElement) n.parentElement = this;
    return n;
  }

  replaceChildren(...nodes: (Node | DFragment)[]): void {
    this.children = [];
    for (const n of nodes) {
      if (n instanceof DFragment) for (const c of n.children) this.appendChild(c);
      else this.appendChild(n);
    }
  }

  insertBefore(node: Node, ref: Node | null): Node {
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) {
      this.appendChild(node);
    } else {
      this.children.splice(at, 0, node);
      if (node instanceof DElement) node.parentElement = this;
    }
    return node;
  }

  /** Tag and `.class` selectors with the `>` combinator — `pre > code` is the
   *  only one code-intel.ts uses, and matching it honestly is three lines. */
  querySelectorAll(selector: string): DElement[] {
    const steps = selector.split(">").map((s) => s.trim());
    const last = steps[steps.length - 1]!;
    const out: DElement[] = [];
    const walk = (el: DElement): void => {
      for (const c of el.children) {
        if (!(c instanceof DElement)) continue;
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
}

function matches(el: DElement, step: string): boolean {
  return step.startsWith(".")
    ? el.classList.contains(step.slice(1))
    : el.tagName === step.toUpperCase();
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
  return `<${tag}${attrs.join("")}>${node.children.map(serialize).join("")}</${tag}>`;
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
}

let decorator: ((el: DElement) => void) | null = null;

/** `codeIntel().install()` once, keeping the decorator it registers. */
function getDecorator(): (el: DElement) => void {
  if (decorator) return decorator;
  installDom();
  const api = {
    decorateCookedElement: (fn: (el: DElement) => void) => { decorator = fn; },
  } as unknown as PluginApi;
  codeIntel(api).install();
  if (!decorator) throw new Error("code-intel registered no decorator");
  return decorator;
}

export interface Rendered {
  /** Did the block pass `isLuauBlock`? The module marks accepted blocks. */
  luau: boolean;
  /** The `<code>` element's inner markup, exactly as the extension builds it. */
  html: string;
  /** The `.dfp-code-note` summary line, or `null` when nothing was found. */
  note: string | null;
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

  const note = cooked.children.find(
    (c): c is DElement => c instanceof DElement && c.classList.contains("dfp-code-note"),
  );
  return {
    luau: code.classList.contains("dfp-luau"),
    html: code.children.map(serialize).join(""),
    note: note ? note.textContent : null,
  };
}
