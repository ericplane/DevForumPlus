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
 *   2. a card, on hover, that says what the id is.
 *
 * ── What the card says ──────────────────────────────────────────────────────
 * It began as the bare thumbnail and stayed that way for a while, which never
 * answered the question above: for audio — the commonest id kind in Scripting
 * Support — the thumbnail is Roblox's generic waveform icon, and for a model
 * or a plugin it is a render with no name. So the picture now carries the
 * asset's name and a kind chip ("Audio", "MeshPart", "Plugin") from the
 * economy details endpoint, requested in parallel with the thumbnail. The
 * details are a bonus, exactly as the game card treats its info request: the
 * card is still mounted only once the image has loaded, and if the details
 * fail the picture stands alone as it always did.
 *
 * Two more link kinds get cards, because they are what the rest of the forum
 * pastes: a group ("community", in the current spelling) and a user profile.
 * Those follow the game card's shape — page-origin, credentials omitted, two
 * requests fired only on hover, mounted only after the icon or headshot has
 * loaded. For these the details are NOT optional: an icon with no name does
 * not say which group it is, so both requests must answer or there is no card.
 *
 * The 4-digit id floor below does NOT apply to groups and users. It did for
 * one revision, on the argument that one validation rule for every attribute
 * read back out of the DOM was worth more than a card for builderman — and
 * that argument was wrong on both halves. The floor exists so that
 * `rbxassetid://1` in prose is left as text (see `ID`), and an anchor whose
 * path segment already says `users/` has no such ambiguity; and the read-back
 * validates the kind attribute on its own, so the id rule never had to carry
 * it. The accounts that sit below 1000 — Roblox (1), builderman (156),
 * Shedletsky (261) — and the first few hundred groups are exactly the staff
 * and legacy pages DevForum posts do link, so `ENTITY_ID` starts at one digit.
 *
 * ── What the requests are, and why they cost no permission ──────────────────
 * wxt.config.ts declares exactly one origin and says why: "No <all_urls>, no
 * tabs, no cookies, no webRequest." Every request in this file honours that
 * without a second host permission because of where it runs: the MAIN world
 * is page context, so a fetch to thumbnails, economy, groups, users or apis
 * .roblox.com is the page asking, governed by CORS and the forum's own
 * `connect-src`, not by anything in the manifest. All five were verified from
 * page context — 200, CORS-clean — with `credentials: "omit"`, so none can
 * ever carry a forum cookie, and every one fires only on hover: Roblox learns
 * which id someone deliberately pointed at, never what they scrolled past.
 *
 * The load-bearing design is still the image. Whatever the JSON says, the
 * card is mounted only after the picture's `load` fires, so a 404, a CSP
 * block, a moderated asset or a "thumbnail pending" placeholder produces no
 * card at all. There is no state in which a broken-image glyph can appear in
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
 * Name, kind and creator of an asset. Verified from page context with
 * `credentials: "omit"`: 200 JSON with `Name`, `AssetTypeId` and
 * `Creator.Name`. The toolbox-service endpoint the audit proposed first
 * answers 404 from here, and `develop.roblox.com` wants a session (401), so
 * this is the one that works without asking for anything.
 */
const ASSET_INFO_API = (id: string) => `https://economy.roblox.com/v2/assets/${id}/details`;

/**
 * Marks what kind of thing the id names: `game`, `group` or `user`.
 *
 * Absent means "ordinary asset". Kept as a separate attribute rather than
 * encoded into the id so the id stays a plain run of digits everywhere.
 */
const KIND = "data-dfp-asset-kind";

/** What a marked link points at. `asset` is the unmarked default. */
export type Kind = "asset" | "game" | "group" | "user";

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
 * Groups and people: one details request and one picture request each, both
 * verified from page context with `credentials: "omit"` — 200 JSON, CORS-clean,
 * no extension privilege. 150px is the size the card draws them at; the
 * thumbnail endpoints answer the same `data[0].imageUrl` / `state` shape as
 * the asset one, so `firstShot` reads all three.
 */
const GROUP_API = (id: string) => `https://groups.roblox.com/v1/groups/${id}`;

const GROUP_ICON_API = (id: string) =>
  `https://thumbnails.roblox.com/v1/groups/icons?groupIds=${id}&size=150x150&format=Png`;

const USER_API = (id: string) => `https://users.roblox.com/v1/users/${id}`;

