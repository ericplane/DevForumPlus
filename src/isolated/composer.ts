/**
 * Composer features (PLAN.md §7.5): duplicate detection, the draft vault, and
 * a Luau code-block button.
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
 *
 * Also verified: typing a title with obvious near-duplicates produces **no**
 * similar-topics UI of Discourse's own — `.similar-topics`, `.composer-popup`
 * and `.education-message` are all absent. The endpoint works and nothing
 * surfaces it, exactly as §7.5 #35 claimed.
 */

const DUPES_MARK = "data-dfp-dupes";
const TITLE_DEBOUNCE = 600;
const DRAFT_DEBOUNCE = 900;
const MIN_TITLE = 12;
const DRAFT_KEY = "dfp:draft";
/** A draft older than this is noise, not a rescue. */
const DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;

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
  path: string;
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

const composer = () => document.querySelector<HTMLElement>("#reply-control.open");
const titleInput = () => document.querySelector<HTMLInputElement>("#reply-title");
const bodyInput = () => document.querySelector<HTMLTextAreaElement>(".d-editor-input");

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
  if (dismissed) return;
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
 * Persist the composer to extension storage.
 *
 * Discourse has server drafts, but they are single-slot and this is about the
 * case they do not cover: the tab closing, the browser crashing, or a stray
 * navigation taking a half-written post with it. Local, so it survives all
 * three, and scoped to the path so a draft does not reappear on an unrelated
 * topic.
 */
function saveDraft(): void {
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    const title = titleInput()?.value ?? "";
    const body = bodyInput()?.value ?? "";
    if (!title.trim() && body.trim().length < 40) return;
    const draft: Draft = { title, body, at: Date.now(), path: location.pathname };
    void chrome.storage.local.set({ [DRAFT_KEY]: draft }).catch(() => {});
  }, DRAFT_DEBOUNCE);
}

function clearDraft(): void {
  void chrome.storage.local.remove(DRAFT_KEY).catch(() => {});
}

function offerDraft(): void {
  const host = composer();
  const anchor = host?.querySelector(".composer-fields");
  if (!host || !anchor || host.querySelector(".dfp-draft")) return;

  void chrome.storage.local.get(DRAFT_KEY).then((store) => {
    const draft = store[DRAFT_KEY] as Draft | undefined;
    if (!draft) return;
    if (Date.now() - draft.at > DRAFT_TTL) {
      clearDraft();
      return;
    }
    // Only offer into an empty composer — never over something being written.
    const t = titleInput();
    const b = bodyInput();
    if (!t || !b || t.value.trim() || b.value.trim()) return;
    if (!draft.title.trim() && !draft.body.trim()) return;

    const box = el("aside", "dfp-draft");
    const when = new Date(draft.at).toLocaleString();
    box.append(
      el("span", "dfp-draft__text", `Unsent draft from ${when}: “${draft.title.slice(0, 48) || draft.body.slice(0, 48)}…”`),
    );

    const restore = el("button", "dfp-draft__restore", "Restore") as HTMLButtonElement;
    restore.type = "button";
    restore.addEventListener("click", () => {
      setNative(t, draft.title);
      setNative(b, draft.body);
      box.remove();
    });

    const discard = el("button", "dfp-draft__discard", "Discard") as HTMLButtonElement;
    discard.type = "button";
    discard.addEventListener("click", () => {
      clearDraft();
      box.remove();
    });

    box.append(restore, discard);
    anchor.after(box);
  });
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
 * One button, not a toolbar rewrite.
 *
 * The plan asked for code blocks, tables, details and callouts. Discourse's bar
 * already has 12 buttons including a generic code button; what it lacks on a
 * Roblox forum is a *pre-tagged* Luau fence, which is what makes M3's
 * highlighting and deprecation marks fire. The rest would be buttons competing
 * with buttons that already exist.
 */
function addLuauButton(): void {
  const bar = composer()?.querySelector(".d-editor-button-bar");
  if (!bar || bar.querySelector(".dfp-luau-btn")) return;

  const b = el("button", "btn btn-flat no-text dfp-luau-btn", "Luau") as HTMLButtonElement;
  b.type = "button";
  b.title = "Insert a Luau code block";
  b.addEventListener("click", () => {
    const ta = bodyInput();
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const selected = ta.value.slice(start, end);
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    const block = `${lead}\`\`\`lua\n${selected || ""}\n\`\`\`\n`;
    setNative(ta, before + block + after);
    // Land the caret inside the fence, where the code goes.
    const caret = before.length + lead.length + 7;
    ta.focus();
    ta.setSelectionRange(caret, caret + selected.length);
  });
  bar.appendChild(b);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

let wired: HTMLElement | null = null;

function wire(): void {
  const host = composer();
  if (!host) {
    // Composer closed: reset so reopening re-offers and re-attaches.
    wired = null;
    dismissed = false;
    return;
  }
  if (wired === host) return;
  wired = host;

  const t = titleInput();
  const b = bodyInput();
  if (!t || !b) {
    wired = null;
    return;
  }

  t.addEventListener("input", () => {
    scheduleDupes();
    saveDraft();
  });
  b.addEventListener("input", saveDraft);

  addLuauButton();
  offerDraft();

  /* A submitted post is not a lost draft. Discourse closes the composer on
   * success, and the click is the last moment we can see it. */
  host.querySelector(".create")?.addEventListener("click", () => setTimeout(clearDraft, 1500));
}

export function mountComposer(): void {
  // The composer is Ember-rendered and opens long after load, so it is watched
  // rather than looked up once.
  const observer = new MutationObserver(() => wire());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  wire();
}
