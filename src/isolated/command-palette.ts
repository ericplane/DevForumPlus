/**
 * Command palette, instant search, and filter chips (PLAN.md §7.1 #1–#3).
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
 *   local   `/site.json` categories — 72 of them, fetched once, matched
 *           in-memory so category jumps are instant with no request.
 *   remote  `/search.json?q=` debounced. Verified shape: parallel `topics[]`
 *           and `posts[]`, the post carrying the blurb and the topic the title,
 *           slug and tags.
 *
 * Deliberately NOT included: fuzzy matching over read history and bookmarks
 * (PLAN §7.1 #5/#7 are separate P1 features with their own storage), and the
 * `uFuzzy` dependency the plan named — substring-and-prefix ranking over 72
 * categories is not a problem that needs a library.
 */

const HOTKEY = "k";
const DEBOUNCE_MS = 180;
const MAX_LOCAL = 6;
const MAX_REMOTE = 8;

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
}

interface SearchPost {
  topic_id: number;
  blurb?: string;
  username?: string;
  post_number?: number;
}

interface Row {
  kind: "action" | "category" | "topic";
  title: string;
  sub?: string;
  href: string;
  badge?: string;
}

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

// ── State ───────────────────────────────────────────────────────────────────

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLDivElement | null = null;
let chipRow: HTMLDivElement | null = null;
let open = false;
let rows: Row[] = [];
let active = 0;
let debounce = 0;
/** Bumped per keystroke so a slow response cannot overwrite a newer one. */
let generation = 0;
/** True while a remote search is outstanding, so the empty state can say so. */
let pending = false;
let categories: Promise<SiteCategory[]> | null = null;
let restoreFocus: Element | null = null;

function loadCategories(): Promise<SiteCategory[]> {
  categories ??= fetch("/site.json", {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  })
    .then((r) => (r.ok ? (r.json() as Promise<{ categories?: SiteCategory[] }>) : null))
    .then((s) => s?.categories ?? [])
    .catch(() => []);
  return categories;
}

const ACTIONS: Row[] = [
  { kind: "action", title: "Latest", sub: "All recent topics", href: "/latest" },
  { kind: "action", title: "Unread", sub: "Topics you follow", href: "/unread" },
  { kind: "action", title: "Top", sub: "Most active", href: "/top" },
  { kind: "action", title: "My posts", sub: "Topics you posted in", href: "/my/activity" },
  { kind: "action", title: "Bookmarks", sub: "Saved topics", href: "/my/activity/bookmarks" },
  { kind: "action", title: "Categories", sub: "Browse the tree", href: "/categories" },
];

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Rank by where the match lands, not by a similarity score.
 *
 * A prefix match is what someone typing a category name means; a word-start
 * match is second; anywhere else is last. Over 72 categories this is both
 * better and cheaper than fuzzy scoring, which would rank "Studio Bugs" above
 * "Bug Reports" for the query "bug".
 */
function score(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 0;
  const i = h.indexOf(n);
  if (i === -1) return -1;
  if (i === 0) return 3;
  if (/\s|[-/]/.test(h[i - 1] ?? "")) return 2;
  return 1;
}

function localRows(query: string, cats: SiteCategory[]): Row[] {
  const q = query.replace(/\S+:\S*/g, "").trim();
  if (!q) {
    return ACTIONS.slice(0, MAX_LOCAL);
  }

  const scored: { row: Row; s: number }[] = [];
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
  return scored.slice(0, MAX_LOCAL).map((x) => x.row);
}

