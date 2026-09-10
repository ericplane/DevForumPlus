/**
 * Command palette, instant search, filter chips, DFP commands and a recent
 * list (PLAN.md §7.1 #1–#3).
 *
 * One surface, because they are one thing. The plan lists them separately, but
 * a palette that cannot search is a menu, and a search box that cannot jump to
 * a category is a worse version of the search page. Typing filters the same
 * list that ⌘K opens.
 *
 * Lives in the ISOLATED world: it owns chrome.* and, per the project's config
 * comment, all DFP-rendered UI. Rendered into a shadow root so Discourse's
 * typography and the forum's own overlay z-index war cannot reach it, and so
 * nothing here leaks back out.
 *
 * Data:
 *   local    `/site.json` categories — 72 of them, fetched once, matched
 *            in-memory so category jumps are instant with no request.
 *   remote   `/search.json?q=` debounced. Verified shape: parallel `topics[]`
 *            and `posts[]`, the post carrying the blurb and its `created_at`,
 *            the topic the title, slug, tags and `category_id`.
 *   recent   the last dozen topics this browser opened, in chrome.storage.local
 *            under `dfp:recent`. Recorded from this world's one route-change
 *            signal — `<title>` mutating — plus `location.pathname` and the
 *            rendered heading at that moment. On-device only, never sent
 *            anywhere (README, Scope), and its own module, `recent-topics`:
 *            switching it off stops the recorder and clears the record without
 *            taking ⌘K away. The warm cache could not back this: it holds
 *            bodies without titles.
 *   settings the Theme / Density / Width rows read and write chrome.storage.sync
 *            through settings.ts, which is why they can live here at all; the
 *            stamp follows through the same onSettingsChanged every surface
 *            uses.
 *
 * Navigation goes over the bridge. `location.assign` from here is a document
 * load — the forum's TTFB alone is 2427ms of the 2716ms to first paint
 * (perf.css) — while the in-app transition Discourse makes for a clicked link
 * waits on one JSON call, 465ms median (prefetch.ts). So a selection is sent
 * to the MAIN world as `nav:route` and handed to `DiscourseURL.routeTo` there
 * (bridge/main.ts); this side falls back to a document load only when nothing
 * has ever answered on the bridge. The synthetic-anchor trick — append an
 * `<a href>` and `.click()` it — was rejected because Discourse's click
 * interceptor is bound to the `#main` outlet, not the document, so an anchor
 * appended to `<body>` is never intercepted, and one appended inside the
 * outlet would be swept away by the next render.
 *
 * Deliberately NOT included: bookmarks (PLAN §7.1 #7, its own storage), and the
 * `uFuzzy` dependency the plan named — substring-and-prefix ranking over 72
 * categories and a dozen recent titles is not a problem that needs a library.
 */

import { MOD, chord } from "./platform";
import { OLD_AFTER, ageLabel, agoLabel } from "../core/age";
import { getSettings, onSettingsChanged, setSettings } from "../core/settings";
import { DENSITIES, THEMES, WIDTHS, isModuleEnabled, type DfpSettings } from "../core/settings-schema";
import { showOnboarding } from "./onboarding";

const HOTKEY = "k";
const DEBOUNCE_MS = 180;
const MAX_LOCAL = 6;
const MAX_REMOTE = 8;
const MAX_COMMANDS = 8;
/** Stored and shown: a dozen is a session's worth; five is what fits above "Go to". */
const MAX_RECENT_STORED = 12;
const MAX_RECENT_SHOWN = 5;
const RECENT_KEY = "dfp:recent";
/**
 * Two module ids, both in MODULE_IDS and neither in DEFAULT_OFF, so a missing
 * key reads "on" for both.
 *
 * Two rather than one because the recent list is a browsing record and has to
 * be refusable on its own: with a single flag the only way to stop the record
 * was to switch off "command-palette" and lose ⌘K with it. The record still
 * needs the palette — it is the only thing that shows the list — so
 * `recent-topics` is read as "palette on AND recents on".
 */
const MODULE_ID = "command-palette";
const RECENT_MODULE_ID = "recent-topics";

interface SiteCategory {
  id: number;
  name?: string;
  slug?: string;
  color?: string;
  parent_category_id?: number;
  has_children?: boolean;
  description_text?: string | null;
}

interface SearchTopic {
  id: number;
  title?: string;
  fancy_title?: string;
  slug?: string;
  tags?: string[];
  posts_count?: number;
  has_accepted_answer?: boolean;
  category_id?: number;
  created_at?: string;
  last_posted_at?: string;
}

interface SearchPost {
  topic_id: number;
  blurb?: string;
  username?: string;
  post_number?: number;
  /** The matched post's date — what /search shows, and what search-signals ages. */
  created_at?: string;
}

/** One visited topic. `cat` is the category name when the page said it. */
export interface RecentEntry {
  id: number;
  slug: string;
  title: string;
  cat?: string;
  at: number;
}

interface Row {
  kind: "recent" | "action" | "category" | "command" | "topic";
  title: string;
  sub?: string;
  /** Where the row goes. Absent on a command, which runs instead. */
  href?: string;
  badge?: string;
  /** Muted trailing text: a category name, "current", "5 min ago". */
  meta?: string;
  /** The two-years-and-older mark, coloured; only topic rows carry one. */
  age?: string;
  run?: () => void;
}

const GROUP: Record<Row["kind"], string> = {
  recent: "Recent",
  action: "Go to",
  category: "Categories",
  command: "DevForum Plus",
  topic: "Topics",
};

/** Group order when typed matches of several kinds share the local slots. */
const RANK: Record<Row["kind"], number> = { recent: 0, action: 1, category: 2, command: 3, topic: 4 };

/**
 * Discourse's search syntax, which is powerful and completely undiscoverable —
 * the actual complaint in §7.1 #3. These are offered as one-click chips rather
 * than documented, because nobody reads search documentation.
 */
