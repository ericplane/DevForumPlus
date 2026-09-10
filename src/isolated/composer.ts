import { getSettings, onSettingsChanged } from "../core/settings";
import { isModuleEnabled, type DfpSettings, type ModuleId } from "../core/settings-schema";
import { looksLikeLuauText } from "../luau/sniff";

/**
 * Composer features (PLAN.md §7.5): duplicate detection, the draft vault, a
 * Luau code-block button, and a fence for pasted Luau.
 *
 * Isolated world — it renders DFP UI and needs `chrome.storage` for drafts.
 *
 * Verified composer DOM on the live forum:
 *   #reply-control.open.composer-action-createTopic
 *     .composer-fields          → contains input#reply-title
 *     .d-editor
 *       .d-editor-button-bar    → 12 buttons
 *       textarea.d-editor-input
 *       .d-editor-preview
 *   #reply-control.open.composer-action-reply
 *     .composer-fields          → present but EMPTY: there is no title input
 *     .reply-to                 → who is being answered
 *     .d-editor                 → identical to the above
 *
 * The first class is Discourse's `composeState`, bound as ONE class on the
 * node, so the states are siblings and never stack: `open`, `fullscreen`,
 * `saving` (the 40px "Saving" bar while the request is out — measured, and
 * transcribed into tests/visual/fixture.html), `draft` (minimised to the
 * "Draft in progress" bar) and `closed`. `fullscreen` is read off Discourse's
 * composer model (`toggleFullscreen` flips OPEN ↔ FULLSCREEN) rather than
 * measured; the other four were. See `composerState`.
 *
 * That second shape matters. The wiring used to require BOTH a title and a
 * body input and silently bail otherwise, so the Luau button and the draft
 * vault only ever attached to a new-topic composer — the one people open
 * least. Every reply went without. Only duplicate detection needs a title.
 *
 * Also verified: typing a title with obvious near-duplicates produces **no**
 * similar-topics UI of Discourse's own — `.similar-topics`, `.composer-popup`
 * and `.education-message` are all absent. The endpoint works and nothing
 * surfaces it, exactly as §7.5 #35 claimed.
 *
 * ── The `composer` switch ───────────────────────────────────────────────────
 * Everything here answers to one module id, because the README promises every
 * feature can be turned off and the similar-topics request per title edit was
 * the one thing that could not be. The master switch counts too: with
 * `settings.enabled` off, root-attrs.ts removes `data-dfp` and every rule in
 * reading.css no-ops, so anything rendered here would land as a bare, unstyled
 * `<aside>` inside Discourse's composer — and the request would keep firing.
 * The isolated world has no registry, so the switch is read here — lazily, the
 * first time wire() has a composer to wire. mountComposer runs at
 * document_start, before chrome.storage has answered, and the composer cannot
 * open before Ember boots, so nobody waits for the read. A disable while the
 * composer is open removes what was rendered; the input listeners stay bound
 * and check the flag, which is cheaper than unbinding them and safe to leave.
 * What is cleared is the "offered" mark on the textarea, so re-enabling
 * offers the unsent draft again instead of waiting for the next open.
 */

const MODULE_ID: ModuleId = "composer";

const DUPES_MARK = "data-dfp-dupes";
/**
 * Read by topic-preview.ts, which opens its hover card for any anchor carrying
 * it anywhere in the document. The dupes rows carry it so a match shows its
 * age — `similar_to.json` has no date, and a 2019 "solved" duplicate is the
 * case where a fresh thread is the better outcome.
 */
const TOPIC_ATTR = "data-dfp-topic";
const TITLE_DEBOUNCE = 600;
const DRAFT_DEBOUNCE = 900;
const MIN_TITLE = 12;
/** The single-slot key drafts used to live under. Folded into DRAFTS_KEY once. */
const DRAFT_KEY = "dfp:draft";
const DRAFTS_KEY = "dfp:drafts";
/** A draft older than this is noise, not a rescue. */
const DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
/** More contexts than anyone writes in at once; the oldest goes first. */
const DRAFT_SLOTS = 10;

interface SimilarTopic {
  topic_id: number;
  blurb?: string;
  url?: string;
}

interface TopicSummary {
  id: number;
  title?: string;
  fancy_title?: string;
  posts_count?: number;
  has_accepted_answer?: boolean;
}

interface Draft {
  title: string;
  body: string;
  at: number;
}

/** What the old single slot held. `path` and `kind` were its scoping. */
interface LegacyDraft extends Draft {
  path: string;
  kind?: "topic" | "reply";
}

/** Context key → the draft written there. */
type DraftStore = Record<string, Draft>;

/**
 * The topic id in a path, or null. The optional slug arm refuses to match a
 * bare number so `/t/4738905/85` reads as topic 4738905, not topic 85 — the
 * same guard topic-preview.ts needs, for the same reason.
 */
