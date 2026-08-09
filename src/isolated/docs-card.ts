import {
  DOC_CLASSES,
  DOC_DATATYPES,
  DOC_NAMESPACES,
  DOC_ENUMS,
  docGroupOf,
  type DocGroup,
} from "../luau/docs-names.generated";

/**
 * Creator Docs hover cards.
 *
 * The MAIN-world code-intel module marks tokens it has resolved with
 * `data-dfp-api="Owner"` or `data-dfp-api="Owner.Member"`. This runs in the
 * ISOLATED world, which is where chrome.* lives and where the config says all
 * DFP-rendered UI belongs. The two worlds share one DOM, so nothing has to
 * cross the bridge — this just reads the attribute the other side wrote.
 *
 * Everything is local. The shards are packaged with the extension, so hovering
 * an API name makes no network request and cannot report what anyone is
 * reading.
 *
 * ── Trusting the attribute ──────────────────────────────────────────────────
 * `data-dfp-api` is read out of the page. Even though DFP wrote it, a forum
 * post is untrusted content and could contain the same attribute — Discourse's
 * sanitiser is not something to bet a path join on. So the owner is checked
 * against the generated name sets before it is ever used to build a URL. Not a
 * regex on the way in; membership in a closed set. A name that is not in the
 * index cannot produce a fetch at all.
 * ───────────────────────────────────────────────────────────────────────────
 */

const ATTR = "data-dfp-api";
const OPEN_DELAY = 220;
const CLOSE_DELAY = 140;

/* Mirrors the kind codes in scripts/build-docs-index.ts. */
const KIND_LABEL = [
  "property",
  "method",
  "event",
  "callback",
  "function",
  "constructor",
  "constant",
  "operator",
] as const;

const F_DEPRECATED = 1;
const F_YIELDS = 2;
const F_SECURITY = 4;
const F_READONLY = 8;

type Param = [name: string, type: string, def?: string];
type Member = [
  kind?: number,
  params?: Param[],
  returns?: string[],
  summary?: string,
  flags?: number,
];

interface Shard {
  s: string;
  i?: string;
  f?: number;
  m: Record<string, Member>;
}

const DOCS_ROOT = "https://create.roblox.com/docs/reference/engine/";

/** Shards are immutable build output, so one fetch per owner is enough. */
const cache = new Map<string, Promise<Shard | null>>();

