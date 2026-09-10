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
 *
 * ── Deprecation marks share the host ────────────────────────────────────────
 * code-intel marks a deprecated call as `span.dfp-dep` and summarises a block's
 * findings as `button.dfp-code-finding`; both carry `data-dfp-replacement` and
 * `data-dfp-why`, plus `data-dfp-api` when there is a docs page to point at.
 * Their message used to live only in a native `title`, which touch browsers
 * never show and which trails the pointer by about a second on desktop. They
 * open here, through the same host, rather than in a MAIN-world card of their
 * own: one shadow root, one placement routine, one set of listeners, and
 * nothing new crosses the bridge.
 *
 * The card does not title itself with the mark's text. A multi-token finding
 * reads `, workspace` — the parent argument of `Instance.new` — and that is a
 * lie as a heading. It leads with the replacement instead, which is what the
 * reader came for; the mark under the pointer already says what is deprecated.
 * When the mark's `data-dfp-api` resolves to a documented member, its
 * signature follows the head — `Instance.new(className: string, parent:
 * Instance): Instance` — so the card says what the call takes as well as what
 * to use instead, which is what the same token would show as a plain link.
 *
 * Both still arrive with the native `title` code-intel writes, and it is the
 * same message. On desktop this card opened at 220 ms and the browser's
 * tooltip opened on top of it a second later — the stacking asset-preview.ts
 * refuses `title` for. The attribute is dropped the first time a mark or chip
 * becomes the card's subject: the tooltip's text is read on the mousemove
 * after the mouseover that gets here, so it never shows. A mark with nothing
 * for the card to say keeps its `Deprecated.` tooltip; that was all it had.
 *
 * `data-dfp-why` may contain backticks. They become <code> elements built from
 * text nodes; the string is post-adjacent data and never reaches innerHTML.
 *
 * ── Focus, touch, and what the screen reader hears ─────────────────────────
 * The card opens on `focusin` as well as `mouseover`: confirmed docs links are
 * real <a href>, so they are tab stops, and a stop that shows nothing is a
 * silent one. It is announced through `aria-description` on the focused
 * element, not `aria-describedby` — an ID reference cannot cross the shadow
 * boundary, so a `describedby` pointing into this root resolves to nothing.
 *
 * Focus skips the dwell. The pointer waits 220 ms so a crossing does not open
 * a card per token, but a Tab stop has nothing to debounce, and the timing is
 * what the description depends on: a screen reader announces the element in
 * the focus task, and NVDA and JAWS do not re-read a description that changes
 * afterwards. Routed through the dwell, the user heard the bare link text and
 * never the signature. A deprecation card without a docs page is synchronous,
 * so its description lands inside the same task; an API card describes as
 * soon as its shard resolves.
 *
 * The focus ring only counts when it is visible. A click focuses an anchor or
 * a chip too, and a tab coming back to the front refocuses whatever had focus
 * when it left — the link whose Enter opened Creator Docs — and neither is a
 * reader asking for a card. The gate is `:focus-visible`, plus the window's
 * own `focus` event, which the focus update steps fire before the element's.
 *
 * On `(hover: none)` a tap on a mark opens the card at once and the next tap
 * outside closes it. Only marks: a tap on a docs link has to keep navigating,
 * and a long-press on any <a> collides with the browser's own link menu, so
 * links are left alone and there is no long-press anywhere. Chips are left
 * alone too — a chip's tap already has a job, scrolling its mark into view,
 * and that scroll reached the closer on the next frame: a chip without a docs
 * link flashed the card for one frame, and one with a link never showed it,
 * because close() had bumped the generation under the awaiting link lookup.
 * On a keyboard, chips still open the card through focusin.
 *
 * Motion: DFP's `data-dfp-motion="off"` lives on <html>, which polish.css
 * cannot reach into a shadow root. The value is mirrored onto the host as
 * `data-motion` and read with `:host([data-motion="off"])`. `:host-context()`
 * would be the one-liner, and Firefox does not implement it.
 * ───────────────────────────────────────────────────────────────────────────
 */

const ATTR = "data-dfp-api";

