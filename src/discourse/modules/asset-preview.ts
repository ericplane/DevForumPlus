import type { DfpModule } from "../../core/registry";
import type { ModuleId } from "../../core/settings-schema";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";

/**
 * Roblox asset ids, made legible.
 *
 * Scripting Support is full of `rbxassetid://1234567` and bare
 * roblox.com/library links. Both are dead text today: you cannot tell a decal
 * from a sound from a mesh without opening a tab, and half the time the tab
 * turns out to be the wrong asset anyway.
 *
 * Two things are added, and only two:
 *   1. a real link, built from the digits and a fixed path;
 *   2. a thumbnail, on hover, from one `<img>`.
 *
 * ── Why an <img> and nothing else ───────────────────────────────────────────
 * wxt.config.ts declares exactly one origin and says why: "No <all_urls>, no
 * tabs, no cookies, no webRequest." So there is no fetch here, and there cannot
 * be one — the thumbnails JSON API would need a second host permission for a
 * feature that is meant to cost nothing. An image load is not an extension
 * request at all; it is the page loading an image, governed by the page's own
 * CSP, which is why the redirect endpoint is used instead of the JSON one.
 *
 * The consequence is that we never learn whether an id is real. That is fine,
 * because the failure mode is designed rather than caught: the card is mounted
 * only after `load` fires, so a 404, a CSP block or a moderated asset produces
 * no card at all. There is no state in which a broken-image glyph can appear in
 * somebody's post.
 *
 * ── Why hover, and not inline ───────────────────────────────────────────────
 * A post quoting eight sound ids would become a wall of eight images. This
 * codebase already refused that shape twice — the language label hides at rest
 * (code.css) and the findings bar groups instead of counting (code-intel's
 * addSummary). Same answer here: nothing is fetched, and nothing is shown, until
 * a pointer asks. At rest this module costs one attribute per link.
 *
 * ── Why `<pre>` is skipped ──────────────────────────────────────────────────
 * `Sound.SoundId = "rbxassetid://…"` inside a fenced block is deliberately left
 * alone, for two reasons that both point the same way:
 *
 *   - code-intel rebuilds `pre > code` from `textContent` via `replaceChildren`,
 *     so anything inserted there is either destroyed (if this module wins the
 *     race) or buried inside its token spans (if it loses). Both modules
 *     register on the same `decorateCookedElement` hook and their sweeps run off
 *     the same microtask/rAF/400ms/1500ms schedule, so which one arrives first
 *     is not defined anywhere. A link that appears or does not depending on
 *     scheduling is exactly the "sometimes wrong" affordance the house rules
 *     forbid.
 *   - a code block already has one underline with a meaning: `.dfp-dep`, the
 *     deprecation mark. Adding a second, differently-shaped underline inside the
 *     same block would make the one that matters harder to read.
 *
 * Inline `<code>` IS handled — code-intel only ever touches `pre > code`, so
 * there is no conflict and no second underline to collide with, and inline code
 * is where most prose-level ids actually sit.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** Claimed on the `.cooked` root, so a repeat sweep costs one attribute read. */
const SCANNED = "data-dfp-asset-scan";

/** Carries the id. Present on links we built AND on Discourse's own. */
const ASSET = "data-dfp-asset";

/**
 * Resolving a thumbnail takes two hops, and the one-hop alternative is dead.
 *
 * `www.roblox.com/asset-thumbnail/image?assetId=…` used to 302 straight to the
 * CDN, which would have meant a bare `<img src>` and no request of our own.
 * Measured on the live forum against assets that certainly exist — Dominus
 * Empyreus 21070012, the classic decal 1818 — it errors, as does the older
 * `Thumbs/Asset.ashx`. It is NOT the forum's CSP doing that: a
 * `securitypolicyviolation` listener caught nothing while
 * `roblox.com/favicon.ico` loaded from the same page. Roblox simply retired it.
 *
 * So it is the JSON API — and that costs no permission either, because this
 * module runs in the MAIN world. The request is page-origin, governed by CORS
 * and the page's own `connect-src`, not by the extension's. Verified: 200, and
 * the `tr.rbxcdn.com` URL it returns then loads. `host_permissions` stays the
 * single origin wxt.config.ts commits to at :46.
 *
 * `credentials: "omit"` so it can never carry forum cookies, and it fires only
 * on hover — Roblox learns which asset someone deliberately pointed at, never
 * what they scrolled past.
 */