function filters(): { chip: string; token: string; hint: string }[] {
  /* Computed, not hardcoded. This was `after:2026-01-01`, which is correct
   * today and silently means "since last January" on the 1st of the next one —
   * a filter that quietly stops doing what its label says. */
  const year = new Date().getFullYear();
  return [
    { chip: "solved", token: "status:solved", hint: "has an accepted answer" },
    { chip: "unsolved", token: "status:unsolved", hint: "no accepted answer yet" },
    { chip: "this year", token: `after:${year}-01-01`, hint: `posted since January ${year}` },
    { chip: "in title", token: "in:title", hint: "match the title only" },
    { chip: "my posts", token: "in:posted", hint: "topics you posted in" },
    { chip: "10+ replies", token: "min_posts:10", hint: "substantial threads" },
  ];
}

/**
 * Is this exact token in the query?
 *
 * Exact, not by key. An earlier version also matched on the key so that
 * `status:solved` and `status:unsolved` would not both end up in the query —
 * but that is the *toggle* question, and using it for the pressed state lit up
 * every chip sharing a prefix. Typing `status:solved` highlighted "solved" and
 * "unsolved" at once. Two different questions, two functions.
 */
function hasToken(query: string, token: string): boolean {
  return query.split(/\s+/).some((w) => w === token);
}

/** The key half — `status:solved` and `status:unsolved` cannot coexist. */
function tokenKey(token: string): string {
  return token.split(":")[0] ?? token;
}

// ── Pure helpers (tests/unit/command-palette.test.ts) ───────────────────────

/**
 * Rank by where the match lands, not by a similarity score.
 *
 * A prefix match is what someone typing a category name means; a word-start
 * match is second; anywhere else is last. Over 72 categories this is both
 * better and cheaper than fuzzy scoring, which would rank "Studio Bugs" above
 * "Bug Reports" for the query "bug".
 */
export function score(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 0;
  const i = h.indexOf(n);
  if (i === -1) return -1;
  if (i === 0) return 3;
  if (/\s|[-/]/.test(h[i - 1] ?? "")) return 2;
  return 1;
}

/**
 * The topic a page path names. The same guarded shape as topic-data.ts's
 * TOPIC_HREF — the lookahead is what stops `/t/4301387/12` reading the topic id
 * as a slug and post 12 as the topic — written out here rather than imported
 * because that file is the MAIN-world tree and this is the other bundle.
 */
const TOPIC_PATH = /^\/t\/(?:(?!\d+(?:\/|$))([^/]+)\/)?(\d+)(?:\/(\d+))?(?:[/?#]|$)/;

export function topicFromPath(pathname: string): { id: number; slug: string } | null {
  const m = TOPIC_PATH.exec(pathname);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { id, slug: m[1] ?? "" };
}

/**
 * `document.title` → the topic's own title, and the category if the tail names
 * one Discourse renders `Title - Category - Site name`, prefixing an unread
 * count in parentheses when there is one. Only the tail is inspected, so a
 * title with " - " inside it keeps its dashes: the site name is stripped when
 * it is known (from `og:site_name`) or looks like one (a `|` in the last
 * segment, the "Developer Forum | Roblox" shape), and the category only when
 * the last remaining segment is a category name the palette already holds.
 */
export function parseTitle(
  docTitle: string,
  siteName: string | null,
  categories: Iterable<string>,
): { title: string; cat?: string } {
  const parts = docTitle
    .trim()
    .replace(/^\(\d+\)\s*/, "")
    .split(" - ");
  const tail = () => parts[parts.length - 1] ?? "";
  if (parts.length > 1 && ((siteName && tail() === siteName) || /\|/.test(tail()))) parts.pop();
  let cat: string | undefined;
  if (parts.length > 1) {
    const names = new Set(categories);
    if (names.has(tail())) {
      cat = parts.pop();
    }
  }
  const title = parts.join(" - ").trim();
  return cat ? { title, cat } : { title };
}

/** Newest first, one row per topic, capped. */
export function pushRecent(list: RecentEntry[], entry: RecentEntry, cap: number): RecentEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, cap);
}

/**
 * Storage is shared with other builds of this extension, so nothing read from
 * it is trusted: a row missing a field is dropped rather than rendered as
 * "undefined".
 */