/**
 * The other kind of target: a Creator Docs page with no entry in the packaged
 * index — a guide, a tutorial, an art doc. MAIN marks these with a PATH rather
 * than an api string (see docs-links.ts), and the title comes from the page
 * itself via the service worker, because create.roblox.com sends no CORS
 * headers and the content script cannot read it.
 */
const PAGE_ATTR = "data-dfp-docs";

/**
 * A deprecation mark or a findings chip (see the header). code-intel writes
 * them; the attributes are the contract, the classes are how they are found.
 */
const DEP_SEL = ".dfp-dep, .dfp-code-finding";
/** The marks alone: what a tap may open (see the header on chips). */
const MARK_SEL = ".dfp-dep";
const REPLACEMENT_ATTR = "data-dfp-replacement";
const WHY_ATTR = "data-dfp-why";

/** What a mark or chip has for a card to say, or null when it has nothing. */
function depMessage(el: Element): { replacement: string; why: string } | null {
  const replacement = (el.getAttribute(REPLACEMENT_ATTR) ?? "").trim();
  const why = (el.getAttribute(WHY_ATTR) ?? "").trim();
  return replacement || why ? { replacement, why } : null;
}

/**
 * Take the native tooltip off a mark or chip this card is about to speak for;
 * see the header. Not a link: those never carried one here, and code-intel's
 * owner-level `title` is that module's to drop.
 */
export function dropTitle(el: HTMLElement): void {
  if (el.matches(DEP_SEL) && depMessage(el)) el.removeAttribute("title");
}

/** Everything a pointer or the focus ring can open a card for. */
const HOVER_SEL = `[${ATTR}], [${PAGE_ATTR}], ${DEP_SEL}`;

const targetOf = (t: EventTarget | null, sel: string): HTMLElement | null =>
  ((t as Element | null)?.closest?.(sel) as HTMLElement | null) ?? null;

/**
 * The hover target a `mouseout`/`focusout` actually left, or null when the
 * move stayed inside one.
 *
 * A multi-token mark is several elements: `Instance.new("ScreenGui", parent)`
 * puts `<span>,</span> Players<span>.</span>…` inside one `.dfp-dep`, and a
 * pointer crossing it fires a mouseout/mouseover pair at every child edge. The
 * first version treated each of those mouseouts as a leave: it cleared the
 * dwell timer, and the mouseover that followed found `openFor` already set and
 * did not start another, so the card never opened until the pointer went all
 * the way out and came back. The leftmost child of that mark is the
 * one-character `,` span, so this fired on most approaches. `relatedTarget` is
 * where the pointer (or focus) went; while that resolves to the same target,
 * nothing has been left.
 */
export function targetLeft(from: EventTarget | null, to: EventTarget | null): HTMLElement | null {
  const el = targetOf(from, HOVER_SEL);
  if (!el) return null;
  return targetOf(to, HOVER_SEL) === el ? null : el;
}

/** path → its metadata, or null once known unavailable. */
const pageMeta = new Map<string, { title: string; description: string } | null>();

async function loadPageMeta(path: string) {
  const hit = pageMeta.get(path);
  if (hit !== undefined) return hit;
  let meta: { title: string; description: string } | null = null;
  try {
    meta = (await chrome.runtime.sendMessage({ type: "dfp:docs-page", path })) ?? null;
  } catch {
    // Worker asleep mid-flight, or the extension was reloaded under us.
  }
  pageMeta.set(path, meta);
  return meta;
}

/**
 * Same shape as the API card, so the two read as one affordance. A fragment
 * rather than a wrapper, so each line lands as a direct child of the card and
 * `describe()` can read them one by one.
 */