function loadShard(group: DocGroup, name: string): Promise<Shard | null> {
  const key = `${group}/${name}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = fetch(chrome.runtime.getURL(`docs/${group}/${name}.json`))
      .then((r) => (r.ok ? (r.json() as Promise<Shard>) : null))
      .catch(() => null);
    cache.set(key, hit);
  }
  return hit;
}

/**
 * Find a member, walking the inheritance chain.
 *
 * Creator Docs does not repeat inherited members: `Part.yaml` declares one
 * member and points at `FormFactorPart`, which points at `BasePart`, which has
 * the other 105. Without the walk, hovering `part.Anchored` finds nothing.
 */
/**
 * Every group that documents this name.
 *
 * Four names live in two groups at once — `Instance` is both a class and a
 * datatype, `Platform` and `Status` are both classes and enums, `Font` is both
 * a datatype and an enum. Taking only the first match loses real members:
 * `Instance.new` is documented on the *datatype* page, so hovering the most
 * common call in all of Roblox scripting found nothing.
 */
function groupsFor(owner: string): DocGroup[] {
  const out: DocGroup[] = [];
  if (DOC_CLASSES.has(owner)) out.push("c");
  if (DOC_DATATYPES.has(owner)) out.push("d");
  if (DOC_NAMESPACES.has(owner)) out.push("g");
  if (DOC_ENUMS.has(owner)) out.push("e");
  return out;
}

async function resolve(
  owner: string,
  member: string | null,
): Promise<{ shard: Shard; member?: Member; from?: string } | null> {
  const groups = owner === "globals" ? (["g"] as DocGroup[]) : groupsFor(owner);
  if (!groups.length) return null;

  let first: Shard | null = null;
  for (const group of groups) {
    const shard = await loadShard(group, owner);
    if (!shard) continue;
    first ??= shard;
    if (!member) return { shard };

    // Walk the inheritance chain. Creator Docs does not repeat inherited
    // members: `Part.yaml` declares one and points at `FormFactorPart`, which
    // points at `BasePart`, which holds the other 105.
    let cur: Shard | null = shard;
    let curName = owner;
    for (let depth = 0; cur && depth < 24; depth++) {
      const hit = cur.m[member];
      if (hit) {
        return { shard, member: hit, from: curName === owner ? undefined : curName };
      }
      const parent: string | undefined = cur.i;
      if (!parent || !DOC_CLASSES.has(parent)) break;
      curName = parent;
      cur = await loadShard("c", parent);
    }
  }

  // The owner is real but the member is not — someone's own field on an
  // instance, most likely. Show the owner rather than nothing.
  return first ? { shard: first } : null;
}

// ── Rendering ───────────────────────────────────────────────────────────────

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let card: HTMLDivElement | null = null;
let openFor: Element | null = null;
let openTimer = 0;
let closeTimer = 0;
/** Bumped on every hover so a slow shard cannot render over a newer one. */
let generation = 0;

const CARD_CSS = `
:host { all: initial; }
.card {
  position: fixed;
  z-index: 2147483000;
  max-width: 26rem;
  padding: 10px 12px;
  border-radius: var(--dfp-r-md, 10px);
  border: 1px solid var(--dfp-border, #333);
  background: var(--dfp-surface-2, #1c1f25);
  color: var(--dfp-text, #eff4fc);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.4);
  font-family: var(--dfp-font, system-ui, sans-serif);
  font-size: 13px;
  line-height: 1.5;
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 120ms ease, transform 120ms ease;
  pointer-events: auto;
}
.card[data-shown="1"] { opacity: 1; transform: none; }
.head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.name {
  font-family: var(--dfp-mono, ui-monospace, monospace);
  font-size: 13px;
  font-weight: 600;
  color: var(--dfp-text, #eff4fc);
  word-break: break-word;
}
.owner { color: var(--dfp-text-3, #868a91); font-weight: 400; }
.kind {
  font-size: 11px;
  text-transform: lowercase;
  color: var(--dfp-text-3, #868a91);
  border: 1px solid var(--dfp-border, #333);
  border-radius: 999px;
  padding: 0 6px;
}
.sig {
  margin-top: 6px;
  font-family: var(--dfp-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--dfp-text-2, #b4b8c0);
  word-break: break-word;
}
.sig .p { color: var(--dfp-accent, #37b3ff); }
.sig .t { color: var(--dfp-success, #1ac972); }
.sum { margin-top: 7px; color: var(--dfp-text-2, #b4b8c0); }
.flags { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.flag {
  font-size: 11px;
  border-radius: 999px;
  padding: 1px 7px;
  border: 1px solid transparent;
}
.flag.dep {
  color: var(--dfp-deprecated, #ff8a4c);
  border-color: color-mix(in oklab, var(--dfp-deprecated, #ff8a4c) 40%, transparent);
}
.flag.yield {
  color: var(--dfp-warning, #e19900);
  border-color: color-mix(in oklab, var(--dfp-warning, #e19900) 40%, transparent);
}
.flag.sec, .flag.ro {
  color: var(--dfp-text-3, #868a91);
  border-color: var(--dfp-border, #333);
}
.foot {
  display: flex; justify-content: space-between; align-items: center;
  gap: 10px; margin-top: 9px; padding-top: 8px;
  border-top: 1px solid var(--dfp-border, #333);
}
.inh { color: var(--dfp-text-3, #868a91); font-size: 11px; }
a.more {
  color: var(--dfp-accent, #37b3ff);
  text-decoration: none;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
a.more:hover { text-decoration: underline; }
@media (prefers-reduced-motion: reduce) {
  .card { transition: none; }
}
`;

function ensureHost(): HTMLDivElement {
  if (host?.isConnected) return host;
  host = document.createElement("div");
  host.id = "dfp-docs-card";
  // A shadow root so nothing here inherits Discourse's typography, and nothing
  // here leaks into the page.
  shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CARD_CSS;
  card = document.createElement("div");
  card.className = "card";
  card.addEventListener("mouseenter", () => clearTimeout(closeTimer));
  card.addEventListener("mouseleave", scheduleClose);
  shadow.append(style, card);
  document.body.appendChild(host);
  return host;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** `Create(tweenInfo: TweenInfo, propertyTable: table): Tween` */
function signature(name: string, m: Member): HTMLElement {
  const sig = el("div", "sig");
  const kind = m[0] ?? 0;
  const params = m[1] ?? [];
  const returns = m[2] ?? [];
  /* Events are included: their `parameters` are what the connected callback
   * receives, which is the single thing a reader wants when they hover
   * `Touched` — `(otherPart: BasePart)`. */
  const callable = kind === 1 || kind === 2 || kind === 3 || kind === 4 || kind === 5;

  sig.append(document.createTextNode(name));
  if (callable) {
    sig.append(document.createTextNode("("));
    params.forEach((p, i) => {
      if (i) sig.append(document.createTextNode(", "));
      sig.append(el("span", "p", p[0]));
      sig.append(document.createTextNode(": "));
      sig.append(el("span", "t", p[1]));
      // A default is the fastest way to see an argument is optional.
      if (p[2] !== undefined) sig.append(document.createTextNode(` = ${p[2]}`));
    });
    sig.append(document.createTextNode(")"));
  }
  if (returns.length) {
    sig.append(document.createTextNode(": "));
    sig.append(el("span", "t", returns.join(", ")));
  }
  return sig;
}

function flagRow(flags: number): HTMLElement | null {
  const row = el("div", "flags");
  if (flags & F_DEPRECATED) row.append(el("span", "flag dep", "deprecated"));
  if (flags & F_YIELDS) row.append(el("span", "flag yield", "yields"));
  if (flags & F_SECURITY) row.append(el("span", "flag sec", "restricted"));
  if (flags & F_READONLY) row.append(el("span", "flag ro", "read-only"));
  return row.childElementCount ? row : null;
}

function build(api: string, owner: string, member: string | null, r: {
  shard: Shard;
  member?: Member;
  from?: string;
}): DocumentFragment {
  const frag = document.createDocumentFragment();

  const head = el("div", "head");
  const name = el("div", "name");
  if (member && r.member) {
    name.append(el("span", "owner", `${owner}.`));
    name.append(document.createTextNode(member));
  } else {
    name.append(document.createTextNode(owner));
  }
  head.append(name);

  const kind = r.member ? KIND_LABEL[r.member[0] ?? 0] : shardKind(owner);
  if (kind) head.append(el("span", "kind", kind));
  frag.append(head);

  if (r.member) {
    /* A property or constant with no known type would render as its own name
     * and nothing else, directly under the title that already says it — an
     * enum item like `KeyCode.Space` is the common case. */
    const kind = r.member[0] ?? 0;
    const bare = (kind === 0 || kind === 6) && !(r.member[2] ?? []).length;
    if (!bare) frag.append(signature(member!, r.member));
    const sum = r.member[3];
    if (sum) frag.append(el("div", "sum", sum));
    const flags = flagRow((r.member[4] ?? 0) | (r.shard.f ?? 0));
    if (flags) frag.append(flags);
  } else {
    if (r.shard.s) frag.append(el("div", "sum", r.shard.s));
    const flags = flagRow(r.shard.f ?? 0);
    if (flags) frag.append(flags);
  }

  const foot = el("div", "foot");
  foot.append(el("span", "inh", r.from ? `inherited from ${r.from}` : ""));
  const link = document.createElement("a");
  link.className = "more";
  link.href = urlFor(api, owner, member);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Creator Docs ↗";
  foot.append(link);
  frag.append(foot);

  return frag;
}

function shardKind(owner: string): string | null {
  if (DOC_CLASSES.has(owner)) return "class";
  if (DOC_DATATYPES.has(owner)) return "datatype";
  if (DOC_NAMESPACES.has(owner)) return "library";
  if (DOC_ENUMS.has(owner)) return "enum";
  return null;
}

function urlFor(api: string, owner: string, member: string | null): string {
  const hash = member ? `#${member}` : "";
  if (api.startsWith("globals.")) return `${DOCS_ROOT}globals/RobloxGlobals${hash}`;
  if (DOC_CLASSES.has(owner)) return `${DOCS_ROOT}classes/${owner}${hash}`;
  if (DOC_DATATYPES.has(owner)) return `${DOCS_ROOT}datatypes/${owner}${hash}`;
  if (DOC_NAMESPACES.has(owner)) return `${DOCS_ROOT}libraries/${owner}${hash}`;
  if (DOC_ENUMS.has(owner)) return `${DOCS_ROOT}enums/${owner}${hash}`;
  return DOCS_ROOT;
}

/** Keep the card on screen and beside its token, preferring below. */
function place(target: Element): void {
  if (!card) return;
  const t = target.getBoundingClientRect();
  card.style.visibility = "hidden";
  card.style.left = "0px";
  card.style.top = "0px";
  const c = card.getBoundingClientRect();
  const margin = 8;

  let left = t.left;
  if (left + c.width > innerWidth - margin) left = innerWidth - c.width - margin;
  if (left < margin) left = margin;

  let top = t.bottom + 6;
  if (top + c.height > innerHeight - margin) {
    const above = t.top - c.height - 6;
    // Only flip up if there is genuinely more room there.
    if (above > margin) top = above;
    else top = Math.max(margin, innerHeight - c.height - margin);
  }

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
  card.style.visibility = "";
}

function close(): void {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  generation++;
  openFor = null;
  if (card) {
    card.dataset["shown"] = "0";
    card.replaceChildren();
  }
  if (host) host.style.display = "none";
}

function scheduleClose(): void {
  clearTimeout(closeTimer);
  closeTimer = window.setTimeout(close, CLOSE_DELAY);
}

async function open(target: HTMLElement): Promise<void> {
  const api = target.getAttribute(ATTR);
  if (!api) return;

  const dot = api.indexOf(".");
  const owner = dot === -1 ? api : api.slice(0, dot);
  const member = dot === -1 ? null : api.slice(dot + 1);

  // Closed-set check before anything becomes a path. See the header comment.
  const isGlobals = owner === "globals";
  if (!isGlobals && !docGroupOf(owner)) return;
  if (member && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) return;

  const gen = ++generation;
  const r = isGlobals
    ? await resolve("globals", member)
    : await resolve(owner, member);
  // A newer hover started, or the pointer left, while the shard was loading.
  if (gen !== generation || openFor !== target || !r) return;

  ensureHost();
  if (!card || !host) return;
  host.style.display = "";
  card.replaceChildren(build(api, isGlobals ? (member ?? owner) : owner, member, r));
  place(target);
  card.dataset["shown"] = "1";
}

// ── Confirming member-level references ──────────────────────────────────────

interface VerifyEntry {
  i?: string;
  m: string;
}

let verifyIndex: Promise<Record<string, VerifyEntry> | null> | null = null;

/**
 * The member index, fetched at most once and only on a page that needs it.
 *
 * 28 kB gzipped, read from disk. Most forum pages — topic lists, profiles,
 * notifications — never touch this, because they contain no code.
 */
function loadVerifyIndex(): Promise<Record<string, VerifyEntry> | null> {
  verifyIndex ??= fetch(chrome.runtime.getURL("docs/members.json"))
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, VerifyEntry>>) : null))
    .catch(() => null);
  return verifyIndex;
}

/** Does `member` exist on `owner`, or anything it inherits from? */
function memberExists(
  index: Record<string, VerifyEntry>,
  owner: string,
  member: string,
): boolean {
  let cur: string | undefined = owner;
  for (let depth = 0; cur && depth < 24; depth++) {
    const entry: VerifyEntry | undefined = index[cur];
    if (!entry) return false;
    // Split per lookup rather than caching a Set: the miss path is the common
    // one, and `includes` on a space-joined string with guards is cheaper than
    // building a Set for an owner hovered once.
    if (entry.m && (` ${entry.m} ` as string).includes(` ${member} `)) return true;
    cur = entry.i;
  }
  return false;
}

let verifyScheduled = false;

/**
 * Turn the main world's provisional references into real links.
 *
 * Additive by design: an unconfirmed reference simply loses its attribute and
 * goes back to being ordinary code text. Nothing that is already on screen
 * changes meaning, so there is no flicker of a link disappearing.
 */
function verifyPending(): void {
  verifyScheduled = false;
  const pending = document.querySelectorAll<HTMLAnchorElement>(
    `a[${ATTR}]:not([href])`,
  );
  if (!pending.length) return;

  void loadVerifyIndex().then((index) => {
    for (const a of pending) {
      const api = a.getAttribute(ATTR);
      // Another pass may have handled it while the index was loading.
      if (!api || a.hasAttribute("href")) continue;
      const dot = api.indexOf(".");
      if (dot === -1) continue;
      const owner = api.slice(0, dot);
      const member = api.slice(dot + 1);

      const confirmed =
        !!index &&
        (owner === "globals"
          ? memberExists(index, "globals", member)
          : memberExists(index, owner, member));

      if (!confirmed) {
        // Not an engine member — someone's own child instance or field.
        a.removeAttribute(ATTR);
        continue;
      }
      a.classList.add("dfp-doc-link");
      a.href = urlFor(api, owner, member);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = `${owner}.${member} — Creator Docs`;
    }
  });
}

function scheduleVerify(): void {
  if (verifyScheduled) return;
  verifyScheduled = true;

  /* Called as a method on `window`, never detached into a local first.
   *
   * `const idle = window.requestIdleCallback; idle(…)` loses the receiver, and
   * Firefox enforces the WebIDL `this` check that Chrome lets slide:
   *
   *   TypeError: 'requestIdleCallback' called on an object that does not
   *   implement interface Window.
   *
   * It threw during mount, which took out every isolated feature that mounts
   * after this one — the ⌘K palette, the composer helpers and the onboarding
   * card all went with it, and none of them touch idle callbacks. */
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(() => verifyPending(), { timeout: 500 });
  } else {
    setTimeout(verifyPending, 50);
  }
}

/**
 * One delegated listener on the document rather than one per token.
 *
 * A long thread can contain thousands of these; per-element listeners would be
 * both a memory cost and something to tear down on every Discourse page
 * transition.
 */
export function mountDocsCards(): void {
  scheduleVerify();

  /* Discourse streams posts in as you scroll and swaps the whole outlet on
   * navigation, so new references appear long after load. Watching for them is
   * cheaper than re-scanning on a timer. */
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (el.matches?.(`a[${ATTR}]`) || el.querySelector?.(`a[${ATTR}]`)) {
          scheduleVerify();
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  mountHoverCards();
}

function mountHoverCards(): void {
  document.addEventListener(
    "mouseover",
    (e) => {
      const el = (e.target as Element | null)?.closest?.(`[${ATTR}]`) as HTMLElement | null;
      if (!el) return;
      clearTimeout(closeTimer);
      if (openFor === el) return;
      clearTimeout(openTimer);
      openFor = el;
      openTimer = window.setTimeout(() => void open(el), OPEN_DELAY);
    },
    { passive: true },
  );

  document.addEventListener(
    "mouseout",
    (e) => {
      const el = (e.target as Element | null)?.closest?.(`[${ATTR}]`);
      if (!el) return;
      clearTimeout(openTimer);
      scheduleClose();
    },
    { passive: true },
  );

  // A card anchored with `fixed` would otherwise float away from its token.
  addEventListener("scroll", close, { passive: true, capture: true });
  addEventListener("resize", close, { passive: true });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}