const USER_HEADSHOT_API = (id: string) =>
  `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png`;

/**
 * An asset or place id is 4-16 digits.
 *
 * The floor is not cosmetic. `rbxassetid://0` and `rbxassetid://1` are what
 * people type when they mean "put your id here", and linking those would ship a
 * confident link to nothing. Below four digits, leave it as text.
 */
const ID = String.raw`\d{4,16}`;

/**
 * A group or user id is 1-16 digits. The floor above guards prose, where a
 * short number is more often a placeholder than an id; a `users/156` path
 * segment has already said what its digits are, and 156 is builderman.
 */
const ENTITY_ID = String.raw`\d{1,16}`;

/**
 * Digits only, anchored, for reading an id back out of the DOM — one rule for
 * every kind, at the wider floor. The kind attribute is validated separately
 * in `referenceOf`, so a short id here is at worst a request for asset 1,
 * which exists.
 */
const ID_ONLY = new RegExp(`^${ENTITY_ID}$`);

/**
 * A cooked anchor Discourse already built. The href stays; the path segment
 * decides the card. `communities` is the current spelling of `groups` and the
 * two ids are the same namespace, so they share a kind. Two arms because the
 * two families take different floors; `referenceFromHref` reads whichever
 * matched.
 */
const HREF_RE = new RegExp(
  String.raw`^https?://(?:www\.|web\.|m\.)?roblox\.com/` +
    String.raw`(?:(library|catalog|asset|games)/(${ID})|(groups|communities|users)/(${ENTITY_ID}))` +
    String.raw`(?:[/?#]|$)`,
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

export interface Reference {
  id: string;
  kind: Kind;
}

function kindOfSegment(segment: string): Kind {
  switch (segment.toLowerCase()) {
    case "games":
      return "game";
    case "groups":
    case "communities":
      return "group";
    case "users":
      return "user";
    default:
      return "asset";
  }
}

/**
 * What a Roblox href points at, or null when it is not something this file
 * cards. entity-cards.test.ts holds it to the shapes people actually paste.
 * `TEXT_RE` deliberately does not grow to match: Discourse autolinks every
 * pasted URL, so a group or profile link is always an anchor by the time a
 * decorator sees it.
 */
export function referenceFromHref(href: string): Reference | null {
  const m = HREF_RE.exec(href);
  if (m) {
    const segment = m[1] ?? m[3];
    const id = m[2] ?? m[4];
    if (segment && id) return { id, kind: kindOfSegment(segment) };
  }
  const s = STORE_RE.exec(href);
  return s?.[1] ? { id: s[1], kind: "asset" } : null;
}

/**
 * `AssetTypeId` → the word a reader would use. The ids are Roblox's
 * `Enum.AssetType` values; the labels collapse families the card has no room
 * to distinguish — every body-part accessory is "Accessory", every emote and
 * walk cycle is "Animation" — because the chip's job is to tell a sound from a
 * mesh, not to reproduce the catalog taxonomy. Unknown ids get no chip rather
 * than a guess.
 */
const ASSET_TYPES: Record<number, string> = {
  1: "Image",
  2: "Clothing",
  3: "Audio",
  4: "Mesh",
  5: "Script",
  8: "Accessory",
  9: "Place",
  10: "Model",
  11: "Clothing",
  12: "Clothing",
  13: "Decal",
  17: "Head",
  18: "Face",
  19: "Gear",
  21: "Badge",
  24: "Animation",
  27: "Body part",
  28: "Body part",
  29: "Body part",
  30: "Body part",
  31: "Body part",
  32: "Package",
  34: "Game pass",
  38: "Plugin",
  39: "Union",
  40: "MeshPart",
  41: "Accessory",
  42: "Accessory",
  43: "Accessory",
  44: "Accessory",
  45: "Accessory",
  46: "Accessory",
  47: "Accessory",
  48: "Animation",
  49: "Animation",
  50: "Animation",
  51: "Animation",
  52: "Animation",
  53: "Animation",
  54: "Animation",
  55: "Animation",
  56: "Animation",
  57: "Accessory",
  58: "Accessory",
  59: "Animation",
  61: "Video",
  62: "Accessory",
  63: "Accessory",
  64: "Accessory",
  65: "Accessory",
  66: "Accessory",
  67: "Accessory",
  68: "Accessory",
  69: "Accessory",
  70: "Accessory",
  71: "Font",
  72: "Font",
  74: "Accessory",
  75: "Accessory",
  76: "Animation",
  77: "Dynamic head",
  79: "Video",
  80: "Font",
};

export function assetTypeLabel(typeId: unknown): string | null {
  return typeof typeId === "number" ? (ASSET_TYPES[typeId] ?? null) : null;
}

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
    const ref = referenceFromHref(a.href);
    if (!ref) continue;
    a.setAttribute(ASSET, ref.id);
    if (ref.kind !== "asset") a.setAttribute(KIND, ref.kind);
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
 * Keyed `"<id>"` for an asset and `"<kind>:<id>"` for a place, a group or a
 * user, because the same number means different things down the four paths
 * and they build different cards. The value is the card's content — the
 * picture and the lines under or beside it — never a bare `<img>`.
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

/**
 * The image every card is gated on, wired to the cache key it belongs to.
 *
 * `error` remembers the failure and takes the affordance away — from there the
 * reference is just a link, which is the designed floor. `load` mounts the
 * card, but only if the pointer is still on a link asking for this key: a
 * stale load must never open a card for something the reader has left.
 */
function picture(key: string, content: HTMLElement): HTMLImageElement {
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
      shots.set(key, null);
      if (pending === key) hide();
    },
    { once: true },
  );
  img.addEventListener(
    "load",
    () => {
      if (pending === key && hovered) show(hovered, content);
    },
    { once: true },
  );
  return img;
}