function buildPageCard(meta: { title: string; description: string }, path: string): DocumentFragment {
  const wrap = document.createDocumentFragment();
  wrap.appendChild(el("div", "dfp-doc-page__title", meta.title));
  /* The section, from the path — "art / characters". It is the one thing the
   * page's own metadata does not say and the reader most wants: whether this is
   * a guide or a reference page. */
  const section = path
    .replace(/^\/(?:[a-z]{2}-[a-z]{2}\/)?docs\/?/, "")
    .split("/")
    .slice(0, -1)
    .join(" / ");
  if (section) wrap.appendChild(el("div", "dfp-doc-page__section", section));
  if (meta.description) wrap.appendChild(el("div", "dfp-doc-page__desc", meta.description));
  return wrap;
}
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
/** The element currently carrying the card's `aria-description`. */
let described: Element | null = null;
let openTimer = 0;
let closeTimer = 0;
/** Bumped on every hover so a slow shard cannot render over a newer one. */
let generation = 0;

/* Custom properties cross the shadow boundary — `all: initial` on the host
 * resets everything except them — so the card reads DFP's tokens directly. The
 * colour fallbacks are the dark theme's values from tokens.generated.css, for
 * the one state in which no colour token exists: the theme set to "off".
 *
 * Widths: 26rem is 416px, and a phone is 375. `place()` clamps the left edge
 * only, so without the viewport term the right edge simply left the screen. The
 * 16px matches its 8px margin on each side. */