const THUMB_API = (id: string) =>
  `https://thumbnails.roblox.com/v1/assets` +
  `?assetIds=${id}&size=420x420&format=Png&isCircular=false`;

/**
 * Marks the anchors that point at a PLACE rather than a catalog asset.
 *
 * Absent means "ordinary asset". Kept as a separate attribute rather than
 * encoded into the id so the id stays a plain run of digits everywhere.
 */
const KIND = "data-dfp-asset-kind";

/**
 * Games get a different card, because a game is not a square.
 *
 * A place rendered through the asset endpoint comes back as the game's icon —
 * a 512px square logo, which tells you almost nothing. What a reader on this
 * forum actually wants to know about a linked game is how big it is and who
 * made it, and both are one request away:
 *
 *   places/{id}/universe  →  universeId
 *   games/multiget/thumbnails  →  the 768×432 splash people recognise
 *   games?universeIds=         →  name, creator, playing, visits
 *
 * All three verified from page context: 200, CORS-clean, `credentials: "omit"`,
 * no extension privilege of any kind. The last two run in parallel, so a game
 * hover is two round trips rather than one — paid only when someone points at
 * a game link, never on page load.
 */
const UNIVERSE_API = (placeId: string) =>
  `https://apis.roblox.com/universes/v1/places/${placeId}/universe`;

const GAME_THUMB_API = (universeId: string) =>
  `https://thumbnails.roblox.com/v1/games/multiget/thumbnails` +
  `?universeIds=${universeId}&size=768x432&format=Png&countPerUniverse=1`;

const GAME_INFO_API = (universeId: string) =>
  `https://games.roblox.com/v1/games?universeIds=${universeId}`;

/**
 * Ids are 4-16 digits everywhere in this file.
 *
 * The floor is not cosmetic. `rbxassetid://0` and `rbxassetid://1` are what
 * people type when they mean "put your id here", and linking those would ship a
 * confident link to nothing. Below four digits, leave it as text.
 */
const ID = String.raw`\d{4,16}`;

/** The same rule, anchored, for reading an id back out of the DOM. */
const ID_ONLY = new RegExp(`^${ID}$`);

/** A cooked anchor Discourse already built. Kind is ignored — the href stays. */
const HREF_RE = new RegExp(
  String.raw`^https?://(?:www\.|web\.|m\.)?roblox\.com/(?:library|catalog|asset|games)/(${ID})(?:[/?#]|$)`,
  "i",
);

/** The current Creator Store spelling of the same thing. */
const STORE_RE = new RegExp(
  String.raw`^https?://create\.roblox\.com/(?:store|marketplace)/asset/(${ID})(?:[/?#]|$)`,
  "i",
);

/**
 * A reference sitting in raw text.
 *
 * The URL arm swallows its own protocol, subdomain and trailing slug so the
 * match is the whole URL. Matching only the `roblox.com/library/…` core left
 * `https://www.` in front of the link and `/Cool-Model` behind it as loose text,
 * which reads as a link that has been cut in half.
 *
 * `\b` before `roblox` so `notroblox.com/library/1234567` does not match:
 * everything before it there is a word character, so there is no boundary.
 */
const TEXT_RE = new RegExp(
  String.raw`rbxassetid://(${ID})` +
    "|" +
    String.raw`(?:https?://)?(?:www\.|web\.|m\.)?\broblox\.com/(library|catalog|asset|games)/(${ID})(?:/[\w%-]*)?`,
  "g",
);

function assetIdFromHref(href: string): string | null {
  return HREF_RE.exec(href)?.[1] ?? STORE_RE.exec(href)?.[1] ?? null;
}

/** `/games/<id>` is a place; everything else this file matches is an asset. */
const isGameHref = (href: string) => /roblox\.com\/games\/\d/i.test(href);

// ── Marking references ──────────────────────────────────────────────────────

/**
 * Links Discourse already cooked.
 *
 * Nothing is rewritten here — no href, no text, no class. The anchor gains one
 * attribute and keeps looking exactly like the link the author wrote, which is
 * the cheapest possible way to cover the `roblox.com/library/…` and
 * `roblox.com/games/…` cases the feature exists for.
 */