/** One page-origin JSON request, cookies never attached; a non-200 is null. */
function json(url: string): Promise<unknown> {
  return fetch(url, { credentials: "omit" }).then((r) =>
    r.ok ? (r.json() as Promise<unknown>) : null,
  );
}

/**
 * The CDN URL out of a thumbnails.roblox.com body, or null.
 *
 * The state check is not belt-and-braces. Roblox answers 200 with a grey
 * "thumbnail pending" placeholder for assets it has not rendered yet, and that
 * image loads perfectly well — so without this, a hover would show a
 * confident grey square that is not a picture of the asset.
 */
function firstShot(body: unknown): string | null {
  const entry = (body as { data?: { imageUrl?: unknown; state?: unknown }[] } | null)?.data?.[0];
  return entry?.state === "Completed" && typeof entry.imageUrl === "string" ? entry.imageUrl : null;
}

function line(className: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

interface AssetInfo {
  Name?: unknown;
  AssetTypeId?: unknown;
  Creator?: { Name?: unknown } | null;
}

/**
 * An asset card: the thumbnail, its name, and a chip saying what kind of
 * thing it is.
 *
 * Both requests go out together. The details ride the same rule the game
 * card's info request does — a bonus, never a condition — so their failure
 * path is `.catch(() => null)` and the picture stands alone. The thumbnail
 * keeps the two-hop failure convergence it always had: any non-200, any
 * malformed body and any state other than "Completed" all end as
 * `shots.set(id, null)` and no card.
 */
function assetCard(id: string): HTMLElement | null {
  const hit = shots.get(id);
  if (hit !== undefined) return hit;

  const wrap = document.createElement("div");
  wrap.className = "dfp-asset-preview__asset";
  const img = picture(id, wrap);
  wrap.appendChild(img);

  void Promise.all([json(THUMB_API(id)), json(ASSET_INFO_API(id)).catch(() => null)])
    .then(([thumbBody, infoBody]) => {
      const shot = firstShot(thumbBody);
      if (!shot) throw new Error("no thumbnail");

      const info = infoBody as AssetInfo | null;
      if (info && typeof info.Name === "string" && info.Name.trim()) {
        wrap.appendChild(line("dfp-asset-preview__title", info.Name.trim()));

        /* Kind first, creator after, on one line under the name. The chip is
         * the reason the details are fetched at all; the creator is the line
         * allowed to lose its tail, as on the game card. */
        const meta = document.createElement("div");
        meta.className = "dfp-asset-preview__meta";
        const type = assetTypeLabel(info.AssetTypeId);
        if (type) meta.appendChild(chip(type));
        const by = info.Creator?.Name;
        if (typeof by === "string" && by) meta.appendChild(line("dfp-asset-preview__by", `by ${by}`));
        if (meta.childElementCount) wrap.appendChild(meta);
      }

      // Last, so `load` cannot fire before the text it sits above exists.
      img.src = shot;
    })
    .catch(() => {
      shots.set(id, null);
      if (pending === id) hide();
    });

  remember(id, wrap);
  return wrap;
}

function chip(text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "dfp-asset-preview__chip";
  el.textContent = text;
  return el;
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
  const img = picture(key, wrap);
  wrap.appendChild(img);

  const fail = () => {
    shots.set(key, null);
    if (pending === key) hide();
  };

  void json(UNIVERSE_API(placeId))
    .then((body) => {
      const universe = (body as { universeId?: unknown } | null)?.universeId;
      if (typeof universe !== "number") throw new Error("no universe");
      /* Both hang off the universe id, so they go out together — a game hover
       * costs two round trips, not three. */
      return Promise.all([
        json(GAME_THUMB_API(String(universe))),
        // Details are a bonus; the splash alone is still worth showing.
        json(GAME_INFO_API(String(universe))).catch(() => null),
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

/** The lines an entity card draws, worked out from a details body. */
export interface EntityLines {
  title: string;
  by: string | null;
  meta: string | null;
  verified: boolean;
}

interface GroupInfo {
  name?: unknown;
  memberCount?: unknown;
  hasVerifiedBadge?: unknown;
  owner?: { displayName?: unknown; username?: unknown } | null;
}

interface UserInfo {
  name?: unknown;
  displayName?: unknown;
  created?: unknown;
  hasVerifiedBadge?: unknown;
}

/**
 * `groups.roblox.com/v1/groups/{id}` → name, owner, size. Null when the body
 * has no name, which is the one line the card cannot do without.
 */
export function describeGroup(body: unknown): EntityLines | null {
  const g = body as GroupInfo | null;
  if (!g || typeof g.name !== "string" || !g.name.trim()) return null;
  // The display name, or the handle when the display name is absent OR blank
  // — `??` alone let an empty string through and lost the owner line.
  const owner = [g.owner?.displayName, g.owner?.username].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  const count = g.memberCount;
  return {
    title: g.name.trim(),
    by: owner ? `by ${owner.trim()}` : null,
    meta:
      typeof count === "number" && Number.isFinite(count)
        ? `${compact(count)} ${count === 1 ? "member" : "members"}`
        : null,
    verified: g.hasVerifiedBadge === true,
  };
}

/**
 * `users.roblox.com/v1/users/{id}` → display name, handle, join year. The
 * handle is always shown, even when it equals the display name: it is what a
 * reader would type to find the account, and the two differ often enough that
 * omitting it only sometimes would look like an omission.
 */
export function describeUser(body: unknown): EntityLines | null {
  const u = body as UserInfo | null;
  if (!u || typeof u.name !== "string" || !u.name.trim()) return null;
  const handle = u.name.trim();
  const display = typeof u.displayName === "string" && u.displayName.trim() ? u.displayName.trim() : handle;
  const joined = typeof u.created === "string" ? new Date(u.created).getTime() : NaN;
  return {
    title: display,
    by: `@${handle}`,
    meta: Number.isFinite(joined) ? `joined ${new Date(joined).getUTCFullYear()}` : null,
    verified: u.hasVerifiedBadge === true,
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Roblox's verified badge, as a check in a filled circle. Built with
 * `createElementNS` from a fixed path — no markup string, same as the flair
 * icons in group-chips.ts. It sits beside the name rather than in the meta
 * line because that is where every Roblox surface puts it, and a mark a reader
 * has to look for is not a mark.
 */
function verifiedMark(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "dfp-asset-preview__verified";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M20 6 9 17l-5-5");
  svg.appendChild(path);
  mark.appendChild(svg);
  return mark;
}

/**
 * A group or user card: icon or headshot on the left, name with the verified
 * mark, then who owns it or what the handle is, then how big or how old.
 *
 * Unlike the asset and game cards, the details are a condition here, not a
 * bonus: a headshot with no name under it does not say whose profile this is.
 * Both requests go out together and both must answer; the card is still only
 * ever mounted once the picture has loaded, so every failure — a deleted
 * group, a banned account, a network error — ends as a plain working link.
 */
function entityCard(kind: "group" | "user", id: string): HTMLElement | null {
  const key = `${kind}:${id}`;
  const hit = shots.get(key);
  if (hit !== undefined) return hit;

  const wrap = document.createElement("div");
  wrap.className = `dfp-asset-preview__entity dfp-asset-preview__entity--${kind}`;
  const img = picture(key, wrap);
  wrap.appendChild(img);
  const text = document.createElement("div");
  text.className = "dfp-asset-preview__text";
  wrap.appendChild(text);

  const infoUrl = kind === "group" ? GROUP_API(id) : USER_API(id);
  const shotUrl = kind === "group" ? GROUP_ICON_API(id) : USER_HEADSHOT_API(id);

  void Promise.all([json(infoUrl), json(shotUrl)])
    .then(([infoBody, shotBody]) => {
      const shot = firstShot(shotBody);
      if (!shot) throw new Error("no picture");
      const lines = kind === "group" ? describeGroup(infoBody) : describeUser(infoBody);
      if (!lines) throw new Error("no details");

      /* The name is a span inside the title so the verified mark can sit
       * beside it as a flex sibling that never gets clipped — a long name
       * loses its tail to the ellipsis, not the badge. */
      const title = document.createElement("div");
      title.className = "dfp-asset-preview__title";
      const name = document.createElement("span");
      name.className = "dfp-asset-preview__name";
      name.textContent = lines.title;
      title.appendChild(name);
      if (lines.verified) title.appendChild(verifiedMark());
      text.appendChild(title);
      if (lines.by) text.appendChild(line("dfp-asset-preview__by", lines.by));
      if (lines.meta) text.appendChild(line("dfp-asset-preview__meta", lines.meta));

      // Last, so `load` cannot fire before the text beside it exists.
      img.src = shot;
    })
    .catch(() => {
      shots.set(key, null);
      if (pending === key) hide();
    });

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
 * The card's layer is entity-cards.css's business, not this function's: it
 * sat at `z-index: auto` for as long as every anchor it served was in the
 * post column, where nothing is stacked, and stopped being enough once the
 * topic card became a contract other modules hang off links inside the
 * composer (composer.ts's dupes rows) — a panel Discourse fixes at 400. Both
 * cards take 990 there, Discourse's own user-card layer, under the 1000
 * header.
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
  /* The host wears a variant named after the content it holds. The three with
   * text under or beside the picture need the line box back that the bare
   * card kills (media.css / entity-cards.css); toggling all three keeps a card
   * from inheriting the previous hover's variant. */
  for (const variant of ["game", "asset", "entity"]) {
    el.classList.toggle(
      `dfp-asset-preview--${variant}`,
      content.classList.contains(`dfp-asset-preview__${variant}`),
    );
  }
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
  /* A tap that opened a card is spent once the card is gone, whatever took it
   * away — a scroll, a tap elsewhere, Escape. The next tap on the same link
   * opens it again rather than navigating out from under a reader who never
   * saw the card. */
  armed = null;
  if (!shownFor) return;
  shownFor = null;
  // Removed rather than hidden, so a card can never survive a page transition
  // as a stale rectangle over unrelated content.
  card?.remove();
}

/**
 * The cache key and kind a marked anchor asks for, or null.
 *
 * Re-validated even though DFP wrote it. This is read back out of post
 * content, and a post could contain the same attribute — Discourse's
 * sanitiser is not something to bet a URL on. Digits only, same rule as
 * everywhere above; an unknown kind is treated as a plain asset rather than
 * trusted.
 */
function referenceOf(anchor: HTMLElement): (Reference & { key: string }) | null {
  const id = anchor.getAttribute(ASSET);
  if (!id || !ID_ONLY.test(id)) return null;
  const raw = anchor.getAttribute(KIND);
  const kind: Kind = raw === "game" || raw === "group" || raw === "user" ? raw : "asset";
  return { id, kind, key: kind === "asset" ? id : `${kind}:${id}` };
}

function contentFor(ref: Reference): HTMLElement | null {
  switch (ref.kind) {
    case "game":
      return gameCard(ref.id);
    case "group":
    case "user":
      return entityCard(ref.kind, ref.id);
    default:
      return assetCard(ref.id);
  }
}

function open(anchor: HTMLElement): void {
  const ref = referenceOf(anchor);
  if (!ref) return;

  pending = ref.key;
  const content = contentFor(ref);
  // Known bad. The reference stays a link and nothing else happens, ever again.
  if (!content) return;
  const img = content.querySelector("img");
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

/**
 * Touch, and the two taps.
 *
 * On `(hover: none)` there is no pointer to rest on a link, so the card would
 * never open: `pointerover` fires at the start of a tap and the click follows
 * inside `OPEN_DELAY`. So a first tap on a carded link opens the card at once
 * and does not navigate; the second tap on the same link follows it. `armed`
 * is that link, and is forgotten whenever the card goes away (see `hide`) so
 * a tap after a scroll shows the card again instead of leaving.
 *
 * Capture phase on `document`, for the reason topic-preview.ts gives at
 * length: Discourse's cooked-link tracker is bound on the post stream and
 * runs first in the bubble, preventing default and opening the href itself,
 * so a bubble listener here only ever saw a tap that had already navigated.
 * In capture the first tap is taken whole — `preventDefault` plus
 * `stopPropagation` so the tracker never sees it — and the second tap passes
 * through untouched. On touch no timer is ever armed (see `enter`), so a tap
 * that navigates leaves nothing behind to fire against a page on its way out;
 * the `clearTimeout` calls below are for the hover-capable device that also
 * reports `(hover: none)` for one gesture, which costs nothing to cover.
 *
 * The query is created in `mountHover`, not at import: `matchMedia` at module
 * scope is what made op-pin.ts un-importable from Node, and this file is
 * imported directly by entity-cards.test.ts.
 */
let touch: MediaQueryList | null = null;
let armed: HTMLElement | null = null;

function mountHover(): void {
  if (mounted) return;
  mounted = true;
  touch = matchMedia("(hover: none)");

  /* On touch the click handler below is the ONLY opener, and the timer is
   * never armed. It used to be: a tap's `pointerover` armed it, and for a tap
   * that was harmless because the click came first and cleared it. A
   * long-press — the phone's copy-link / open-in-new-tab gesture — and a
   * short drag that starts on a link are `pointerover` with no click, so the
   * timer ran out at 220ms, spent the requests, and mounted a card nobody
   * asked for; and with `pointerleave` ignored on touch (below) nothing took
   * it away until the next tap or scroll. Worse, that path never set `armed`,
   * so the next tap on the same link re-opened the card it could already see
   * instead of following it: a third tap to leave. A list row outside
   * `.cooked` gets no hover on a phone either way. */
  const enter = (node: EventTarget | null): void => {
    const anchor = target(node);
    if (anchor === hovered) return;
    hovered = anchor;
    hide();
    if (anchor && !touch?.matches) openTimer = window.setTimeout(() => open(anchor), OPEN_DELAY);
  };

  document.addEventListener("pointerover", (e) => enter(e.target), { passive: true });
  document.addEventListener("focusin", (e) => enter(e.target));
  document.addEventListener("focusout", () => {
    hovered = null;
    hide();
  });

  /* The pointer can leave through the top of the window without ever crossing
   * another element, and a scroll moves the post out from under a card that is
   * fixed to the viewport. Both leave a card pointing at nothing.
   *
   * Not on touch: a touch pointer leaves the document at the end of EVERY tap
   * — the spec fires `pointerleave` up to the root once the finger lifts — so
   * this would close the card the same tap had just opened. */
  document.documentElement.addEventListener("pointerleave", () => {
    if (touch?.matches) return;
    hovered = null;
    hide();
  });
  /* What `pointerleave` was covering on touch before it had to be ignored
   * there: the browser fires `pointercancel` when it takes the gesture over —
   * the long-press context menu, a scroll or a pinch — which are exactly the
   * two cases where a finger came down on a link and no click will follow. */
  document.addEventListener("pointercancel", () => {
    hovered = null;
    hide();
  });

  document.addEventListener(
    "click",
    (e) => {
      if (!touch?.matches || e.button !== 0) return;
      const anchor = target(e.target);
      if (!anchor) return;
      // Second tap: the card was asked for; this one leaves.
      if (armed === anchor) {
        hovered = null;
        hide();
        return;
      }
      const ref = referenceOf(anchor);
      // Nothing to show — known bad, or not a valid mark — so the tap is a click.
      if (!ref || shots.get(ref.key) === null) {
        clearTimeout(openTimer);
        hovered = null;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(openTimer);
      hovered = anchor;
      armed = anchor;
      open(anchor);
    },
    { capture: true },
  );

  // Escape closes the card, as it does every other overlay in the product.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
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