async function remoteRows(query: string): Promise<Row[]> {
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

  return data.topics.slice(0, MAX_REMOTE).map((t) => {
    const post = blurbs.get(t.id);
    const decoded = decodeEntities(t.fancy_title || t.title || "");
    return {
      kind: "topic" as const,
      title: decoded,
      sub: decodeEntities(post?.blurb ?? "").slice(0, 110),
      href: `/t/${t.slug ?? "topic"}/${t.id}`,
      badge: t.has_accepted_answer ? "solved" : undefined,
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
  font-size: 15px;
  border-block-end: 1px solid var(--dfp-border, #333);
}
input::placeholder { color: var(--dfp-text-3, #868a91); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 12px; border-block-end: 1px solid var(--dfp-border, #333); }
.chip {
  all: unset;
  padding: 2px 9px;
  border: 1px solid var(--dfp-border, #333);
  border-radius: 999px;
  color: var(--dfp-text-3, #868a91);
  font-size: 11px;
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
.row .t { color: var(--dfp-text, #eff4fc); font-size: 13.5px; flex: 0 1 auto; }
.row .s { color: var(--dfp-text-3, #868a91); font-size: 11.5px; flex: 1 1 auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .b {
  flex: 0 0 auto; font-size: 10px; padding: 0 6px; border-radius: 999px;
  color: var(--dfp-solved, #1ac972);
  border: 1px solid color-mix(in oklab, var(--dfp-solved, #1ac972) 40%, transparent);
}
.group { padding: 8px 10px 4px; color: var(--dfp-text-3, #868a91); font-size: 10.5px;
  text-transform: uppercase; letter-spacing: .04em; }
.empty { padding: 22px; text-align: center; color: var(--dfp-text-3, #868a91); font-size: 13px; }
.foot {
  display: flex; gap: 14px; padding: 8px 14px;
  border-block-start: 1px solid var(--dfp-border, #333);
  color: var(--dfp-text-3, #868a91); font-size: 11px;
}
kbd {
  font-family: var(--dfp-mono, ui-monospace, monospace);
  border: 1px solid var(--dfp-border, #333); border-radius: 4px;
  padding: 0 4px; font-size: 10px;
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

  input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Search topics, jump to a category…";
  input.setAttribute("aria-label", "Search topics or jump to a category");
  input.addEventListener("input", () => schedule());

  chipRow = el("div", "chips") as HTMLDivElement;
  list = el("div", "list") as HTMLDivElement;

  const foot = el("div", "foot");
  for (const [k, label] of [
    ["↑↓", "navigate"],
    ["⏎", "open"],
    ["⌘⏎", "new tab"],
    ["esc", "close"],
  ] as const) {
    const span = el("span");
    span.append(el("kbd", undefined, k), document.createTextNode(` ${label}`));
    foot.appendChild(span);
  }

  panel.append(input, chipRow, list, foot);
  scrim.appendChild(panel);
  shadow.append(style, scrim);
  document.body.appendChild(host);
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
    list.appendChild(
      el("div", "empty", pending ? "Searching…" : query() ? "No matches" : "Type to search"),
    );
    return;
  }
  let lastKind: string | null = null;
  rows.forEach((r, i) => {
    if (r.kind !== lastKind) {
      lastKind = r.kind;
      list!.appendChild(
        el("div", "group", r.kind === "topic" ? "Topics" : r.kind === "category" ? "Categories" : "Go to"),
      );
    }
    const row = el("div", "row");
    row.dataset["active"] = i === active ? "1" : "0";
    row.append(el("span", "t", r.title));
    if (r.sub) row.append(el("span", "s", r.sub));
    if (r.badge) row.append(el("span", "b", r.badge));
    row.addEventListener("mouseenter", () => {
      active = i;
      paintActive();
    });
    row.addEventListener("click", (e) => go(r, e.metaKey || e.ctrlKey));
    list!.appendChild(row);
  });
}

function paintActive(): void {
  if (!list) return;
  const els = list.querySelectorAll<HTMLElement>(".row");
  els.forEach((e, i) => (e.dataset["active"] = i === active ? "1" : "0"));
  els[active]?.scrollIntoView({ block: "nearest" });
}

function schedule(delay = DEBOUNCE_MS): void {
  clearTimeout(debounce);
  renderChips();
  const gen = ++generation;
  const q = input?.value ?? "";

  // Local matches are synchronous, so the list never sits empty while the
  // network catches up.
  void loadCategories().then((cats) => {
    if (gen !== generation) return;
    rows = localRows(q, cats);
    active = 0;
    renderRows();
  });

  // Only a query long enough to actually search counts as pending; otherwise
  // the empty state would read "Searching…" for one- and two-letter input that
  // never reaches the network.
  pending = q.trim().length >= 3;

  debounce = window.setTimeout(() => {
    void remoteRows(q)
      .then((remote) => {
        if (gen !== generation) return;
        pending = false;
        if (!remote.length) {
          renderRows();
          return;
        }
        void loadCategories().then((cats) => {
          if (gen !== generation) return;
          rows = [...localRows(q, cats), ...remote];
          renderRows();
        });
      })
      .catch(() => {
        if (gen === generation) {
          pending = false;
          renderRows();
        }
      });
  }, delay);
}

function go(row: Row, newTab: boolean): void {
  if (newTab) {
    window.open(row.href, "_blank", "noopener");
    return;
  }
  close();
  location.assign(row.href);
}

// ── Open / close ────────────────────────────────────────────────────────────

function show(): void {
  if (open) return;
  ensureHost();
  open = true;
  restoreFocus = document.activeElement;
  if (host) host.style.display = "";
  if (input) {
    input.value = "";
    input.focus();
  }
  schedule(0);
}

function close(): void {
  if (!open) return;
  open = false;
  clearTimeout(debounce);
  generation++;
  if (host) host.style.display = "none";
  // Put the caret back where it was, or the page becomes unnavigable by keyboard.
  if (restoreFocus instanceof HTMLElement) restoreFocus.focus();
  restoreFocus = null;
}

/** Never steal a keystroke someone is typing into a field. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function mountCommandPalette(): void {
  addEventListener(
    "keydown",
    (e) => {
      // ⌘K / Ctrl+K. Chrome gives Ctrl+K to the omnibox only when the page does
      // not take it, so preventDefault is what makes this work at all.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === HOTKEY) {
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
          close();
          location.assign(`/search?q=${encodeURIComponent(input.value.trim())}`);
        }
        return;
      }
      // Everything else belongs to the input, which already has focus.
      void isTyping(e.target);
    },
    // Capture, so Discourse's own shortcut handlers do not see ⌘K first.
    { capture: true },
  );
}