export function topicOf(path: string): string | null {
  const m = /^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?(\d+)(?:[/?#]|$)/.exec(path);
  return m?.[1] ?? null;
}

/**
 * Which slot a composer's draft lives in — `new-topic`, `pm`, or `topic:<id>`
 * for a reply — and null where nothing should be kept.
 *
 * One key for every composer was the previous shape, and two tabs overwrote
 * each other: the reply half-written in one was gone the moment a title was
 * typed in the other. Discourse's own server drafts are already keyed this
 * way (`new_topic`, `topic_<id>`), which is a fair sign it is the right grain.
 *
 * `action` is the `composer-action-*` class on `#reply-control`, and `path` the
 * best-known topic path: the header link inside `.reply-to` where there is
 * one, because the composer stays open across navigation and
 * `location.pathname` may be `/latest` while the reply still belongs to a
 * topic. Edits get no slot at all. They were saved as replies before, and an
 * edit composer opens pre-filled so the draft could never be offered back into
 * one — it could only be offered into a later REPLY on the same topic, as a
 * new post made of somebody's half-edited old one.
 */
export function draftContext(
  action: string | null,
  hasTitleField: boolean,
  path: string,
): string | null {
  switch (action) {
    case "createTopic":
      return "new-topic";
    case "privateMessage":
      return "pm";
    case "edit":
      return null;
    case "reply":
      return `topic:${topicOf(path) ?? path}`;
  }
  return hasTitleField ? "new-topic" : `topic:${topicOf(path) ?? path}`;
}

/**
 * Drop what has expired, then the oldest until the store fits. Pure, so the
 * cap and the TTL can be checked without storage.
 */
export function pruneDrafts(store: DraftStore, now: number): DraftStore {
  const live = Object.entries(store).filter(([, d]) => now - d.at <= DRAFT_TTL);
  live.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(live.slice(0, DRAFT_SLOTS));
}

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Discourse's `composeState`, with `fullscreen` folded into `open` because it
 * is the same editor at a different size — the same inputs, toolbar and
 * Create button — and everything here that needs a host needs it there too.
 */
export type ComposerState = "open" | "saving" | "draft" | "closed";

/**
 * Which state `#reply-control` is in, from its class attribute.
 *
 * "Open" used to be `#reply-control.open`, and the absence of that class was
 * read as closed. But the state is ONE class on the node, so the Create click
 * swapped `open` for `saving` and the "closed" branch ran with the request
 * still in flight — spending the draft before the server had answered, the
 * same outcome as the old 1.5 s timer, only sooner. Minimising (`draft`) and
 * fullscreen took the same wrong branch. Absent or unrecognised is closed:
 * Discourse renders the node once, closed, at boot.
 */
export function composerState(className: string | null | undefined): ComposerState {
  const classes = new Set((className ?? "").split(/\s+/));
  if (classes.has("open") || classes.has("fullscreen")) return "open";
  if (classes.has("saving")) return "saving";
  if (classes.has("draft")) return "draft";
  return "closed";
}

const composerNode = () => document.getElementById("reply-control");
/** The composer while it can be written in, or null. See `composerState`. */
const composer = (): HTMLElement | null => {
  const node = composerNode();
  return node && composerState(node.className) === "open" ? node : null;
};
const titleInput = () => document.querySelector<HTMLInputElement>("#reply-title");
/* Scoped to the composer, because `.d-editor-input` is also the "About me"
 * editor on the preferences page and the category description editor, and
 * a document-wide query took the first in DOM order — which put the paste
 * listener, the Luau button's insertion and undo on the wrong textarea when
 * a composer was opened over one of them. The title input is an id.
 *
 * And a textarea only. Discourse 3.5's rich-text composer — ProseMirror, a
 * per-user toggle on the toolbar — renders `div.d-editor-input.ProseMirror`,
 * a contenteditable with no textarea, under the same button bar and `.code`
 * button. Everything here that writes to the body reads `selectionStart`,
 * calls the native value setter or `setSelectionRange`, and each of those
 * throws `Illegal invocation` on a div. The live measurement covered the
 * markdown composer only, so in rich mode the button, the paste fence and
 * the vault stay out of the composer rather than landing a control that
 * throws when clicked. */
const bodyInput = (): HTMLTextAreaElement | null => {
  const n = composerNode()?.querySelector(".d-editor-input");
  return n instanceof HTMLTextAreaElement ? n : null;
};

/** The draft slot the open composer writes to. See `draftContext`. */
function contextOf(host: HTMLElement): string | null {
  const action = /\bcomposer-action-(\w+)/.exec(host.className)?.[1] ?? null;
  const where =
    host.querySelector<HTMLAnchorElement>('.reply-to a[href^="/t/"]')?.getAttribute("href") ??
    location.pathname;
  return draftContext(action, titleInput() !== null, where);
}

// ── Module gate ─────────────────────────────────────────────────────────────

/** `null` until storage has answered once. */
let enabled: boolean | null = null;
let settingsAsked = false;

function applySettings(settings: DfpSettings): void {
  enabled = settings.enabled && isModuleEnabled(settings, MODULE_ID);
  if (!enabled) teardown();
}

function readSettings(): void {
  if (settingsAsked) return;
  settingsAsked = true;
  void getSettings().then((settings) => {
    applySettings(settings);
    wire();
  });
}

/**
 * Everything this module rendered, gone; nothing it bound, touched. The
 * "offered" mark is separate from the "bound" mark for this reason: the
 * listeners must stay (unbinding and rebinding them is how they double), but
 * the draft banner must be offered again on re-enable, and it was not —
 * it only came back with the next open's fresh textarea.
 */
function teardown(): void {
  clearTimeout(dupeTimer);
  clearTimeout(draftTimer);
  dismissFenceNote();
  for (const n of document.querySelectorAll(
    `[${DUPES_MARK}], .dfp-draft, .dfp-luau-btn, .dfp-fence-note`,
  )) {
    n.remove();
  }
  for (const n of document.querySelectorAll<HTMLElement>("[data-dfp-offered]")) {
    delete n.dataset.dfpOffered;
  }
}

// ── #35 Duplicate detection ─────────────────────────────────────────────────

let dupeTimer = 0;
let dupeGeneration = 0;
/** Titles already answered, so retyping a character does not refetch. */
const dupeCache = new Map<string, { sim: SimilarTopic[]; topics: TopicSummary[] }>();

async function fetchSimilar(
  title: string,
  raw: string,
): Promise<{ sim: SimilarTopic[]; topics: TopicSummary[] } | null> {
  const key = title.trim().toLowerCase();
  const hit = dupeCache.get(key);
  if (hit) return hit;

  const url =
    `/topics/similar_to.json?title=${encodeURIComponent(title)}` +
    `&raw=${encodeURIComponent(raw.slice(0, 400))}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    similar_topics?: SimilarTopic[];
    topics?: TopicSummary[];
  } | null;
  if (!data) return null;

  const out = { sim: data.similar_topics ?? [], topics: data.topics ?? [] };
  dupeCache.set(key, out);
  if (dupeCache.size > 20) dupeCache.delete(dupeCache.keys().next().value as string);
  return out;
}

function renderDupes(result: { sim: SimilarTopic[]; topics: TopicSummary[] }): void {
  const host = composer();
  const anchor = host?.querySelector(".composer-fields");
  if (!host || !anchor) return;

  host.querySelector(`[${DUPES_MARK}]`)?.remove();
  if (!result.sim.length) return;

  /* `similar_topics` carries the blurb and the id but NO title; `topics` runs
   * alongside it with the titles and the solved flag. Verified on the live
   * endpoint — joining them is the only way to render a useful row. */
  const byId = new Map(result.topics.map((t) => [t.id, t]));

  const box = el("aside", "dfp-dupes");
  box.setAttribute(DUPES_MARK, "1");

  const head = el("div", "dfp-dupes__head");
  head.append(el("span", "dfp-dupes__label", "Already asked?"));
  const dismiss = el("button", "dfp-dupes__dismiss", "Dismiss") as HTMLButtonElement;
  dismiss.type = "button";
  dismiss.addEventListener("click", () => {
    box.remove();
    // Stop re-suggesting for this composer session once waved off.
    dupeGeneration++;
    dismissed = true;
  });
  head.append(dismiss);
  box.append(head);

  for (const s of result.sim.slice(0, 4)) {
    const t = byId.get(s.topic_id);
    const row = document.createElement("a");
    row.className = "dfp-dupes__row";
    row.href = s.url ?? `/t/${s.topic_id}`;
    row.target = "_blank";
    row.rel = "noopener noreferrer";
    row.setAttribute(TOPIC_ATTR, String(s.topic_id));

    row.append(el("span", "dfp-dupes__title", decodeEntities(t?.fancy_title || t?.title || `Topic ${s.topic_id}`)));
    const meta = el("span", "dfp-dupes__meta");
    /* The solved flag is the reason this is worth showing at all: an existing
     * thread with an accepted answer is a better outcome than a new thread. */
    if (t?.has_accepted_answer) meta.append(el("span", "dfp-dupes__solved", "solved"));
    if (t?.posts_count) meta.append(el("span", undefined, `${t.posts_count} replies`));
    row.append(meta);
    box.append(row);
  }

  anchor.after(box);
}

let dismissed = false;

function scheduleDupes(): void {
  if (!enabled || dismissed) return;
  clearTimeout(dupeTimer);
  const gen = ++dupeGeneration;
  dupeTimer = window.setTimeout(() => {
    const title = titleInput()?.value ?? "";
    const raw = bodyInput()?.value ?? "";
    // Below this a title is too generic to match anything useful, and every
    // keystroke would be a request.
    if (title.trim().length < MIN_TITLE) {
      composer()?.querySelector(`[${DUPES_MARK}]`)?.remove();
      return;
    }
    void fetchSimilar(title, raw).then((r) => {
      if (!r || gen !== dupeGeneration || dismissed) return;
      renderDupes(r);
    });
  }, TITLE_DEBOUNCE);
}

// ── #36 Draft vault ─────────────────────────────────────────────────────────

let draftTimer = 0;

/**
 * The context whose draft a submit is about to spend, or null.
 *
 * A submitted post is not a lost draft, and the vault used to be wiped 1.5 s
 * after the Create click whatever came of it — so a 422 (title too short,
 * rate-limited, "body is too similar") lost the copy at the exact moment it
 * was needed. So the click (or Ctrl+Enter) only NAMES the context, and what
 * the composer does next decides — `settleSubmit`, run from wire() on every
 * state change. Discourse's save goes `open → saving → closed` when the server
 * accepted the post and `open → saving → open` when it refused, with the text
 * intact: the return to open is the refusal, and it withdraws the name. Any
 * click or keystroke inside the composer withdraws it too: after a failure the
 * author is editing again, or cancelling, and neither is a submit.
 */
let submitted: string | null = null;
/** A submit named and its request out — `saving` seen, outcome unknown. */
let inFlight = false;

/**
 * One step of the submit bookkeeping, pure so the sequences can be checked.
 *
 * `saving` only records that the request is out. `draft` (minimised) changes
 * nothing: the text is still there and comes back on click. `closed` spends
 * the named context — Discourse closes the composer on its own only when the
 * post saved — and `open` after `saving` is the server's refusal, which
 * withdraws the name so a later close keeps the copy. A close that never
 * passed through `saving` still spends a named context: the click was on an
 * enabled Create button, and the observer reads the node's current class, so
 * the two flips can collapse into one callback that sees only `closed`.
 */
export function settleSubmit(
  state: ComposerState,
  submitted: string | null,
  inFlight: boolean,
): { submitted: string | null; inFlight: boolean; spend: string | null } {
  switch (state) {
    case "saving":
      return { submitted, inFlight: true, spend: null };
    case "draft":
      return { submitted, inFlight, spend: null };
    case "closed":
      return { submitted: null, inFlight: false, spend: submitted };
    case "open":
      return inFlight ? { submitted: null, inFlight: false, spend: null } : { submitted, inFlight, spend: null };
  }
}

/** Storage is shared with other versions of this extension; nothing read from it is trusted. */
function isDraft(v: unknown): v is Draft {
  const d = v as Partial<Draft> | null;
  return (
    typeof d === "object" &&
    d !== null &&
    typeof d.title === "string" &&
    typeof d.body === "string" &&
    typeof d.at === "number"
  );
}

/**
 * The single slot from before, folded into the store under the context it
 * would have had: a titled draft (or one marked `topic`) was a new topic, an
 * untitled one a reply to the topic in its path. A reply with no topic in its
 * path has nowhere to go and is dropped, and a slot already written is never
 * overwritten by the older copy. Anything that is not a draft changes
 * nothing — a stored `null` included, which `!== undefined` used to let
 * through to a destructure that threw before the key was removed, so every
 * later read threw too and the vault was silently dead for that profile.
 * Pure; the caller removes the key.
 */
export function foldLegacyDraft(drafts: DraftStore, legacy: unknown): DraftStore {
  if (!isDraft(legacy)) return drafts;
  const { kind, path } = legacy as Draft & Partial<LegacyDraft>;
  const was = kind ?? (legacy.title.trim() ? "topic" : "reply");
  const id = typeof path === "string" ? topicOf(path) : null;
  const ctx = was === "topic" ? "new-topic" : id ? `topic:${id}` : null;
  if (ctx && !drafts[ctx]) drafts[ctx] = { title: legacy.title, body: legacy.body, at: legacy.at };
  return drafts;
}

/**
 * Every draft, with the single slot from before folded in under the context
 * it would have had. The old key is removed once read, whatever it held.
 */
async function loadDrafts(): Promise<DraftStore> {
  const store = await chrome.storage.local.get([DRAFTS_KEY, DRAFT_KEY]);
  const raw = store[DRAFTS_KEY] as Record<string, unknown> | undefined;
  const drafts: DraftStore = {};
  for (const [ctx, d] of Object.entries(raw ?? {})) if (isDraft(d)) drafts[ctx] = d;

  const legacy: unknown = store[DRAFT_KEY];
  if (legacy !== undefined) {
    foldLegacyDraft(drafts, legacy);
    void chrome.storage.local.remove(DRAFT_KEY).catch(() => {});
  }
  return drafts;
}

/**
 * Every read-modify-write of the store, in the order it was asked for.
 *
 * saveDraft, removeDraft and the spend in wire() each read the map, change
 * one slot and write it back, and as independent cycles a debounced save
 * whose read landed before a fast submit's remove could write the just-posted
 * draft back after the spend — and the next empty composer in that context
 * offered an "unsent draft" of a post that was sent. The window was one
 * storage round-trip, a few ms, and chaining every cycle on one promise
 * closes it at no cost. Two tabs writing the same slot still race, and that
 * is accepted: the loser is a stale banner with a Discard button.
 */
let vault: Promise<unknown> = Promise.resolve();
function withDrafts<T>(fn: (drafts: DraftStore) => T | Promise<T>): Promise<T> {
  const next = vault.then(() => loadDrafts()).then(fn);
  vault = next.catch(() => undefined);
  return next;
}

/**
 * Persist the composer to extension storage.
 *
 * Discourse has server drafts, but this is about the case they do not cover:
 * the tab closing, the browser crashing, or a stray navigation taking a
 * half-written post with it. Local, so it survives all three, and keyed by
 * context so a draft is offered back into the composer it came from and no
 * other.
 */
function saveDraft(): void {
  if (!enabled) return;
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    const host = composer();
    const ctx = host && contextOf(host);
    if (!ctx) return;
    const title = titleInput()?.value ?? "";
    const body = bodyInput()?.value ?? "";
    if (!title.trim() && body.trim().length < 40) return;
    void withDrafts((drafts) => {
      drafts[ctx] = { title, body, at: Date.now() };
      return chrome.storage.local.set({ [DRAFTS_KEY]: pruneDrafts(drafts, Date.now()) });
    }).catch(() => {});
  }, DRAFT_DEBOUNCE);
}

function removeDraft(ctx: string): void {
  void withDrafts((drafts) => {
    delete drafts[ctx];
    return chrome.storage.local.set({ [DRAFTS_KEY]: drafts });
  }).catch(() => {});
}

function offerDraft(): void {
  if (!enabled) return;
  const host = composer();
  const anchor = host?.querySelector(".composer-fields");
  if (!host || !anchor || host.querySelector(".dfp-draft")) return;
  const ctx = contextOf(host);
  if (!ctx) return;

  // Through the queue, so a remove asked for just before is seen.
  void withDrafts((drafts) => drafts[ctx]).then((draft) => {
    if (!draft) return;
    if (Date.now() - draft.at > DRAFT_TTL) {
      removeDraft(ctx);
      return;
    }
    // Only offer into an empty composer — never over something being written.
    const t = titleInput();
    const b = bodyInput();
    if (!b || t?.value.trim() || b.value.trim()) return;
    if (!draft.title.trim() && !draft.body.trim()) return;

    const box = el("aside", "dfp-draft");
    const when = new Date(draft.at).toLocaleString();
    box.append(
      el("span", "dfp-draft__text", `Unsent draft from ${when}: “${draft.title.slice(0, 48) || draft.body.slice(0, 48)}…”`),
    );

    const restore = el("button", "dfp-draft__restore", "Restore") as HTMLButtonElement;
    restore.type = "button";
    restore.addEventListener("click", () => {
      if (t) setNative(t, draft.title);
      setNative(b, draft.body);
      box.remove();
    });

    const discard = el("button", "dfp-draft__discard", "Discard") as HTMLButtonElement;
    discard.type = "button";
    discard.addEventListener("click", () => {
      removeDraft(ctx);
      box.remove();
    });

    box.append(restore, discard);
    anchor.after(box);
  }).catch(() => {});
}

/**
 * Set a value the way a user would.
 *
 * Ember binds these inputs, so assigning `.value` directly updates the DOM and
 * leaves the model stale — the post would submit empty. Going through the
 * native setter and firing `input` is what makes Ember observe the change.
 */
function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// ── #37 Luau code block button ──────────────────────────────────────────────

/**
 * Wrap `[start, end)` of `value` in a Luau fence. The fence starts on its own
 * line, and `caret` lands just inside it with `length` characters selected —
 * the selection that was there, or nothing, so typing begins where the code
 * goes either way.
 */
export function luauFence(
  value: string,
  start: number,
  end: number,
): { value: string; caret: number; length: number } {
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const block = `${lead}\`\`\`lua\n${selected}\n\`\`\`\n`;
  return {
    value: before + block + after,
    caret: before.length + lead.length + "```lua\n".length,
    length: selected.length,
  };
}

/**
 * One button, not a toolbar rewrite.
 *
 * The plan asked for code blocks, tables, details and callouts. Discourse's bar
 * already has 12 buttons including a generic code button; what it lacks on a
 * Roblox forum is a *pre-tagged* Luau fence, which is what makes M3's
 * highlighting and deprecation marks fire. The rest would be buttons competing
 * with buttons that already exist.
 *
 * It sits right after that generic code button, which it specialises, rather
 * than at the end of the bar after the gear where it first landed — and it is
 * a text button, so it no longer carries Discourse's `no-text` class. With it
 * the button took the icon-only colour rule in controls.css and read as a lone
 * word in a row of icons; the toolbar's own sizing rule applies to every
 * `.btn` in the bar and needs nothing from that class.
 */
function addLuauButton(): void {
  const bar = composer()?.querySelector(".d-editor-button-bar");
  if (!bar || bar.querySelector(".dfp-luau-btn")) return;

  const b = el("button", "btn btn-flat dfp-luau-btn") as HTMLButtonElement;
  b.type = "button";
  b.title = "Insert a Luau code block";
  b.setAttribute("aria-label", "Insert a Luau code block");
  /* The fence it types, as its glyph: three ticks in the mono face. It is
   * decorative — the accessible name is the label above. */
  const glyph = el("span", "dfp-luau-btn__glyph", "```");
  glyph.setAttribute("aria-hidden", "true");
  b.append(glyph, "Luau");
  b.addEventListener("click", () => {
    const ta = bodyInput();
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const fenced = luauFence(ta.value, start, end);
    setNative(ta, fenced.value);
    ta.focus();
    ta.setSelectionRange(fenced.caret, fenced.caret + fenced.length);
  });

  /* Discourse names each toolbar button by its id (`className || id` in its
   * toolbar builder), so the generic code button is `.code`. Falling back to
   * the end of the bar keeps the button reachable if a plugin renames it. */
  const code = bar.querySelector(".code");
  if (code) code.after(b);
  else bar.appendChild(b);
}

// ── Paste-to-fence ──────────────────────────────────────────────────────────

/**
 * Code pasted straight out of Studio arrives as text/plain with no fence, and
 * code-intel.ts records that unfenced code is the common case in Scripting
 * Support — DFP spends a whole heuristic repairing it at read time. The paste
 * is the one moment it can be fixed for free, so a paste that reads as Luau
 * lands fenced, with an undo at the end of the toolbar that stays until the
 * author types again (see `fenceNoteStays`).
 *
 * Fencing rather than asking: an advisory chip ("looks like Luau — wrap it?")
 * was the first shape, and it is a second decision on every paste for the
 * common case, against one click to reverse the rare wrong one. Nothing is
 * posted by this; it edits text the author is still holding.
 *
 * What it refuses: fewer than three lines (one-liners belong inline), text
 * that already carries a fence, a caret that is already inside one, a
 * clipboard that also holds `<pre>` HTML (Discourse's own paste handler turns
 * that into a fence itself), and anything with files attached — an image.
 *
 * The listener is capturing, so it runs before Discourse's, which is bound on
 * the same textarea earlier. Discourse's handler does not check
 * `defaultPrevented`, and on plain text it has one trick of its own: a paste
 * whose lines all hold the same number of tabs becomes a markdown TABLE —
 * which is what tab-indented Luau looks like. So a handled paste also stops
 * immediate propagation; an unhandled one falls through untouched.
 */

/** The note stays at least this long, whatever the author types meanwhile. */
const FENCE_NOTE_FLOOR_MS = 5000;
const MIN_PASTE_LINES = 3;
/** A fence opener at the start of a line — the shape markdown-it honours. */
const FENCE_LINE = /(?:^|\n)[ \t]{0,3}(?:```|~~~)/;

/** An odd number of line-start fences before the caret means it is in one. */
export function insideFence(value: string, caret: number): boolean {
  return (value.slice(0, caret).split(FENCE_LINE).length - 1) % 2 === 1;
}

/** Whether a paste is Luau worth fencing. See the section note. */
export function wantsLuauFence(text: string): boolean {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (t.split("\n").length < MIN_PASTE_LINES) return false;
  if (FENCE_LINE.test(t)) return false;
  return looksLikeLuauText(t);
}

export interface FencedPaste {
  /** The composer's value with the paste fenced. */
  value: string;
  /** After the closing fence, so what is typed next is prose below the code. */
  caret: number;
  /** Where the block starts in `value`, and the block itself — undo's key. */
  at: number;
  block: string;
  /** The paste as it arrived, which undo puts back in the block's place. */
  text: string;
}

/**
 * Insert `raw` at `[start, end)` of `value`, fenced. Studio copies end in a
 * newline, which inside a fence is a blank last line, so the fenced code is
 * trimmed; the raw text is kept whole for undo.
 */
export function fencePaste(value: string, start: number, end: number, raw: string): FencedPaste {
  const text = raw.replace(/\r\n?/g, "\n");
  const code = text.replace(/\n+$/, "");
  const after = value.slice(end);
  const fenced = luauFence(value.slice(0, start) + code + after, start, start + code.length);
  const block = fenced.value.slice(start, fenced.value.length - after.length);
  return { value: fenced.value, caret: start + block.length, at: start, block, text };
}

/**
 * The raw paste back in the block's place, or null when the block has since
 * been edited — undo then has nothing safe to replace, and does nothing.
 * Typing AFTER the block is fine: the block is checked in place, not the
 * whole value.
 */
export function undoFencedPaste(
  value: string,
  paste: FencedPaste,
): { value: string; caret: number } | null {
  const tail = paste.at + paste.block.length;
  if (value.slice(paste.at, tail) !== paste.block) return null;
  return {
    value: value.slice(0, paste.at) + paste.text + value.slice(tail),
    caret: paste.at + paste.text.length,
  };
}

/**
 * Whether the paste note is still wanted, `elapsedMs` after it went up.
 *
 * It goes once the author has typed or pasted again — the fence is then part
 * of a post being written, and the undo has done its work or been passed
 * over — but never before the floor. The first shape was a five-second
 * ceiling, and it took the only undo away from exactly the author who needs
 * it: one whose eyes are on the textarea, where the fence just landed, rather
 * than the toolbar, and who types straight on. The sniff has plausible prose
 * false positives (three lines with a `then` or a `function` and a bare
 * `end`), so the undo has to be findable after a look down. A note nobody
 * types after stays until the composer closes; it is text at the end of the
 * toolbar and costs nothing there. Undo itself refuses once the block has
 * been edited, so outliving a timer is safe.
 */
export function fenceNoteStays(elapsedMs: number, edited: boolean): boolean {
  return !edited || elapsedMs < FENCE_NOTE_FLOOR_MS;
}

/** Removes the note that is up, and its listeners; a no-op with none up. */
let dismissFenceNote: () => void = () => {};

/**
 * "Fenced as Luau — undo", in the toolbar rather than under it. Under it was
 * the first placement, and it pushed the textarea down while the author was
 * typing into it; at the end of the bar it takes space nobody is using.
 */
function showFenceNote(ta: HTMLTextAreaElement, paste: FencedPaste): void {
  const bar = composer()?.querySelector(".d-editor-button-bar");
  if (!bar) return;
  dismissFenceNote();

  /* Mounted empty and filled a tick later. `role="status"` is a live region,
   * and a live region announces CHANGES to a mounted node: a span inserted
   * with its text already in it is not reliably read by Chrome with NVDA or
   * JAWS, which left the one audience that cannot see the fence land without
   * the notice. A timer rather than requestAnimationFrame, which does not
   * fire in a hidden tab. */
  const note = el("span", "dfp-fence-note");
  note.setAttribute("role", "status");
  const undo = el("button", "dfp-fence-note__undo", "undo") as HTMLButtonElement;
  undo.type = "button";
  undo.addEventListener("click", () => {
    dismissFenceNote();
    const back = undoFencedPaste(ta.value, paste);
    if (!back) return;
    setNative(ta, back.value);
    ta.focus();
    ta.setSelectionRange(back.caret, back.caret);
  });
  bar.append(note);
  const fill = window.setTimeout(() => note.append("Fenced as Luau — ", undo), 0);

  /* The fence's own `input` (setNative, in onPaste) fired before these were
   * bound, so the first edit seen is the author's. A paste fenced over this
   * one calls showFenceNote again, which starts over. */
  const shownAt = Date.now();
  let edited = false;
  const settle = (elapsed = Date.now() - shownAt): void => {
    if (!fenceNoteStays(elapsed, edited)) dismissFenceNote();
  };
  const onEdit = (): void => {
    edited = true;
    settle();
  };
  ta.addEventListener("input", onEdit);
  ta.addEventListener("paste", onEdit);
  const floor = window.setTimeout(() => settle(FENCE_NOTE_FLOOR_MS), FENCE_NOTE_FLOOR_MS);

  dismissFenceNote = () => {
    clearTimeout(fill);
    clearTimeout(floor);
    ta.removeEventListener("input", onEdit);
    ta.removeEventListener("paste", onEdit);
    note.remove();
    dismissFenceNote = () => {};
  };
}

function onPaste(e: ClipboardEvent): void {
  if (!enabled || e.defaultPrevented) return;
  const ta = e.currentTarget;
  const data = e.clipboardData;
  if (!(ta instanceof HTMLTextAreaElement) || !data || data.files.length) return;
  if (/<pre[\s>]/i.test(data.getData("text/html"))) return;
  const text = data.getData("text/plain");
  if (!wantsLuauFence(text)) return;
  const start = ta.selectionStart;
  if (insideFence(ta.value, start)) return;

  e.preventDefault();
  e.stopImmediatePropagation();
  const paste = fencePaste(ta.value, start, ta.selectionEnd, text);
  setNative(ta, paste.value);
  ta.setSelectionRange(paste.caret, paste.caret);
  showFenceNote(ta, paste);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

/**
 * Runs on every mutation inside `#reply-control`, not once per open, and is
 * safe to: each input is marked once it has its listener, and the rest is a
 * few querySelectors. That covers what a one-shot could not — Ember rebuilds
 * the button bar on its own schedule (preview toggle, editor mode), and "reply
 * as linked topic" swaps a title field into a composer that is already open.
 */
function wire(): void {
  const node = composerNode();
  const state = composerState(node?.className);

  // The submit bookkeeping runs on every state, open included — the return to
  // open after `saving` is the refusal. See `submitted`.
  const settled = settleSubmit(state, submitted, inFlight);
  submitted = settled.submitted;
  inFlight = settled.inFlight;
  if (settled.spend) removeDraft(settled.spend);

  if (state !== "open" || !node) {
    // Closed: reset so reopening re-offers duplicates. Saving and minimised
    // are not closed — the text is still Discourse's, and coming back.
    if (state === "closed") dismissed = false;
    return;
  }
  const host = node;
  if (enabled === null) {
    readSettings();
    return;
  }
  if (!enabled) return;

  /* The body is the only input every composer has. A title means a new topic;
   * a reply has none, and must not be turned away for it. No textarea at all
   * is the rich-text editor (see `bodyInput`), and the Luau button waits on
   * the check with everything else: it used to be added first, and in rich
   * mode that put a "```Luau" button in the bar whose click threw. */
  const b = bodyInput();
  if (!b) return;
  addLuauButton();
  const t = titleInput();

  if (t && !t.dataset.dfpWired) {
    t.dataset.dfpWired = "1";
    t.addEventListener("input", () => {
      scheduleDupes();
      saveDraft();
    });
  }
  if (!b.dataset.dfpWired) {
    b.dataset.dfpWired = "1";
    b.addEventListener("input", saveDraft);
    b.addEventListener("paste", onPaste, { capture: true });
  }
  /* Offered once per textarea, on a mark of its own: teardown() clears this
   * one and leaves the listeners, so a disable and re-enable over an open
   * composer offers the draft again without binding anything twice. */
  if (!b.dataset.dfpOffered) {
    b.dataset.dfpOffered = "1";
    offerDraft();
  }

  /* `#reply-control` itself is rendered once and reused for every open, so the
   * submit watch is delegated to it and bound once. Capture, so a handler of
   * Discourse's that stops propagation cannot hide the click or the shortcut.
   *
   * Only a submit that can go names the context. Discourse disables Create
   * while the post cannot be sent (body under the minimum, title too short),
   * and a disabled button dispatches no click — but Ctrl+Enter is a keydown
   * that arrives regardless and is refused inside Discourse's save(), where
   * nothing here can see it. Naming on it left `Ctrl+Enter on a too-short
   * reply → Esc → close from the minimised bar` spending the draft. Escape
   * withdraws for the same reason: it minimises, and a minimised composer is
   * closed from a bar the input listener never hears from. */
  if (!host.dataset.dfpWired) {
    host.dataset.dfpWired = "1";
    const canSubmit = (): boolean => {
      const create = host.querySelector<HTMLButtonElement>(".create");
      return create !== null && !create.disabled;
    };
    host.addEventListener(
      "click",
      (e) => {
        const create = e.target instanceof Element && e.target.closest(".create");
        submitted = enabled && create && canSubmit() ? contextOf(host) : null;
      },
      { capture: true },
    );
    host.addEventListener(
      "keydown",
      (e) => {
        if (!enabled) return;
        if (e.key === "Escape") submitted = null;
        else if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canSubmit()) submitted = contextOf(host);
      },
      { capture: true },
    );
    host.addEventListener("input", () => (submitted = null), { capture: true });
  }
}

/**
 * The composer is Ember-rendered and opens long after load, so it is watched
 * rather than looked up once. Two observers, in turn, and neither is
 * document-wide for long: the first watches only for `#reply-control` to be
 * rendered, which Discourse does once, closed, at boot, and then hands over to
 * one scoped to that node. The previous shape was a single observer on the
 * document root with `attributeFilter: ["class"]` and `subtree`, which ran
 * wire()'s querySelectors on every class flip Discourse makes anywhere on the
 * page, for the life of the page. Scoped, a closed composer is an empty node
 * and costs nothing.
 *
 * If Discourse ever replaced the node the inner observer would go quiet; it
 * renders the composer container once in the application template and never
 * re-renders it, so that is accepted rather than watched for.
 */
export function mountComposer(): void {
  onSettingsChanged((settings) => {
    applySettings(settings);
    if (enabled) wire();
  });

  const inner = new MutationObserver(() => wire());
  const adopt = (): boolean => {
    const host = document.getElementById("reply-control");
    if (!host) return false;
    inner.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    wire();
    return true;
  };
  if (adopt()) return;

  const outer = new MutationObserver(() => {
    if (adopt()) outer.disconnect();
  });
  outer.observe(document.documentElement, { childList: true, subtree: true });
}