const CARD_CSS = `
:host { all: initial; }
.card {
  position: fixed;
  z-index: 2147483000;
  max-width: min(26rem, calc(100vw - 16px));
  padding: 10px var(--dfp-s-3, 12px);
  border-radius: var(--dfp-r-md, 10px);
  border: 1px solid var(--dfp-border, #2b2e34);
  background: var(--dfp-surface-2, #1c1f25);
  color: var(--dfp-text, #eff4fc);
  box-shadow: var(--dfp-e-2, 0 2px 4px rgb(0 0 0 / 0.26), 0 8px 16px -4px rgb(0 0 0 / 0.34));
  font-family: var(--dfp-font, system-ui, sans-serif);
  font-size: var(--dfp-fs-sm, 13px);
  line-height: 1.5;
  opacity: 0;
  transform: translateY(-2px);
  transition:
    opacity var(--dfp-dur-1, 120ms) var(--dfp-ease, ease),
    transform var(--dfp-dur-1, 120ms) var(--dfp-ease, ease);
  pointer-events: auto;
}
.card[data-shown="1"] { opacity: 1; transform: none; }
.head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.name {
  font-family: var(--dfp-mono, ui-monospace, monospace);
  font-size: var(--dfp-fs-sm, 13px);
  font-weight: 600;
  color: var(--dfp-text, #eff4fc);
  word-break: break-word;
}
.owner { color: var(--dfp-text-3, #8e9299); font-weight: 400; }
/* "use task.wait": the verb in the UI face, muted, so the replacement is the
   only thing set in code. */
.name .use {
  font-family: var(--dfp-font, system-ui, sans-serif);
  font-weight: 400;
  color: var(--dfp-text-3, #8e9299);
}
/* Every literal px size in this sheet is multiplied by --dfp-font-scale, as
   the palette's and the onboarding card's are: the Text size control scaled
   the forum by up to 1.25 while the signature line and chips stayed at 11px.
   The var(--dfp-fs-*) sizes above already scale through the token. The
   custom property crosses the host's "all: initial" the same way the
   --dfp-surface-* colours do; 1 is for the harness and an unstamped page. */
.kind {
  font-size: calc(11px * var(--dfp-font-scale, 1));
  text-transform: lowercase;
  color: var(--dfp-text-3, #8e9299);
  border: 1px solid var(--dfp-border, #2b2e34);
  border-radius: 999px;
  padding: 0 6px;
}
.sig {
  margin-top: 6px;
  font-family: var(--dfp-mono, ui-monospace, monospace);
  font-size: var(--dfp-fs-xs, 12px);
  color: var(--dfp-text-2, #b4b8c0);
  word-break: break-word;
}
/* The code ramp, not the status palette: the block under the card paints
   \`Humanoid\` --dfp-code-type, and the same name in a second colour a few
   pixels away read as a different thing. --dfp-success was worse still — it is
   the solved tick everywhere else on the forum, so a return type read as a
   status. Both ramp colours are contrast-asserted against --dfp-surface-2 by
   build-tokens.ts, which is this card's background. */
.sig .p { color: var(--dfp-code-prop, #56eeff); }
.sig .t { color: var(--dfp-code-type, #25bfd5); }
.sum { margin-top: 7px; color: var(--dfp-text-2, #b4b8c0); }
.sum code {
  font-family: var(--dfp-mono, ui-monospace, monospace);
  font-size: 0.92em;
  color: var(--dfp-text, #eff4fc);
  background: var(--dfp-surface-3, #25282e);
  border-radius: 4px;
  padding: 0 4px;
}
.flags { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.flag {
  font-size: calc(11px * var(--dfp-font-scale, 1));
  border-radius: 999px;
  padding: 1px 7px;
  border: 1px solid transparent;
}
.flag.dep {
  color: var(--dfp-deprecated, #ffc4b5);
  border-color: color-mix(in oklab, var(--dfp-deprecated, #ffc4b5) 40%, transparent);
}
.flag.yield {
  color: var(--dfp-warning, #e19900);
  border-color: color-mix(in oklab, var(--dfp-warning, #e19900) 40%, transparent);
}
.flag.sec, .flag.ro {
  color: var(--dfp-text-3, #8e9299);
  border-color: var(--dfp-border, #2b2e34);
}
.foot {
  display: flex; justify-content: space-between; align-items: center;
  gap: 10px; margin-top: 9px; padding-top: 8px;
  border-top: 1px solid var(--dfp-border, #2b2e34);
}
.inh { color: var(--dfp-text-3, #8e9299); font-size: calc(11px * var(--dfp-font-scale, 1)); }
a.more {
  color: var(--dfp-accent, #37b3ff);
  text-decoration: none;
  font-size: calc(12px * var(--dfp-font-scale, 1));
  font-weight: 500;
  white-space: nowrap;
}
a.more:hover { text-decoration: underline; }

/* A docs page that is not an API reference. Same card, different body: there is
   no signature to show, so the title carries it and the section says what kind
   of page it is — which is the thing a reader most wants to know before
   clicking a /docs/ link that could be a guide, a tutorial or a reference. */
.dfp-doc-page__title {
  color: var(--dfp-text, #eff4fc);
  font-size: var(--dfp-fs-sm, 13px);
  font-weight: 600;
  line-height: 1.35;
}
.dfp-doc-page__section {
  margin-top: 3px;
  color: var(--dfp-text-3, #8e9299);
  font-size: calc(11px * var(--dfp-font-scale, 1));
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.dfp-doc-page__desc {
  margin-top: 7px;
  color: var(--dfp-text-2, #b4b8c0);
  line-height: 1.5;
  /* Roblox descriptions run long; four lines is enough to know what the page is
     without the card covering the sentence it came from. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
}
/* tokens.css already collapses --dfp-dur-1 to 1ms for both of these, and that
   value inherits into this root, so under a normal load these rules change
   nothing. They stay because this stylesheet has to be readable on its own: the
   setting is mirrored onto the host on every open (syncMotion), and nobody
   should need tokens.css open beside this to see it honoured. */
:host([data-motion="off"]) .card { transition: none; }
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
  card.setAttribute("role", "tooltip");
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

/**
 * The signature line, or null when it would say nothing: a property or
 * constant with no known type would render as its own name and nothing else,
 * directly under a title that already says it — an enum item like
 * `KeyCode.Space` is the common case.
 */
function signatureFor(name: string, m: Member): HTMLElement | null {
  const kind = m[0] ?? 0;
  const bare = (kind === 0 || kind === 6) && !(m[2] ?? []).length;
  return bare ? null : signature(name, m);
}

/* The flex rows (.head, .flags, .foot) get a space between their children. Flex
 * does not render whitespace-only text, so nothing changes on screen; what
 * changes is `textContent`, which `describe()` reads — without it the screen
 * reader gets "Healthproperty" and "deprecatedyields". */
function flagRow(flags: number): HTMLElement | null {
  const row = el("div", "flags");
  if (flags & F_DEPRECATED) row.append(el("span", "flag dep", "deprecated"), " ");
  if (flags & F_YIELDS) row.append(el("span", "flag yield", "yields"), " ");
  if (flags & F_SECURITY) row.append(el("span", "flag sec", "restricted"), " ");
  if (flags & F_READONLY) row.append(el("span", "flag ro", "read-only"), " ");
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
  if (kind) head.append(" ", el("span", "kind", kind));
  frag.append(head);

  if (r.member) {
    const sig = signatureFor(member!, r.member);
    if (sig) frag.append(sig);
    const sum = r.member[3];
    if (sum) frag.append(el("div", "sum", sum));
    const flags = flagRow((r.member[4] ?? 0) | (r.shard.f ?? 0));
    if (flags) frag.append(flags);
  } else {
    if (r.shard.s) frag.append(el("div", "sum", r.shard.s));
    const flags = flagRow(r.shard.f ?? 0);
    if (flags) frag.append(flags);
  }

  frag.append(footer(urlFor(api, owner, member), r.from ? `inherited from ${r.from}` : ""));
  return frag;
}

/** The card's last line: a note on the left, the docs link on the right. */
function footer(href: string, note: string): HTMLElement {
  const foot = el("div", "foot");
  foot.append(el("span", "inh", note), " ");
  const link = document.createElement("a");
  link.className = "more";
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Creator Docs ↗";
  foot.append(link);
  return foot;
}

// ── Deprecation cards ───────────────────────────────────────────────────────

/**
 * `data-dfp-why` with its backtick spans split out, so `wait()` inside a
 * sentence is set as code and the rest as prose. A lone or unmatched backtick
 * stays literal text, and so does an empty pair; nothing here is parsed as
 * markup, and the caller builds elements from these strings, never innerHTML.
 */
export function whyParts(why: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  // Captured groups land at the odd indices of a split.
  why.split(/`([^`]+)`/).forEach((text, i) => {
    if (text) out.push({ code: i % 2 === 1, text });
  });
  return out;
}