export function sanitizeRecent(raw: unknown, cap = MAX_RECENT_STORED): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentEntry[] = [];
  for (const v of raw) {
    if (typeof v !== "object" || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r["id"] !== "number" || !Number.isFinite(r["id"]) || r["id"] <= 0) continue;
    if (typeof r["title"] !== "string" || !r["title"].trim()) continue;
    if (typeof r["at"] !== "number" || !Number.isFinite(r["at"])) continue;
    const entry: RecentEntry = {
      id: r["id"],
      slug: typeof r["slug"] === "string" ? r["slug"] : "",
      title: r["title"].trim().slice(0, 200),
      at: r["at"],
    };
    if (typeof r["cat"] === "string" && r["cat"].trim()) entry.cat = r["cat"].trim().slice(0, 80);
    if (out.some((e) => e.id === entry.id)) continue;
    out.push(entry);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Off when the master switch or the module flag says so. The flag is read
 * through `isModuleEnabled` like every other surface: DEFAULT_OFF changes what
 * an absent key means, and the string-index `!== false` read this used to be
 * would have mounted the first isolated module added there while the options
 * page showed it off.
 *
 * The master switch matters here more than in a MAIN module: root-attrs.ts
 * drops `data-dfp` when `enabled` is false, so every chrome.css rule stands
 * down — and without this check the header trigger stayed mounted as a raw
 * `<button><kbd>Ctrl</kbd><kbd>K</kbd></button>` in the forum header, ⌘K
 * still opened the panel and the recorder kept writing, all while the reader
 * believed DFP was off. composer.ts gates on `settings.enabled` the same way.
 */
export function paletteEnabled(settings: DfpSettings): boolean {
  return settings.enabled && isModuleEnabled(settings, MODULE_ID);
}

/** The recorder and the Recent group: the palette's flag, then its own. */
export function recentEnabled(settings: DfpSettings): boolean {
  return paletteEnabled(settings) && isModuleEnabled(settings, RECENT_MODULE_ID);
}

/**
 * Whether a DFP command row answers a query. Word-start matching is right for
 * "dark" → "Theme: dark", but one character is not a query: "t" lit up all
 * six Theme rows plus "Toggle thread view" (every value after "Theme: " is a
 * word start), and "d" three Density rows plus two themes — up to
 * MAX_COMMANDS rows of noise on the first keystroke of every topic search,
 * ranked above the Topics group. Two characters is where a prefix starts
 * meaning something.
 */
export function commandMatches(title: string, q: string): boolean {
  return q.length >= 2 && score(title, q) >= 2;
}

// ── State ───────────────────────────────────────────────────────────────────

export interface PaletteDeps {
  /**
   * Route in-app. Returns false when it could not ask — the bridge has never
   * heard from MAIN — and the caller loads the document instead.
   */
  route?: (href: string) => boolean;
}

let deps: PaletteDeps = {};
let settings: DfpSettings | null = null;
/* The palette and the recorder attach and detach separately, one list each,
 * because their flags are separate: `recent-topics` can go off and take only
 * the recorder and the record with it. */
let attached = false;
let recording = false;
const detachFns: (() => void)[] = [];
const recorderFns: (() => void)[] = [];

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLDivElement | null = null;
let chipRow: HTMLDivElement | null = null;
let status: HTMLDivElement | null = null;
let open = false;
let rows: Row[] = [];
let active = 0;
let debounce = 0;
/** Bumped per keystroke so a slow response cannot overwrite a newer one. */
let generation = 0;
/** True while a remote search is outstanding, so the empty state can say so. */
let pending = false;
/**
 * True once the last query's search finished. A palette closed mid-search
 * keeps whatever rows it had; on reopen this says whether they are complete
 * or the search must be run again.
 */
let settled = true;
/**
 * The remote half of the settled answer, kept apart from `rows` so a reopen
 * can rebuild the local half — command rows bake "current" and the thread
 * toggle's wording at schedule time, and a reopen right after running one is
 * exactly when they are wrong — without paying the round trip again.
 */
let remoteCache: Row[] = [];
let categories: Promise<SiteCategory[]> | null = null;
/** The resolved categories, for the recorder, which cannot wait on a promise. */
let categoriesNow: SiteCategory[] | null = null;
let recent: RecentEntry[] | null = null;
let restoreFocus: Element | null = null;

function loadCategories(): Promise<SiteCategory[]> {
  categories ??= fetch("/site.json", {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  })
    .then((r) => (r.ok ? (r.json() as Promise<{ categories?: SiteCategory[] }>) : null))
    .then((s) => (categoriesNow = s?.categories ?? []))
    .catch(() => (categoriesNow = []));
  return categories;
}

function loadRecent(): Promise<RecentEntry[]> {
  if (recent) return Promise.resolve(recent);
  return chrome.storage.local
    .get(RECENT_KEY)
    .then((store) => (recent = sanitizeRecent(store[RECENT_KEY])))
    .catch(() => (recent = []));
}

function saveRecent(next: RecentEntry[]): void {
  recent = next;
  void chrome.storage.local.set({ [RECENT_KEY]: next }).catch(() => {});
}

function clearRecent(): void {
  recent = [];
  void chrome.storage.local.remove(RECENT_KEY).catch(() => {});
}

const ACTIONS: Row[] = [
  { kind: "action", title: "Latest", sub: "All recent topics", href: "/latest" },
  { kind: "action", title: "Unread", sub: "Topics you follow", href: "/unread" },
  { kind: "action", title: "Top", sub: "Most active", href: "/top" },
  { kind: "action", title: "My posts", sub: "Topics you posted in", href: "/my/activity" },
  { kind: "action", title: "Bookmarks", sub: "Saved topics", href: "/my/activity/bookmarks" },
  { kind: "action", title: "Categories", sub: "Browse the tree", href: "/categories" },
];

/* Last in the Recent group rather than a command, so it sits beside what it
 * clears and stays out of the way when there is nothing to clear. */
const CLEAR_RECENT: Row = {
  kind: "recent",
  title: "Clear recent",
  sub: "Forget the topics listed above",
  run: () => {
    clearRecent();
    refresh();
  },
};

// ── Matching ────────────────────────────────────────────────────────────────

function recentRow(e: RecentEntry): Row {
  return {
    kind: "recent",
    title: e.title,
    sub: e.cat ?? "Topic",
    meta: agoLabel(Date.now() - e.at),
    href: `/t/${e.slug || "topic"}/${e.id}`,
  };
}

function localRows(query: string, cats: SiteCategory[], recents: RecentEntry[]): Row[] {
  const q = query.replace(/\S+:\S*/g, "").trim();
  /* The topic already open is the one entry that cannot be "get back to".
   * Nothing at all when the recorder is off: the record is cleared on that
   * transition, but another tab's write could still be sitting in memory. */
  const here = topicFromPath(location.pathname)?.id;
  const visible = recording ? recents.filter((e) => e.id !== here) : [];

  if (!q) {
    const rs = visible.slice(0, MAX_RECENT_SHOWN).map(recentRow);
    if (rs.length) rs.push(CLEAR_RECENT);
    return [...rs, ...ACTIONS.slice(0, MAX_LOCAL)];
  }

  const scored: { row: Row; s: number }[] = [];
  for (const e of visible) {
    const s = score(e.title, q);
    if (s > 0) scored.push({ row: recentRow(e), s });
  }
  for (const a of ACTIONS) {
    const s = score(a.title, q);
    if (s > 0) scored.push({ row: a, s });
  }
  for (const c of cats) {
    if (!c.name || !c.slug) continue;
    const s = score(c.name, q);
    if (s <= 0) continue;
    scored.push({
      row: {
        kind: "category",
        title: c.name,
        sub: c.description_text?.slice(0, 70) || "Category",
        href: `/c/${c.slug}/${c.id}`,
      },
      s,
    });
  }
  scored.sort((a, b) => b.s - a.s || a.row.title.length - b.row.title.length);
  /* Re-grouped after ranking, or a strong category match between two recents
   * would print the "Recent" header twice. Array sort is stable, so rank order
   * survives within a group. */
  const top = scored.slice(0, MAX_LOCAL).sort((a, b) => RANK[a.row.kind] - RANK[b.row.kind]);
  return [...top.map((x) => x.row), ...commandRows(q)];
}

/**
 * DFP's own knobs, matched by prefix or word start so "dark" finds
 * "Theme: dark" and "theme" lists every theme. Not shown on an empty query:
 * the empty state is for getting somewhere, and these are for changing how it
 * looks once you are there.
 */
function commandRows(q: string): Row[] {
  const out: Row[] = [];
  const setting = (title: string, sub: string, patch: Partial<DfpSettings>, current: boolean) =>
    out.push({
      kind: "command",
      title,
      sub,
      meta: current ? "current" : undefined,
      run: () => {
        close();
        // The stamp follows through onSettingsChanged in isolated.content.ts.
        void setSettings(patch).catch(() => {});
      },
    });

  for (const t of THEMES) {
    setting(`Theme: ${t}`, t === "auto" ? "Follow the system" : "Colour theme", { theme: t }, settings?.theme === t);
  }
  for (const d of DENSITIES) setting(`Density: ${d}`, "Row and post spacing", { density: d }, settings?.density === d);
  for (const w of WIDTHS) setting(`Width: ${w}`, "Content column width", { width: w }, settings?.width === w);

  out.push({
    kind: "command",
    title: "Open settings",
    sub: "Every DevForum Plus option, in its own tab",
    run: () => {
      close();
      // `openOptionsPage` is background-only; onboarding.ts asks the same way.
      void chrome.runtime.sendMessage({ t: "dfp:open-options" }).catch(() => {});
    },
  });
  out.push({
    kind: "command",
    title: "Show welcome card again",
    sub: "The first-run tips",
    run: () => {
      close();
      showOnboarding();
    },
  });

  /* thread-view.ts owns the toggle and its state; the light-DOM button is its
   * one public entry point, and a click from this world reaches the MAIN-world
   * listener like any other. Only offered where the button exists, which is
   * only on a topic. */
  const toggle = document.querySelector<HTMLElement>(".dfp-thread-toggle");
  if (toggle) {
    const on = toggle.getAttribute("aria-pressed") === "true";
    out.push({
      kind: "command",
      title: "Toggle thread view",
      sub: on ? "On for this topic — turn it off" : "Indent replies by depth on this topic",
      run: () => {
        close();
        toggle.click();
      },
    });
  }

  return out.filter((r) => commandMatches(r.title, q)).slice(0, MAX_COMMANDS);
}

async function remoteRows(query: string, cats: SiteCategory[]): Promise<Row[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = `/search.json?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  }).catch(() => null);
  if (!res?.ok) return [];
  const data = (await res.json().catch(() => null)) as {
    topics?: SearchTopic[];
    posts?: SearchPost[];
  } | null;
  if (!data?.topics) return [];

  // `posts` runs parallel to `topics` and carries the blurb; index it by topic
  // so a topic without a matching post still renders.
  const blurbs = new Map<number, SearchPost>();
  for (const p of data.posts ?? []) if (!blurbs.has(p.topic_id)) blurbs.set(p.topic_id, p);

  const byId = new Map<number, SiteCategory>();
  for (const c of cats) byId.set(c.id, c);
  const now = Date.now();

  /* Discourse's order is kept. Sorting current-year results to the front was
   * considered and rejected: it would silently replace the relevance order the
   * full search page shows for the same query. The age mark says what the
   * README says search never does — an old answer is old — without reordering. */
  return data.topics.slice(0, MAX_REMOTE).map((t) => {
    const post = blurbs.get(t.id);
    const decoded = decodeEntities(t.fancy_title || t.title || "");
    /* The matched post's date, as /search shows and search-signals ages; the
     * topic's own only when no post came back for it. */
    const when = Date.parse(post?.created_at ?? t.created_at ?? "");
    const age = Number.isFinite(when) && now - when >= OLD_AFTER ? ageLabel(now - when) : undefined;
    const cat = t.category_id === undefined ? undefined : byId.get(t.category_id)?.name;
    return {
      kind: "topic" as const,
      title: decoded,
      sub: decodeEntities(post?.blurb ?? "").slice(0, 110),
      href: `/t/${t.slug ?? "topic"}/${t.id}`,
      badge: t.has_accepted_answer ? "solved" : undefined,
      meta: cat,
      age,
    };
  });
}

/** Titles and blurbs arrive HTML-escaped; this is text, never markup. */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const CSS = `
:host { all: initial; }
.scrim {
  position: fixed; inset: 0; z-index: 2147483001;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
  display: flex; align-items: flex-start; justify-content: center;
  padding-block-start: 12vh;
  font-family: var(--dfp-font, system-ui, sans-serif);
}
.panel {
  position: relative;
  width: min(40rem, calc(100vw - 2rem));
  max-height: 70vh;
  display: flex; flex-direction: column;
  background: var(--dfp-surface-1, #14171c);
  border: 1px solid var(--dfp-border, #333);
  border-radius: var(--dfp-r-lg, 14px);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.5);
  overflow: hidden;
  animation: rise 140ms cubic-bezier(.2,.8,.2,1);
}
@keyframes rise { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: none } }
@media (prefers-reduced-motion: reduce) { .panel { animation: none } }
input {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  padding: 14px 16px;
  color: var(--dfp-text, #eff4fc);
  /* Every px size in this sheet is multiplied by --dfp-font-scale. The Text
   * size control scaled every forum token by up to 1.25 while the palette
   * stayed at 10-15px, and the control made the gap obvious. The custom
   * property crosses the host's "all: initial" (the all shorthand excludes
   * custom properties, which is how --dfp-surface-* already arrives) and the
   * host is a body child, so the inline value root-attrs.ts writes on <html>
   * reaches it; 1 is for the harness and a page with no stamp. */
  font-size: calc(15px * var(--dfp-font-scale, 1));
  border-block-end: 1px solid var(--dfp-border, #333);
}
input::placeholder { color: var(--dfp-text-3, #868a91); }
input::selection { background: var(--dfp-accent-soft, #0d2e44); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 12px; border-block-end: 1px solid var(--dfp-border, #333); }
/* 24px tall: the 11px type at 2px padding made a ~20px target, under the
 * 24px floor; the padding stays and the box grows around it. */
.chip {
  all: unset;
  box-sizing: border-box;
  display: inline-flex; align-items: center;
  min-height: 24px;
  padding: 2px 9px;
  border: 1px solid var(--dfp-border, #333);
  border-radius: 999px;
  color: var(--dfp-text-3, #868a91);
  font-size: calc(11px * var(--dfp-font-scale, 1));
  cursor: pointer;
}
/* Hover is NEUTRAL, deliberately.
 *
 * This used to give hover the same accent colour and accent border as the
 * pressed state, differing only by a faint fill — so the chip under the cursor
 * was indistinguishable from an active filter, and a query of status:solved
 * looked like it had selected both "solved" and "unsolved". It was reported
 * twice as a selection bug; the selection logic was right both times.
 *
 * Accent now means "this filter is on", and nothing else says it. */
.chip:hover {
  color: var(--dfp-text, #eff4fc);
  border-color: var(--dfp-border-strong, #40444a);
  background: var(--dfp-surface-3, #25282e);
}
/* Keyboard focus is a ring, not a colour swap, for the same reason. */
.chip:focus-visible {
  outline: 2px solid var(--dfp-accent, #37b3ff);
  outline-offset: 2px;
}
.chip[aria-pressed="true"] {
  color: var(--dfp-accent, #37b3ff);
  border-color: var(--dfp-accent, #37b3ff);
  background: var(--dfp-accent-soft, #0d2e44);
}
.chip[aria-pressed="true"]:hover {
  background: color-mix(in oklab, var(--dfp-accent, #37b3ff) 26%, transparent);
}
.list { overflow-y: auto; padding: 6px; }
.row {
  display: flex; align-items: baseline; gap: 10px;
  padding: 8px 10px; border-radius: var(--dfp-r-sm, 8px);
  cursor: pointer;
}
.row[data-active="1"] { background: var(--dfp-surface-3, #25282e); }
.row .t { color: var(--dfp-text, #eff4fc); font-size: calc(13.5px * var(--dfp-font-scale, 1)); flex: 0 1 auto; }
.row .s { color: var(--dfp-text-3, #868a91); font-size: calc(11.5px * var(--dfp-font-scale, 1)); flex: 1 1 auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Trailing facts — category, "current", how long ago — in the same grey as the
 * blurb, so the row does not get louder for carrying them. */
.row .m { flex: 0 0 auto; color: var(--dfp-text-3, #868a91); font-size: calc(11px * var(--dfp-font-scale, 1)); white-space: nowrap; }
.row .b {
  flex: 0 0 auto; font-size: calc(10px * var(--dfp-font-scale, 1)); padding: 0 6px; border-radius: 999px;
  color: var(--dfp-solved, #1ac972);
  border: 1px solid color-mix(in oklab, var(--dfp-solved, #1ac972) 40%, transparent);
}
/* The one coloured mark: two years and older, in the caution colour the
 * search page's age chip uses (search.css). */
.row .b.warn {
  color: var(--dfp-warning, #e3a53a);
  border-color: color-mix(in oklab, var(--dfp-warning, #e3a53a) 40%, transparent);
}
.group { padding: 8px 10px 4px; color: var(--dfp-text-3, #868a91); font-size: calc(10.5px * var(--dfp-font-scale, 1));
  text-transform: uppercase; letter-spacing: .04em; }
.empty { padding: 22px; text-align: center; color: var(--dfp-text-3, #868a91); font-size: calc(13px * var(--dfp-font-scale, 1)); }
.foot {
  display: flex; gap: 14px; padding: 8px 14px;
  border-block-start: 1px solid var(--dfp-border, #333);
  color: var(--dfp-text-3, #868a91); font-size: calc(11px * var(--dfp-font-scale, 1));
}
kbd {
  font-family: var(--dfp-mono, ui-monospace, monospace);
  border: 1px solid var(--dfp-border, #333); border-radius: 4px;
  padding: 0 4px; font-size: calc(10px * var(--dfp-font-scale, 1));
}
/* Present for assistive tech, absent from the box: the status line. */
.sr {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
`;

/** Current query text, for the empty state's wording. */
function query(): string {
  return (input?.value ?? "").trim();
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function ensureHost(): void {
  if (host?.isConnected) return;
  host = document.createElement("div");
  host.id = "dfp-palette";
  shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = CSS;

  const scrim = el("div", "scrim");
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });

  const panel = el("div", "panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Search and commands");

  /* The combobox pattern: the input owns the list through aria-controls and
   * points at the highlighted row through aria-activedescendant, so a screen
   * reader hears each arrow press land. Ids resolve inside the shadow tree,
   * which is where both ends live. */
  input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Search topics, jump to a category, change a setting…";
  input.setAttribute("aria-label", "Search topics, categories and DevForum Plus commands");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-controls", "dfp-k-list");
  input.setAttribute("aria-autocomplete", "list");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("input", () => schedule());

  chipRow = el("div", "chips") as HTMLDivElement;
  list = el("div", "list") as HTMLDivElement;
  list.id = "dfp-k-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Results");

  status = el("div", "sr") as HTMLDivElement;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const foot = el("div", "foot");
  /* The legend is the one place the modifier is shown to a reader who has the
   * palette open, and it read `⌘⏎` for everyone; the handler accepts Ctrl too,
   * and most people on a Roblox forum are on Windows. See platform.ts. */
  for (const [k, label] of [
    ["↑↓", "navigate"],
    ["⏎", "open"],
    [chord("⏎"), "new tab"],
    ["esc", "close"],
  ] as const) {
    const span = el("span");
    span.append(el("kbd", undefined, k), document.createTextNode(` ${label}`));
    foot.appendChild(span);
  }

  panel.append(input, chipRow, list, status, foot);
  scrim.appendChild(panel);
  shadow.append(style, scrim);
  document.body.appendChild(host);
}

function announce(text: string): void {
  if (status && status.textContent !== text) status.textContent = text;
}

function renderChips(): void {
  if (!chipRow || !input) return;
  chipRow.replaceChildren();
  const q = input.value;
  for (const f of filters()) {
    const b = el("button", "chip", f.chip) as HTMLButtonElement;
    b.type = "button";
    b.title = f.hint;
    const on = hasToken(q, f.token);
    b.setAttribute("aria-pressed", String(on));
    b.addEventListener("click", () => {
      if (!input) return;
      // Toggling replaces any existing token of the same key, so `status:solved`
      // and `status:unsolved` cannot both end up in the query.
      const key = tokenKey(f.token);
      const kept = input.value.split(/\s+/).filter((w) => w && tokenKey(w) !== key);
      input.value = (on ? kept : [...kept, f.token]).join(" ").trim();
      input.focus();
      schedule(0);
    });
    chipRow.appendChild(b);
  }
}

function renderRows(): void {
  if (!list) return;
  list.replaceChildren();
  if (!rows.length) {
    /* "No matches" while a request is still in flight is a lie, and on a slow
     * response it is the first thing you read after typing — measured at over a
     * second against the live forum. Say what is actually happening. */
    const msg = pending ? "Searching…" : query() ? "No matches" : "Type to search";
    list.appendChild(el("div", "empty", msg));
    input?.removeAttribute("aria-activedescendant");
    announce(msg);
    return;
  }
  let lastKind: string | null = null;
  rows.forEach((r, i) => {
    if (r.kind !== lastKind) {
      lastKind = r.kind;
      const g = el("div", "group", GROUP[r.kind]);
      g.setAttribute("role", "presentation");
      list!.appendChild(g);
    }
    const row = el("div", "row");
    row.id = `dfp-k-${i}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === active));
    row.dataset["active"] = i === active ? "1" : "0";
    row.append(el("span", "t", r.title));
    if (r.sub) row.append(el("span", "s", r.sub));
    if (r.meta) row.append(el("span", "m", r.meta));
    if (r.age) row.append(el("span", "b warn", r.age));
    if (r.badge) row.append(el("span", "b", r.badge));
    row.addEventListener("mouseenter", () => {
      active = i;
      paintActive();
    });
    row.addEventListener("click", (e) => go(r, e.metaKey || e.ctrlKey));
    list!.appendChild(row);
  });
  paintActive();
  const n = rows.length;
  announce(`${n} result${n === 1 ? "" : "s"}${pending ? ", searching…" : ""}`);
}

function paintActive(): void {
  if (!list) return;
  const els = list.querySelectorAll<HTMLElement>(".row");
  els.forEach((e, i) => {
    const on = i === active;
    e.dataset["active"] = on ? "1" : "0";
    e.setAttribute("aria-selected", String(on));
  });
  const current = els[active];
  if (current) {
    input?.setAttribute("aria-activedescendant", current.id);
    current.scrollIntoView({ block: "nearest" });
  } else {
    input?.removeAttribute("aria-activedescendant");
  }
}

function schedule(delay = DEBOUNCE_MS): void {
  clearTimeout(debounce);
  renderChips();
  const gen = ++generation;
  const q = input?.value ?? "";
  settled = false;
  remoteCache = [];

  // Local matches are synchronous once the two caches are warm, so the list
  // never sits empty while the network catches up.
  void Promise.all([loadCategories(), loadRecent()]).then(([cats, recents]) => {
    if (gen !== generation) return;
    rows = localRows(q, cats, recents);
    active = 0;
    renderRows();
  });

  // Only a query long enough to actually search counts as pending; otherwise
  // the empty state would read "Searching…" for one- and two-letter input that
  // never reaches the network.
  pending = q.trim().length >= 3;
  if (!pending) {
    settled = true;
    return;
  }

  debounce = window.setTimeout(() => {
    void loadCategories()
      .then((cats) => Promise.all([cats, loadRecent(), remoteRows(q, cats)] as const))
      .then(([cats, recents, remote]) => {
        if (gen !== generation) return;
        pending = false;
        settled = true;
        remoteCache = remote;
        if (remote.length) rows = [...localRows(q, cats, recents), ...remote];
        renderRows();
      })
      .catch(() => {
        if (gen === generation) {
          pending = false;
          settled = true;
          renderRows();
        }
      });
  }, delay);
}

/**
 * Rebuild the local half of the list over the settled remote half — no
 * debounce, no request. Used on reopen and after "Clear recent": both change
 * what the local rows should say (a theme just switched is now "current", the
 * thread toggle's wording flipped, an entry is gone) and neither changes what
 * the search returned. The highlight is kept where it was, clamped, so
 * closing to glance at a result and reopening lands on the same row.
 */
function refresh(): void {
  const gen = generation;
  const q = input?.value ?? "";
  pending = false;
  renderChips();
  void Promise.all([loadCategories(), loadRecent()]).then(([cats, recents]) => {
    if (gen !== generation) return;
    rows = [...localRows(q, cats, recents), ...remoteCache];
    active = Math.min(active, Math.max(0, rows.length - 1));
    renderRows();
  });
}

function go(row: Row, newTab: boolean): void {
  if (row.run) {
    row.run();
    return;
  }
  if (!row.href) return;
  if (newTab) {
    window.open(row.href, "_blank", "noopener");
    return;
  }
  close();
  navigate(row.href);
}

/** In-app when the bridge can carry it; a document load when nothing can. */
function navigate(href: string): void {
  if (deps.route?.(href)) return;
  location.assign(href);
}

// ── Open / close ────────────────────────────────────────────────────────────

/**
 * The last query stays, selected, so a keystroke replaces it and ↓ / ⏎ reuse
 * it. `show()` used to clear the input and search again on every open, so
 * closing to glance at a result and reopening to refine meant retyping and
 * re-paying the debounce plus a round trip measured at over a second. The
 * search is only re-run when the retained rows are not the finished answer —
 * an empty query, whose recents may have moved, or one closed mid-search.
 * A settled answer is not re-rendered as it was, either: its local rows are
 * rebuilt over the cached remote ones (`refresh`), because "Theme: light"
 * chosen from this list must not still show "Theme: dark" as current when the
 * list comes back. State is per page load already, so a hard navigation
 * clears it for free.
 */
function show(): void {
  if (open) return;
  ensureHost();
  open = true;
  restoreFocus = document.activeElement;
  if (host) host.style.display = "";
  input?.setAttribute("aria-expanded", "true");
  if (!query() || !settled) schedule(0);
  else refresh();
  input?.focus();
  input?.select();
}

function close(): void {
  if (!open) return;
  open = false;
  clearTimeout(debounce);
  generation++;
  if (host) host.style.display = "none";
  input?.setAttribute("aria-expanded", "false");
  // Put the caret back where it was, or the page becomes unnavigable by keyboard.
  if (restoreFocus instanceof HTMLElement) restoreFocus.focus();
  restoreFocus = null;
}

/**
 * Is the keystroke going into the composer's editor?
 *
 * Only the editor textarea, deliberately, and not every input: Discourse's
 * d-editor binds the same key to its Insert-link button, so a writer pressing
 * it there wants a link dialog and got the palette over the composer instead.
 * The header search box is different — there is no competing shortcut, and
 * without preventDefault Chrome takes the key for the omnibox — so the palette
 * still opens from it. The palette's own input lives in a shadow root and
 * retargets to the host `div`, so it never matches and the key still closes
 * an open palette.
 */
function inEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("textarea.d-editor-input") !== null;
}

/** The focused element inside the panel, if any: the input or a chip. */
function focusedInPanel(): HTMLElement | null {
  const a = shadow?.activeElement;
  return a instanceof HTMLElement ? a : null;
}

function onKeydown(e: KeyboardEvent): void {
  // ⌘K / Ctrl+K. Chrome gives Ctrl+K to the omnibox only when the page does
  // not take it, so preventDefault is what makes this work at all.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === HOTKEY) {
    // Falls through untouched, so the editor's own handler sees it next.
    if (!open && inEditor(e.target)) return;
    e.preventDefault();
    open ? close() : show();
    return;
  }
  if (!open) return;

  if (e.key === "Escape") {
    e.preventDefault();
    close();
    return;
  }
  /* The trap. aria-modal promises focus stays inside, and nothing enforced
   * it: Tab walked input → six chips → out under the scrim into the page.
   * Wrapping within the panel's own focusables is the whole of the fix; the
   * page is not made inert, because a throw or an in-app route before close()
   * would have left the forum inert, and the scrim already owns the pointer. */
  if (e.key === "Tab") {
    e.preventDefault();
    if (!input || !chipRow) return;
    const ring: HTMLElement[] = [input, ...chipRow.querySelectorAll<HTMLElement>(".chip")];
    const cur = focusedInPanel();
    const i = cur ? ring.indexOf(cur) : -1;
    const next = i < 0 ? input : ring[(i + (e.shiftKey ? -1 : 1) + ring.length) % ring.length];
    next?.focus();
    return;
  }
  /* A focused chip is a button: Enter and Space are its click, not a
   * selection of whichever row happens to be highlighted. Before this the
   * capture handler below took Enter first and opened the active row. */
  const focused = focusedInPanel();
  if (focused && focused !== input && (e.key === "Enter" || e.key === " ")) return;

  if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
    e.preventDefault();
    active = rows.length ? (active + 1) % rows.length : 0;
    paintActive();
    return;
  }
  if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
    e.preventDefault();
    active = rows.length ? (active - 1 + rows.length) % rows.length : 0;
    paintActive();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const row = rows[active];
    if (row) go(row, e.metaKey || e.ctrlKey);
    else if (input?.value.trim()) {
      // No match, but a query — hand it to the full search page rather than
      // doing nothing.
      const q = input.value.trim();
      close();
      navigate(`/search?q=${encodeURIComponent(q)}`);
    }
    return;
  }
  // Everything else belongs to the input, which already has focus.
}

// ── Recents recorder ────────────────────────────────────────────────────────

/** The rendered heading for the topic the path names, once Ember has drawn it. */
function topicHeading(id: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#topic-title h1[data-topic-id="${id}"]`);
}

/**
 * Record the topic on screen. Called when `<title>` changes, which is the one
 * signal this world has for a Discourse route change — `onPageChange` is a
 * MAIN-world API and the bridge carries no route message.
 *
 * The title comes from the `<h1>` when it is rendered for this topic, because
 * that is the exact text and the category badge beside it is the exact
 * category. Until it is rendered the call returns false and the caller comes
 * back, because recording from `document.title` at that moment was measured
 * wrong on every hard load: at DOMContentLoaded the outlet is empty and
 * `categoriesNow` is null (`/site.json` is fetched on the first palette open,
 * not on load), so `parseTitle` cannot strip the category and the entry read
 * "How do I use task.wait - Scripting Support" with no `cat` — while the same
 * topic reached in-app read "How do I use task.wait" · Scripting Support. Only
 * the last retry (`final`) settles for the parsed `document.title`, which is
 * for a Discourse whose heading markup has changed shape, not for a slow boot.
 *
 * A repeat of the top entry is a no-op unless the title improved or a minute
 * has passed, so the retries and the second `<title>` write per transition
 * cost one read of the in-memory list each and no storage write.
 */
function recordVisit(final: boolean): boolean {
  const t = topicFromPath(location.pathname);
  if (!t) return true;

  const h1 = topicHeading(t.id);
  const fromDom = h1?.querySelector(".fancy-title")?.textContent?.trim();
  if (!fromDom && !final) return false;

  const site = document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content ?? null;
  const parsed = parseTitle(
    document.title,
    site,
    (categoriesNow ?? []).map((c) => c.name ?? "").filter(Boolean),
  );
  const title = fromDom || parsed.title || t.slug.replace(/-/g, " ");
  if (!title) return true;

  const badges = document.querySelectorAll<HTMLElement>("#topic-title .badge-category__name");
  const cat = badges[badges.length - 1]?.textContent?.trim() || parsed.cat;

  void loadRecent().then((current) => {
    const top = current[0];
    if (top && top.id === t.id && top.title === title && Date.now() - top.at < 60_000) return;
    const entry: RecentEntry = { id: t.id, slug: t.slug, title, at: Date.now() };
    if (cat) entry.cat = cat;
    saveRecent(pushRecent(current, entry, MAX_RECENT_STORED));
  });
  return true;
}

/**
 * How long to keep looking for the heading after `<title>` changed, in
 * cumulative steps. Ember's boot on a hard load can take seconds after
 * DOMContentLoaded — one live screenshot taken 5s after a navigation was still
 * blank — so the ladder reaches ~8s before giving up and settling for
 * `document.title`.
 */
const HEADING_RETRY_MS = [250, 500, 1000, 2000, 4000];

/**
 * Watch `<title>`. Observing `<head>` rather than the title element itself,
 * because at document_start the element may not be parsed yet and `<head>`
 * gathers a handful of mutations per route — far cheaper than the whole
 * document. The first check waits for the parser when it has not reached the
 * title.
 *
 * The dedupe key carries whether the heading is rendered, not just the path
 * and title. Discourse writes the same `document.title` twice per transition,
 * before and after the outlet renders; with the key on path|title alone the
 * second write was dropped as a repeat, so the entry recorded from the first —
 * without the heading — was never replaced. The retry ladder covers the case
 * where no second write comes at all.
 */
function watchRoutes(): () => void {
  let last = "";
  let timer = 0;
  let retry = 0;
  let step = 0;

  const attempt = () => {
    if (recordVisit(step >= HEADING_RETRY_MS.length)) return;
    retry = window.setTimeout(attempt, HEADING_RETRY_MS[step++] ?? 0);
  };
  const check = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const id = topicFromPath(location.pathname)?.id;
      const key = `${location.pathname}|${document.title}|${id !== undefined && !!topicHeading(id)}`;
      if (key === last) return;
      last = key;
      clearTimeout(retry);
      step = 0;
      attempt();
    }, 60);
  };
  let observer: MutationObserver | null = null;
  const start = () => {
    const head = document.head;
    if (!head) return;
    observer = new MutationObserver(check);
    observer.observe(head, { childList: true, subtree: true, characterData: true });
    check();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
  return () => {
    document.removeEventListener("DOMContentLoaded", start);
    observer?.disconnect();
    clearTimeout(timer);
    clearTimeout(retry);
  };
}

// ── Header trigger ──────────────────────────────────────────────────────────

/**
 * A DFP-owned button before Discourse's search icon, labelled with the chord
 * so it doubles as the hint the palette never had on the page. Discourse's
 * own button is left alone: a "Ctrl K" chip on it would have claimed the two
 * open the same thing, and its menu (recent searches, in-topic context) is not
 * this. On a coarse pointer with no hover — no keyboard to press the chord on
 * — the label is a word instead, and the button is the only way in.
 *
 * The header is Glimmer-rendered after boot and the icon list can be replaced
 * on some transitions, so the button is re-placed whenever it is found
 * disconnected. The observer's callback is one `isConnected` read while the
 * button is in place; the two lookups only run while it is not.
 */
function mountTrigger(): () => void {
  let item: HTMLLIElement | null = null;

  const build = (): HTMLLIElement => {
    const li = document.createElement("li");
    li.className = "dfp-palette-item";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dfp-palette-btn";
    /* The chord is in the accessible name only where there is a keyboard to
     * press it on: on a touch device the tooltip advertised Ctrl+K to a screen
     * with no Ctrl, and the visible "Go to" was not contained in the name
     * (WCAG 2.5.3). */
    const coarse = matchMedia("(pointer: coarse) and (hover: none)").matches;
    const label = coarse ? "Go to: search and commands" : `Search and commands (${chord("K")})`;
    b.setAttribute("aria-label", label);
    b.title = coarse ? "Search and commands" : label;
    if (coarse) {
      b.textContent = "Go to";
    } else {
      b.append(el("kbd", undefined, MOD), el("kbd", undefined, "K"));
    }
    b.addEventListener("click", () => show());
    li.appendChild(b);
    return li;
  };

  const place = () => {
    if (item?.isConnected) return;
    const search = document.querySelector<HTMLElement>(".d-header .icons .search-dropdown");
    const icons = search?.parentElement ?? document.querySelector<HTMLElement>(".d-header .icons");
    if (!icons) return;
    item ??= build();
    if (search) search.before(item);
    else icons.prepend(item);
  };

  const observer = new MutationObserver(place);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  place();

  return () => {
    observer.disconnect();
    item?.remove();
    item = null;
  };
}

// ── Mount ───────────────────────────────────────────────────────────────────

function attach(): void {
  attached = true;
  // Capture, so Discourse's own shortcut handlers do not see ⌘K first.
  addEventListener("keydown", onKeydown, { capture: true });
  detachFns.push(() => removeEventListener("keydown", onKeydown, { capture: true }));
  detachFns.push(mountTrigger());
}

function detach(): void {
  attached = false;
  close();
  for (const fn of detachFns.splice(0)) fn();
}

function startRecorder(): void {
  recording = true;
  recorderFns.push(watchRoutes());

  // Another tab's visits, so the list is one list.
  const onStore = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && changes[RECENT_KEY]) recent = sanitizeRecent(changes[RECENT_KEY].newValue);
  };
  chrome.storage.onChanged.addListener(onStore);
  recorderFns.push(() => chrome.storage.onChanged.removeListener(onStore));
}

/**
 * Everything startRecorder() started, plus the browsing record itself: a
 * switched-off recorder that kept a list of what you read would be the wrong
 * kind of off. Runs on the master switch and the palette flag too, since
 * `recentEnabled` folds both in.
 */
function stopRecorder(): void {
  recording = false;
  for (const fn of recorderFns.splice(0)) fn();
  clearRecent();
}

function sync(): void {
  if (!settings) return;
  const on = paletteEnabled(settings);
  const rec = recentEnabled(settings);
  try {
    if (on && !attached) attach();
    else if (!on && attached) detach();
    if (rec && !recording) startRecorder();
    else if (!rec && recording) stopRecorder();
  } catch (err) {
    // Runs inside a settings promise, past the mount's own try/catch in
    // isolated.content.ts; a throw here must not become an unhandled rejection.
    console.warn("[DFP] command-palette failed to attach", err);
  }
}

/**
 * Gated on the master switch and the two module flags, lazily: nothing is
 * attached until settings resolve, and a change from any surface attaches or
 * detaches in place. `getSettings` never rejects (it returns the defaults when
 * storage is unreachable), so the palette is on unless someone turned it off.
 */
export function mountCommandPalette(d: PaletteDeps = {}): void {
  deps = d;
  void getSettings().then((s) => {
    settings = s;
    sync();
  });
  onSettingsChanged((s) => {
    settings = s;
    sync();
  });
}