function markAnchors(root: HTMLElement): number {
  let found = 0;
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (a.hasAttribute(ASSET)) continue;
    /* `aside.onebox` is already a rich preview with its own image and title —
     * hanging a second, smaller preview off it is the redundancy this feature is
     * meant to remove. `aside.quote` is deliberately NOT excluded: a quoted
     * asset id is still an asset id. */
    if (a.closest("pre, aside.onebox")) continue;
    const id = assetIdFromHref(a.href);
    if (!id) continue;
    a.setAttribute(ASSET, id);
    if (isGameHref(a.href)) a.setAttribute(KIND, "game");
    found++;
  }
  return found;
}

/**
 * Replace one text node with text-plus-anchors.
 *
 * Text nodes and elements only. `.cooked` is untrusted post content and this
 * file will never contain an `innerHTML`; the href is assembled from a validated
 * run of digits and a fixed path, so nothing the author typed reaches a URL.
 */
function split(node: Text): number {
  const src = node.data;
  TEXT_RE.lastIndex = 0;

  const frag = document.createDocumentFragment();
  let last = 0;
  let found = 0;

  for (let m = TEXT_RE.exec(src); m; m = TEXT_RE.exec(src)) {
    const id = m[1] ?? m[3];
    if (!id) continue;
    // `games/123` is a place; everything else resolves through /library, which
    // Roblox still redirects to whatever the asset's page is called this year.
    const path = m[2]?.toLowerCase() === "games" ? "games" : "library";
    if (m.index > last) frag.appendChild(document.createTextNode(src.slice(last, m.index)));
    frag.appendChild(buildLink(id, path, m[0]));
    last = m.index + m[0].length;
    found++;
  }

  if (found === 0) return 0;
  if (last < src.length) frag.appendChild(document.createTextNode(src.slice(last)));
  node.replaceWith(frag);
  return found;
}