/**
 * `deprecated · use task.wait`, the signature when the mark names a documented
 * member, the reason, and the docs link when it names a page. Built from the
 * API card's classes so the two read as one affordance; see the header for
 * why the mark's own text is not the title.
 */
function buildDepCard(replacement: string, why: string, docs: DepDocs | null): DocumentFragment {
  const frag = document.createDocumentFragment();

  const head = el("div", "head");
  head.append(el("span", "flag dep", "deprecated"));
  // Defensive: a replacement written as `task.wait` would otherwise set the
  // backticks in bold monospace.
  const rep = replacement.replace(/^`|`$/g, "");
  if (rep) {
    const name = el("div", "name");
    name.append(el("span", "use", "use "), document.createTextNode(rep));
    head.append(" ", name);
  }
  frag.append(head);

  /* The full `Owner.Member` here, where the API card sets the member alone:
   * that card's head names the owner and this one's names the replacement, so
   * without it nothing on the card said whose call this is. */
  const sig = docs?.member ? signatureFor(docs.name, docs.member) : null;
  if (sig) frag.append(sig);

  const sum = el("div", "sum");
  for (const part of whyParts(why)) {
    sum.append(part.code ? el("code", undefined, part.text) : document.createTextNode(part.text));
  }
  if (sum.hasChildNodes()) frag.append(sum);

  if (docs) frag.append(footer(docs.href, ""));
  return frag;
}

/**
 * `Owner` or `Owner.Member` → its parts, or null when the owner is not in the
 * packaged index. This is the closed-set check from the header comment, and
 * it runs before anything becomes a path.
 */
function parseApi(api: string): { owner: string; member: string | null } | null {
  const dot = api.indexOf(".");
  const owner = dot === -1 ? api : api.slice(0, dot);
  const member = dot === -1 ? null : api.slice(dot + 1);
  if (owner !== "globals" && !docGroupOf(owner)) return null;
  if (member && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) return null;
  return { owner, member };
}

/** What a mark's `data-dfp-api` resolved to; the dep card's footer and signature. */
interface DepDocs {
  href: string;
  /** `Instance.new`, or `wait` for a global — the name the signature leads with. */
  name: string;
  member: Member | null;
}