function buildLink(id: string, path: string, label: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "dfp-asset";
  // The author's own spelling, unchanged. A link that silently rewrites the text
  // it replaced is a link you cannot quote.
  a.textContent = label;
  a.href = `https://www.roblox.com/${path}/${id}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.setAttribute(ASSET, id);
  if (path === "games") a.setAttribute(KIND, "game");
  /* No `title`. The link text already names the id, and a native tooltip would
   * open on top of the thumbnail card a moment after it appears. */
  return a;
}

/**
 * Walk text nodes, skipping the subtrees that must not be touched.
 *
 * The two `includes` are the gate. Most posts on this forum contain neither
 * string, and one native `textContent` read is far cheaper than a tree walk
 * that finds nothing — which matters because this runs on every post of every
 * topic.
 */
function linkifyText(root: HTMLElement): number {
  const all = root.textContent ?? "";
  if (!all.includes("rbxassetid://") && !all.includes("roblox.com/")) return 0;

  const targets: Text[] = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node): number {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          const tag = el.tagName;
          /* REJECT prunes the whole subtree, which is the point:
           *   A    — never nest an anchor inside an anchor;
           *   PRE  — see the header note on code-intel;
           *   onebox — already a preview of the thing being linked. */
          const skip =
            tag === "A" ||
            tag === "PRE" ||
            (tag === "ASIDE" && el.classList.contains("onebox"));
          return skip ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        const data = (node as Text).data;
        return data.includes("rbxassetid://") || data.includes("roblox.com/")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );

  // Collected first, then split. Replacing a node while the walker is still
  // standing on it moves the walker out of the tree it is iterating.
  while (walker.nextNode()) targets.push(walker.currentNode as Text);

  let found = 0;
  for (const node of targets) found += split(node);
  return found;
}

// ── The hover preview ───────────────────────────────────────────────────────

/** Matches docs-card, so the two hover affordances feel like one product. */
const OPEN_DELAY = 220;

/**
 * cache key → the card's contents, or `null` once loading has failed.
 *
 * Keyed `"<id>"` for an asset and `"game:<id>"` for a place, because the same
 * number means different things down the two paths and they build different
 * cards. The value is an element rather than an `<img>` for the same reason: a
 * game card is a splash plus a name plus its stats.
 *
 * `null` is the important half: a moderated or deleted asset would otherwise
 * re-request on every hover for the life of the page, and each one would end in
 * the same nothing.
 *
 * Capped because these hold a decoded bitmap for as long as the element is
 * alive, and a 9,000-post topic is a long time to hold thirty of them. Map
 * iterates in insertion order, so the oldest goes first.
 */
const shots = new Map<string, HTMLElement | null>();
/* 12, not 32. The API's next size up from the 150px box this is drawn in is
 * 420, and a decoded 420×420 is ~700 kB — so the cap is what keeps a long
 * hover-happy session from holding tens of megabytes of bitmaps. */
const SHOT_CAP = 12;

let card: HTMLElement | null = null;
let openTimer = 0;
/** What the pointer/focus is on right now. */
let hovered: HTMLElement | null = null;
/** The id whose load we are waiting for, so a stale `load` cannot open a card. */
let pending: string | null = null;
/** The anchor the card currently belongs to. */
let shownFor: HTMLElement | null = null;

function thumbnail(id: string): HTMLElement | null {
  const hit = shots.get(id);
  if (hit !== undefined) return hit;

  const img = document.createElement("img");
  /* Empty alt, deliberately: if this element ever did reach the page while
   * broken, an alt string is exactly what would render as a caption next to a
   * broken-image glyph. The link beside it carries the meaning. */
  img.alt = "";
  img.decoding = "async";
  /* The CDN never needs to know which thread someone is reading. */
  img.referrerPolicy = "no-referrer";

  img.addEventListener(
    "error",
    () => {
      // Remember the failure and take the affordance away. From here the
      // reference is just a link, which is the designed floor.
      shots.set(id, null);
      if (pending === id) hide();
    },
    { once: true },
  );
  img.addEventListener(
    "load",
    () => {
      if (pending === id && hovered) show(hovered, img);
    },
    { once: true },
  );

  /* Two hops, so the failure paths converge on the one the `error` handler
   * already implements: any non-200, any malformed body, and any state other
   * than "Completed" all end as `shots.set(id, null)` and no card.
   *
   * The state check is not belt-and-braces. Roblox answers 200 with a grey
   * "thumbnail pending" placeholder for assets it has not rendered yet, and
   * that image loads perfectly well — so without this, a hover would show a
   * confident grey square that is not a picture of the asset. */
  void fetch(THUMB_API(id), { credentials: "omit" })
    .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
    .then((body) => {
      const entry = (body as { data?: { imageUrl?: unknown; state?: unknown }[] } | null)?.data?.[0];
      if (entry?.state !== "Completed" || typeof entry.imageUrl !== "string") {
        throw new Error("no thumbnail");
      }
      img.src = entry.imageUrl;
    })
    .catch(() => {
      shots.set(id, null);
      if (pending === id) hide();
    });

  remember(id, img);
  return img;
}

function remember(key: string, node: HTMLElement): void {
  if (shots.size >= SHOT_CAP) {
    const oldest = shots.keys().next();
    if (!oldest.done) shots.delete(oldest.value);
  }
  shots.set(key, node);
}

/** "14.4M", "279K", "55" — a visit count is context, not an accounting figure. */
function compact(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

interface GameInfo {
  name?: unknown;
  playing?: unknown;
  visits?: unknown;
  creator?: { name?: unknown };
}

/**
 * A game card: the wide splash, the name, who made it, and how busy it is.
 *
 * Built as elements and text nodes like everything else here. The name comes
 * from Roblox rather than from the link text on purpose — the slug in a URL is
 * frequently stale or absent, and the whole point of the card is to answer
 * "what is this" without leaving the thread.
 *
 * Failure is the same designed floor as an asset: the card is only ever mounted
 * once its image has loaded, so a dead place id, a moderated game or a network
 * error all end as a plain working link and nothing else.
 */
function gameCard(placeId: string): HTMLElement | null {
  const key = `game:${placeId}`;
  const hit = shots.get(key);
  if (hit !== undefined) return hit;

  const wrap = document.createElement("div");
  wrap.className = "dfp-asset-preview__game";

  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.addEventListener(
    "error",
    () => {
      shots.set(key, null);
      if (pending === key) hide();
    },
    { once: true },
  );
  img.addEventListener(
    "load",
    () => {
      if (pending === key && hovered) show(hovered, wrap);
    },
    { once: true },
  );
  wrap.appendChild(img);

  const fail = () => {
    shots.set(key, null);
    if (pending === key) hide();
  };

  void fetch(UNIVERSE_API(placeId), { credentials: "omit" })
    .then((r) => (r.ok ? (r.json() as Promise<{ universeId?: unknown }>) : null))
    .then((body) => {
      const universe = body?.universeId;
      if (typeof universe !== "number") throw new Error("no universe");
      /* Both hang off the universe id, so they go out together — a game hover
       * costs two round trips, not three. */
      return Promise.all([
        fetch(GAME_THUMB_API(String(universe)), { credentials: "omit" }).then((r) =>
          r.ok ? (r.json() as Promise<unknown>) : null,
        ),
        fetch(GAME_INFO_API(String(universe)), { credentials: "omit" })
          .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
          // Details are a bonus; the splash alone is still worth showing.
          .catch(() => null),
      ]);
    })
    .then(([thumbBody, infoBody]) => {
      const shot = (
        thumbBody as { data?: { thumbnails?: { imageUrl?: unknown; state?: unknown }[] }[] } | null
      )?.data?.[0]?.thumbnails?.[0];
      if (shot?.state !== "Completed" || typeof shot.imageUrl !== "string") {
        throw new Error("no thumbnail");
      }

      const info = (infoBody as { data?: GameInfo[] } | null)?.data?.[0];
      if (info && typeof info.name === "string") {
        const title = document.createElement("div");
        title.className = "dfp-asset-preview__title";
        title.textContent = info.name;
        wrap.appendChild(title);

        /* Creator and counts on separate lines, and the order matters.
         *
         * One line held all three and the numbers were what fell off the end:
         * "by Eurotunnel | Le Shuttle · 337 playing · 45…". Studio names are
         * long, frequently decorative, and are the least useful third of the
         * card — so they are the part allowed to truncate. The counts get their
         * own line, where the longest case anyone will hit
         * ("1.2M playing · 999B visits") still fits 260px with room to spare. */
        if (typeof info.creator?.name === "string") {
          const by = document.createElement("div");
          by.className = "dfp-asset-preview__by";
          by.textContent = `by ${info.creator.name}`;
          wrap.appendChild(by);
        }

        const stats: string[] = [];
        if (typeof info.playing === "number") stats.push(`${compact(info.playing)} playing`);
        if (typeof info.visits === "number") stats.push(`${compact(info.visits)} visits`);
        if (stats.length) {
          const meta = document.createElement("div");
          meta.className = "dfp-asset-preview__meta";
          meta.textContent = stats.join(" · ");
          wrap.appendChild(meta);
        }
      }

      // Last, so `load` cannot fire before the text it sits above exists.
      img.src = shot.imageUrl;
    })
    .catch(fail);

  remember(key, wrap);
  return wrap;
}

function ensureCard(): HTMLElement {
  if (card) return card;
  const el = document.createElement("div");
  el.className = "dfp-asset-preview";
  /* The card repeats what the link already says, so it is decoration to a
   * screen reader. It is also `pointer-events: none` in CSS, which is what
   * removes the whole class of bugs where a tooltip eats the click meant for
   * the thing it is describing. */
  el.setAttribute("aria-hidden", "true");
  card = el;
  return el;
}

/**
 * Fixed to the viewport and parented to `<body>`, never to the post.
 *
 * Inside `.cooked` it would be clipped by the `overflow-x: auto` on code blocks
 * and by any ancestor Discourse gives a transform — a transformed ancestor also
 * silently re-anchors `position: fixed` to itself. At body level there is no
 * such ancestor to worry about.
 *
 * No z-index, because there is not one in the whole stylesheet and this does not
 * need to be the first. The card opens downward from a link in the post column,
 * where nothing is stacked; the only element it could lose to is the fixed site
 * header, and the placement below only flips upward near the bottom of the
 * viewport, which is nowhere near it.
 */
function place(anchor: HTMLElement): void {
  if (!card) return;
  const t = anchor.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const margin = 8;

  let left = t.left;
  if (left + c.width > innerWidth - margin) left = innerWidth - c.width - margin;
  if (left < margin) left = margin;

  let top = t.bottom + 6;
  if (top + c.height > innerHeight - margin) {
    const above = t.top - c.height - 6;
    // Only flip up if there is genuinely room, rather than trading one clipped
    // edge for another.
    top = above > margin ? above : Math.max(margin, innerHeight - c.height - margin);
  }

  /* `translate`, with the resting position in CSS. Geometry is the one thing a
   * stylesheet cannot know, so it is the one thing set from here — everything
   * else about this card is a class. */
  card.style.translate = `${Math.round(left)}px ${Math.round(top)}px`;
}

function show(anchor: HTMLElement, content: HTMLElement): void {
  // Ember can re-render the stream between the hover and the load resolving.
  if (!anchor.isConnected || !document.body) return;
  const el = ensureCard();
  el.classList.toggle("dfp-asset-preview--game", content.classList.contains("dfp-asset-preview__game"));
  if (el.firstChild !== content) el.replaceChildren(content);

  /* Appended, measured and positioned in one synchronous run. The card sits at
   * the viewport origin for the two statements in between, but no paint can
   * happen inside a task, so there is no flash to hide and no need for the
   * visibility dance the docs card does. */
  document.body.appendChild(el);
  place(anchor);
  shownFor = anchor;
}

function hide(): void {
  clearTimeout(openTimer);
  pending = null;
  if (!shownFor) return;
  shownFor = null;
  // Removed rather than hidden, so a card can never survive a page transition
  // as a stale rectangle over unrelated content.
  card?.remove();
}

function open(anchor: HTMLElement): void {
  const id = anchor.getAttribute(ASSET);
  /* Re-validated even though DFP wrote it. This is read back out of post
   * content, and a post could contain the same attribute — Discourse's
   * sanitiser is not something to bet a URL on. Digits only, same rule as
   * everywhere above. */
  if (!id || !ID_ONLY.test(id)) return;

  const isGame = anchor.getAttribute(KIND) === "game";
  pending = isGame ? `game:${id}` : id;
  const content = isGame ? gameCard(id) : thumbnail(id);
  // Known bad. The reference stays a link and nothing else happens, ever again.
  if (!content) return;
  const img = content instanceof HTMLImageElement ? content : content.querySelector("img");
  if (img?.complete && img.naturalWidth > 0) show(anchor, content);
  // Otherwise the `load` listener finishes the job — if the pointer is still
  // here by then.
}

function target(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>(`[${ASSET}]`) : null;
}

/**
 * One delegated pair of listeners, mounted the first time a reference is found.
 *
 * `pointerover` answers both directions on its own: entering the link makes
 * `closest` return it, and leaving makes the next event's `closest` return null.
 * A long thread can hold hundreds of these, and per-link listeners would be both
 * a memory cost and something to unbind on every Discourse route change.
 */
let mounted = false;

function mountHover(): void {
  if (mounted) return;
  mounted = true;

  const enter = (node: EventTarget | null): void => {
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

  /* The pointer can leave through the top of the window without ever crossing
   * another element, and a scroll moves the post out from under a card that is
   * fixed to the viewport. Both leave a card pointing at nothing. */
  document.documentElement.addEventListener("pointerleave", () => {
    hovered = null;
    hide();
  });
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

// ── Module ──────────────────────────────────────────────────────────────────

function enhance(root: HTMLElement): void {
  if (root.hasAttribute(SCANNED)) return;
  /* Claimed before any work. `decorateCooked` visits each element up to four
   * times and the text pass is destructive — without this, a post's ids would be
   * re-walked on every sweep, and a second pass over already-split text would
   * find nothing but would still pay for the walk. */
  root.setAttribute(SCANNED, "1");

  const found = markAnchors(root) + linkifyText(root);
  // Nothing on the page to hover yet means no reason to listen to the document.
  if (found > 0) mountHover();
}

export function assetPreview(api: PluginApi): DfpModule {
  return {
    id: "asset-preview",
    /* Registration and four queued sweeps, so this reads about 0ms whatever the
     * page contains — the same placeholder code-intel's budget note describes.
     * Every per-post cost above is paid in passes nothing measures. */
    budgetMs: 100,

    install() {
      /* decorateCooked, not decorateCookedElement: the raw hook misses every
       * post that rendered before DFP installed, which on a hard refresh is the
       * whole first screen. See discourse/decorate.ts. */
      decorateCooked(api, (element) => enhance(element), {
        id: "dfp-asset-preview",
        onlyStream: true,
      });
    },
  };
}