/**
 * The docs URL a mark's `data-dfp-api` points at, once the shard has confirmed
 * the page exists, and the member's entry when the shard holds one. When the
 * owner is real but the member is not, the owner page is linked rather than a
 * fragment that would scroll nowhere, and there is no signature to show.
 */
async function docsFor(api: string): Promise<DepDocs | null> {
  const parsed = parseApi(api);
  if (!parsed) return null;
  const r = await resolve(parsed.owner, parsed.member);
  if (!r) return null;
  const member = r.member ? parsed.member : null;
  // `wait`, not `globals.wait`: the namespace is an index detail, as in build().
  const name = !member ? parsed.owner : parsed.owner === "globals" ? member : `${parsed.owner}.${member}`;
  return { href: urlFor(api, parsed.owner, member), name, member: r.member ?? null };
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

/** Put `content` in the card beside `target`, and tell the screen reader. */
function show(target: HTMLElement, content: Node): void {
  ensureHost();
  if (!card || !host) return;
  syncMotion(host);
  host.style.display = "";
  card.replaceChildren(content);
  place(target);
  card.dataset["shown"] = "1";
  describe(target);
}

/** Mirror <html data-dfp-motion> onto the host; see the header comment. */
function syncMotion(h: HTMLElement): void {
  const motion = document.documentElement.dataset["dfpMotion"];
  if (motion) h.dataset["motion"] = motion;
  else delete h.dataset["motion"];
}

/**
 * What the screen reader gets: each line of the card, in order, as one string
 * on the element that has focus. The footer contributes its note ("inherited
 * from BasePart") but not its link — that cannot be reached from there, and
 * "Creator Docs" read after every summary is noise.
 */
function describe(target: Element): void {
  undescribe();
  if (!card) return;
  const lines: string[] = [];
  for (const line of card.children) {
    const raw = line.classList.contains("foot")
      ? line.querySelector(".inh")?.textContent
      : line.textContent;
    const text = (raw ?? "").replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
  }
  if (!lines.length) return;
  target.setAttribute("aria-description", lines.join(". "));
  described = target;
}

function undescribe(): void {
  described?.removeAttribute("aria-description");
  described = null;
}

function close(): void {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  generation++;
  openFor = null;
  undescribe();
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
  // Marks first: a mark may also carry `data-dfp-api`, and there it is the
  // footer link, not the subject of the card.
  if (target.matches(DEP_SEL)) return openDep(target);

  const path = target.getAttribute(PAGE_ATTR);
  if (path) {
    const gen = ++generation;
    const meta = await loadPageMeta(path);
    // Nothing to say is the designed floor: the link still works.
    if (!meta || gen !== generation || openFor !== target) return;
    show(target, buildPageCard(meta, path));
    return;
  }

  const api = target.getAttribute(ATTR);
  if (!api) return;
  const parsed = parseApi(api);
  if (!parsed) return;
  const { owner, member } = parsed;

  const gen = ++generation;
  const r = await resolve(owner, member);
  // A newer hover started, or the pointer left, while the shard was loading.
  if (gen !== generation || openFor !== target || !r) return;
  show(target, build(api, owner === "globals" ? (member ?? owner) : owner, member, r));
}

/* Synchronous through show() when there is no `data-dfp-api`: the only await
 * is the shard lookup, and the focus path counts on that (see the header). */
async function openDep(target: HTMLElement): Promise<void> {
  const msg = depMessage(target);
  // A mark with nothing to say gets no card; the underline already speaks.
  if (!msg) return;

  const api = target.getAttribute(ATTR);
  const gen = ++generation;
  const docs = api ? await docsFor(api) : null;
  if (gen !== generation || openFor !== target) return;
  show(target, buildDepCard(msg.replacement, msg.why, docs));
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
      /* No `title`. The card opens at 220 ms; a native tooltip would open on
       * top of it a second later, repeating the link's own text. The text IS
       * the API name, and the card carries the rest. */
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
  /* Make `el` the card's subject. The pointer arms after a dwell, so a crossing
   * of a code block on its way somewhere else does not open and close a card
   * per token; focus and a tap open at once — neither has a crossing to
   * debounce, and for focus the timing is what the screen reader hears (see
   * the header). The same element again only cancels a pending close. */
  const begin = (el: HTMLElement, now: boolean): void => {
    dropTitle(el);
    clearTimeout(closeTimer);
    if (openFor === el) return;
    clearTimeout(openTimer);
    openFor = el;
    if (now) void open(el);
    else openTimer = window.setTimeout(() => void open(el), OPEN_DELAY);
  };
  const arm = (t: EventTarget | null): void => {
    const el = targetOf(t, HOVER_SEL);
    if (el) begin(el, false);
  };
  /* `to` is the event's relatedTarget: a move that stays inside the target is
   * not a leave (targetLeft). A leave before the card is up abandons the open
   * outright — `openFor` cleared, not just the timer — so a pointer that comes
   * back inside CLOSE_DELAY arms a fresh dwell instead of finding `openFor`
   * still set and its timer gone, which is the other way the card stayed shut.
   * An open() awaiting its shard sees `openFor` change and renders nothing. */
  const disarm = (t: EventTarget | null, to: EventTarget | null): void => {
    if (!targetLeft(t, to)) return;
    clearTimeout(openTimer);
    if (card?.dataset["shown"] !== "1") openFor = null;
    scheduleClose();
  };

  document.addEventListener("mouseover", (e) => arm(e.target), { passive: true });
  document.addEventListener("mouseout", (e) => disarm(e.target, e.relatedTarget), {
    passive: true,
  });

  /* The window's focus event precedes the restored element's focusin in the
   * same task, so a focusin within a few ms of it is the browser putting focus
   * back where it was, not a Tab. See the header. */
  let windowFocusedAt = -Infinity;
  addEventListener("focus", () => {
    windowFocusedAt = performance.now();
  });
  // focusin/focusout rather than focus/blur: only the former pair bubbles.
  document.addEventListener("focusin", (e) => {
    if (performance.now() - windowFocusedAt < 50) return;
    const t = e.target as Element | null;
    if (!t?.matches?.(":focus-visible")) return;
    const el = targetOf(t, HOVER_SEL);
    if (el) begin(el, true);
  });
  document.addEventListener("focusout", (e) => {
    const to = e.relatedTarget;
    const intoCard = !!host && to instanceof Node && host.contains(to);
    /* Focus leaving the card's own docs link is retargeted to the host, which
     * matches nothing in HOVER_SEL; dropped, it left the card — and the
     * aria-description on its anchor — up until some other closer fired. */
    if (e.target === host) {
      if (!intoCard) scheduleClose();
      return;
    }
    /* Focus moving INTO the card — a click on its docs link while the anchor
     * held focus — is retargeted to the host. Closing on it would take the
     * link away 140 ms into a click that is still being held. */
    if (intoCard) return;
    disarm(e.target, to);
  });

  /* Touch. `matches` is read per tap rather than once at mount: a convertible
   * gains and loses its pointer, and the query list tracks it. Marks only —
   * see the header for why links and chips keep their native behaviour. */
  const coarse = matchMedia("(hover: none)");
  document.addEventListener("click", (e) => {
    if (!coarse.matches) return;
    const el = targetOf(e.target, MARK_SEL);
    if (!el) return;
    // The same mark again is a toggle; there is no pointer to move away.
    if (openFor === el && card?.dataset["shown"] === "1") {
      close();
      return;
    }
    begin(el, true);
  });
  /* The tap outside that closes it. Capture, so it runs before whatever the
   * tap lands on; and not a `click`, because a tap that starts a scroll never
   * becomes one. Harmless for a mouse: by the time it clicks elsewhere the
   * pointer has already left. */
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!openFor) return;
      const t = e.target as Node | null;
      if (t && (openFor.contains(t) || host?.contains(t))) return;
      close();
    },
    { capture: true, passive: true },
  );

  // A card anchored with `fixed` would otherwise float away from its token.
  addEventListener("scroll", close, { passive: true, capture: true });
  addEventListener("resize", close, { passive: true });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}
