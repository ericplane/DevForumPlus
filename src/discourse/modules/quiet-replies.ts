import type { DfpModule } from "../../core/registry";
import type { ModuleId } from "../../core/settings-schema";
import type { PluginApi } from "../types";
import { getCurrentTopic, topicIdFromPath } from "../topic-data";
import { onDomChange } from "../dom-watch";

/**
 * Quiet replies — fold runs of replies that say nothing.
 *
 * The complaint this answers, in the maintainer's words: DevForum threads are
 * padded with "thanks!", "+1", "bump", "did you fix this?", "following". On a
 * 40-reply Scripting Support thread these are most of the scrolling and none of
 * the information.
 *
 * ── Why the rule for "nothing" is this shy ──────────────────────────────────
 * The two failures are not symmetrical. A folded "thanks" that should have been
 * shown costs a click. A folded ANSWER costs the reader the answer, and costs
 * the feature its credibility — the first time someone finds a fix hidden
 * behind "3 quiet replies" they switch it off and never switch it back on. So
 * every ambiguous case has to resolve to "show it", and the target is not "low
 * signal", it is "obviously nothing".
 *
 * That is why the text test is `saysNothing` and not a score: every clause of
 * the reply must match the curated list below. "use RunService instead" is
 * three words and is the whole answer; "still broken on mobile" is four and is
 * a bug report. A word count alone folds both of them. The clause rule folds
 * neither, because neither is on the list.
 *
 * ── Why nothing is moved ────────────────────────────────────────────────────
 * Ember owns the post stream: it re-renders on scroll, reply and like, and
 * lazy-loads posts that are not in the DOM yet. So the fold is a class on the
 * row plus CSS, exactly as thread-view's depth and op-pin's column are, and one
 * inserted line per run.
 *
 * That line lives INSIDE the row of the run's first post, as a sibling of the
 * `<article>` the fold hides. The placement is the whole trick:
 *
 *   - it has exactly one legal home, so a pass either finds it there or creates
 *     it — duplication needs Ember to have cloned the row, which `ensureLine`
 *     sweeps up rather than assumes away;
 *   - if Ember re-renders or recycles that post the line goes with it, instead
 *     of being left behind pointing at a run that no longer exists.
 *
 * Inserting it as a sibling of the row — a direct child of `.post-stream` — was
 * rejected. That list is the one Ember diffs, and a foreign node in it is a
 * node Ember is entitled to move or drop.
 *
 * `<article>` is what CSS hides, never the row. The row stays in flow carrying
 * the line, so the stream keeps a real box at the position the post really has,
 * and every run's boundaries stay derivable from the DOM alone.
 *
 * ── What folding costs, and who pays it ─────────────────────────────────────
 * Hidden text does not match find-in-page. That is the strongest argument for
 * the conservative rule above, and for the count on every line: the reader is
 * told exactly how much is behind it, and one click is the whole price of
 * getting it back. Expansion is per-run for the same reason — expanding to find
 * one thing should not undo the fold for the rest of the thread.
 * ───────────────────────────────────────────────────────────────────────────
 */

const ROOT_FLAG = "data-dfp-quiet";
const STORAGE_KEY = "dfp:quiet-replies";

/** Row state. CSS reads these; nothing here moves or deletes a post. */
const FOLDED = "dfp-quiet";
const OPEN = "dfp-quiet--open";

const LINE = "dfp-quiet-fold";
const LINE_COUNT = "dfp-quiet-fold__count";
const LINE_HINT = "dfp-quiet-fold__hint";
const TOGGLE = "dfp-quiet-toggle";

/**
 * Markup that means there is something here to read.
 *
 * Any one of these and the reply is never folded, however short it is — a bare
 * link can be the whole answer, and a one-word `<code>` span is usually the API
 * someone was missing.
 *
 * Two exclusions, both deliberate. `a.mention` is an addressee rather than a
 * link, so "@someone thanks" is still thanks; `img.emoji` is punctuation, so a
 * thumbs-up is not an image. Without them the two commonest shapes of filler on
 * this forum would both be exempt and the feature would fold almost nothing.
 */
const CONTENT = [
  "pre",
  "code",
  "table",
  "blockquote",
  "aside",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "details",
  "iframe",
  "video",
  "audio",
  "img:not(.emoji)",
  "a[href]:not(.mention)",
  ".lightbox-wrapper",
  ".onebox",
  ".poll",
].join(",");

/**
 * Solved markers, checked before anything is folded.
 *
 * Deliberately loose — `discourse-solved` has moved this class between the row,
 * the article and a badge inside the post across versions, and a selector that
 * over-matches only ever costs a fold that did not happen. Under-matching costs
 * the accepted answer.
 */
const SOLVED = ".accepted-answer, .solved, .accepted-text, [data-solved]";

/**
 * Backstop on length. The clause rule below is what actually decides; this only
 * guarantees that no long post can be folded by an unlucky pile-up of matches.
 */
const MAX_WORDS = 14;
const MAX_CLAUSES = 4;

/**
 * Likes above which a reply is left alone whatever it says.
 *
 * Not a quality measure — a signal that people did something deliberate to this
 * post. We do not know what they saw in it, and folding something a dozen
 * people reacted to is the loud kind of wrong.
 */
const LOUD_LIKES = 5;

/**
 * The curated list. Every clause of a reply must match one of these.
 *
 * Anchored whole-clause patterns, not substrings: "thanks" folds, "thanks, but
 * that breaks when the humanoid is nil" does not, because its second clause is
 * not on the list. Additions belong here only if they are nothing in every
 * context — "yes", "no" and "ok" were drafted in and taken out again, because a
 * bare "no" is the answer to the question above it.
 */
const FILLER: RegExp[] = [
  // Gratitude, and the reply to gratitude.
  /^(thanks?|thank you|thank u|thx|tysm|tyvm|much appreciated|appreciate it)( so much| a lot| a ton| very much| again| man| bro| dude| mate| for (the )?(help|this|that|info|reply|answer|response|tip|tips))*$/,
  /^(no problem|np|no worries|you'?re welcome|anytime|happy to help|glad (i could help|it helped|to help))$/,
  // "that fixed it" — the confirmation, which repeats the post above it.
  /^(this|that|it|your (fix|answer|solution|code|snippet))? ?(worked|works|helped|helps|fixed it|did it|did the trick|was it)( perfectly| great| like a charm| a lot| a ton| for me| now| thanks)*$/,
  // Me-too: adds a name to a problem and nothing else.
  /^(\+1|same|same here|same (issue|problem|thing)|me too|i have (the same|this) (issue|problem|error)|following|subscribed|watching( this)?( thread)?)$/,
  // Bumps and pings.
  /^(bump+(ing)?|any (updates?|news|progress|luck)( on this)?( yet)?|(did|have) you (ever )?(fix(ed)? (this|it)|solve(d)? (this|it)|figure(d)? (it|this) out)|still (waiting|need(ing)? help)|please help|help me please|anyone)$/,
  // Applause and noise.
  /^(hi|hello|hey|lol|lmao|lmfao|oof|rip|wow|nice|cool|great|awesome|amazing|epic|based|congrats|congratulations|well done|nice one|good (job|work|luck|point))$/,
];

let enabled = false;

/** Post numbers the reader has expanded. Cleared when the topic changes. */
const expanded = new Set<number>();

/**
 * Cached "is this nothing" per post number, because the observer below runs a
 * pass per frame while Discourse mutates the DOM and re-reading every body in
 * the thread that often is the difference between free and not.
 *
 * An edit therefore keeps its old verdict until reload. That is the right trade
 * in one direction only, and it is the safe one: a reply edited from "thanks"
 * into an answer would stay folded, which is why anything with content markup
 * is never cached as foldable in the first place — see `nothingSaid`.
 */
const verdicts = new Map<number, boolean>();

let currentTopic: number | null = null;
/** From `accepted_answer.post_number`, which covers the whole topic. */
let solvedPost: number | null = null;

/**
 * The post a deep link points at, from `/t/slug/12345/678`.
 *
 * Folding the post someone followed a link to is the one failure that needs no
 * bad luck at all — it happens every time the link points at a "thanks", and
 * the reader lands on a fold line with no idea they arrived.
 */
function linkedPost(): number | null {
  const m = /^\/t\/(?:[^/]+\/)?\d+\/(\d+)/.exec(location.pathname);
  return m ? Number(m[1]) : null;
}

/**
 * Post text with mentions dropped.
 *
 * Built by walking text nodes rather than cloning: `textContent` on a clone
 * would cost a subtree copy per post, and this runs over every post in the
 * thread.
 */
function plainText(cooked: HTMLElement): string {
  let out = "";
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.nodeValue ?? "";
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if ((child as HTMLElement).classList.contains("mention")) continue;
        walk(child);
      }
    }
  };
  walk(cooked);
  return out;
}

/**
 * Reduce a clause to the letters and digits it is made of.
 *
 * Everything outside `[a-z0-9+']` goes, which also means a reply written in
 * Cyrillic or CJK normalises to nothing and is never folded. That is correct
 * rather than merely convenient: this list is English filler, and a rule that
 * cannot read a post has no business hiding it.
 */
function normalize(clause: string): string {
  return clause
    .replace(/[^a-z0-9+' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does this text consist of nothing but filler?
 *
 * Split before punctuation is stripped, so sentence boundaries survive: "thanks
 * it worked" and "thanks. it worked" are the same two clauses, and "thanks but
 * it still errors" is two clauses of which one is real.
 *
 * Exported as the seam a unit test would use — the DOM half of this module is
 * not testable without a whole post stream, and this is the half where a wrong
 * answer is expensive.
 */
export function saysNothing(raw: string): boolean {
  const lower = raw.toLowerCase();
  const words = normalize(lower).split(" ").filter(Boolean);
  if (words.length === 0 || words.length > MAX_WORDS) return false;

  const clauses = lower
    .split(/[.!?,;:\n\r]+|\band\b|\bbut\b|\balso\b/)
    .map(normalize)
    .filter((c) => c.length > 0);
  if (clauses.length === 0 || clauses.length > MAX_CLAUSES) return false;

  return clauses.every((c) => FILLER.some((re) => re.test(c)));
}

/** The cached content verdict, or a fresh one if this post has a body yet. */
function nothingSaid(article: HTMLElement, postNumber: number): boolean {
  const cached = verdicts.get(postNumber);
  if (cached !== undefined) return cached;

  const cooked = article.querySelector<HTMLElement>(".cooked");
  /* No body yet, so no verdict yet — and crucially no cache entry. Marking here
   * is the mistake code-chrome made by claiming a `<pre>` before Discourse had
   * wrapped it: the false answer latches and every later pass skips the post
   * that would have corrected it. An unrendered post reads as empty, and empty
   * would fold. */
  if (!cooked) return false;

  if (cooked.querySelector(CONTENT)) {
    verdicts.set(postNumber, false);
    return false;
  }
  const verdict = saysNothing(plainText(cooked));
  verdicts.set(postNumber, verdict);
  return verdict;
}

/** "1.2k" is not a number this needs to parse — it is only ever "a lot". */
function likeCount(article: HTMLElement): number {
  const raw = article.querySelector(".like-count")?.textContent?.trim() ?? "";
  if (!raw) return 0;
  if (/[km]/i.test(raw)) return Number.POSITIVE_INFINITY;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reasons to leave a reply alone that have nothing to do with what it says.
 *
 * Checked after the content verdict, not before: only a handful of posts in a
 * thread get this far, so the DOM queries here are paid for the few rather than
 * for all of them on every frame.
 *
 * The reply-count check is the subtle one. Discourse renders `.show-replies`
 * only when someone replied to this post, and a post worth replying to is a
 * post that said something — even when what it said was short enough to look
 * like filler from here.
 */
function isProtected(row: HTMLElement, article: HTMLElement, postNumber: number): boolean {
  // The question itself, and the answer, whichever way we learn about it.
  if (postNumber <= 1) return true;
  if (postNumber === solvedPost) return true;
  if (row.classList.contains("accepted-answer")) return true;
  if (article.classList.contains("accepted-answer")) return true;
  if (article.querySelector(SOLVED)) return true;

  /* The topic author. "Thanks" from the OP and "found it, it was the humanoid"
   * from the OP are the same shape from out here, and the second is the most
   * valuable post in a support thread — it is the reason anyone arriving from
   * Google reads it at all. We cannot tell them apart, so we do not try. */
  if (row.classList.contains("topic-owner")) return true;

  if (postNumber === linkedPost()) return true;
  // Discourse marks the post it just scrolled you to; folding that one under
  // the reader is the same failure as folding a deep link's target.
  if (article.classList.contains("highlighted")) return true;

  if (article.querySelector(".show-replies")) return true;
  if (likeCount(article) >= LOUD_LIKES) return true;
  return false;
}

interface Run {
  lead: HTMLElement;
  rows: HTMLElement[];
  numbers: number[];
}

/** The post number of a foldable row, or null for anything that breaks a run. */
function foldableNumber(node: Element): number | null {
  if (!(node instanceof HTMLElement)) return null;
  if (!node.classList.contains("topic-post")) return null;

  const article = node.querySelector<HTMLElement>(":scope > article[id^='post_']");
  if (!article) return null;
  const m = /^post_(\d+)$/.exec(article.id);
  /* No post number means no run identity — expansion is keyed on post numbers,
   * so a row we cannot name is a row we could not reliably re-expand. Skipping
   * it costs one unfolded "thanks". */
  if (!m) return null;
  const postNumber = Number(m[1]);

  if (!nothingSaid(article, postNumber)) return null;
  if (isProtected(node, article, postNumber)) return null;
  return postNumber;
}

/**
 * Runs of consecutive foldable posts, in stream order.
 *
 * Recomputed from the DOM on every pass rather than remembered, so it cannot
 * disagree with what is on screen. `.post-stream` also contains
 * `article.small-action` rows (a topic being closed, a post moved) and gap
 * markers; anything that is not a foldable post ends the run, which keeps every
 * run contiguous — that is what makes one line able to stand for it honestly.
 */
function buildRuns(): Run[] {
  const stream = document.querySelector(".post-stream");
  if (!stream) return [];

  const runs: Run[] = [];
  let current: Run | null = null;
  for (const child of stream.children) {
    const postNumber = foldableNumber(child);
    if (postNumber === null) {
      current = null;
      continue;
    }
    const row = child as HTMLElement;
    if (!current) {
      current = { lead: row, rows: [], numbers: [] };
      runs.push(current);
    }
    current.rows.push(row);
    current.numbers.push(postNumber);
  }
  return runs;
}

/**
 * Write only on a change.
 *
 * The observer below watches `childList`, and assigning an identical string
 * still tears down and rebuilds the text node — so an unconditional write is a
 * mutation on every pass, and every mutation schedules the next pass. That is
 * not a slow loop, it is a permanent one.
 */
function setText(el: Element | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

function buildLine(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = LINE;

  const count = document.createElement("span");
  count.className = LINE_COUNT;
  const hint = document.createElement("span");
  hint.className = LINE_HINT;
  btn.append(count, hint);

  btn.addEventListener("click", () => toggleRun(btn));
  return btn;
}

function dropLine(row: HTMLElement): void {
  for (const line of row.querySelectorAll<HTMLElement>(`:scope > .${LINE}`)) line.remove();
}

function ensureLine(run: Run, open: boolean): void {
  const found = run.lead.querySelectorAll<HTMLElement>(`:scope > .${LINE}`);
  // Within a pass this cannot produce a second line — one is only built when
  // none was found. It can only happen if Ember re-rendered the row from a
  // template that already had ours in it, which is not something this module
  // can rule out from the outside, so extras are dropped rather than trusted.
  for (let i = 1; i < found.length; i++) found[i]!.remove();

  let line = found[0] ?? null;
  if (!line) {
    line = buildLine();
    run.lead.insertBefore(line, run.lead.firstChild);
  }

  const n = run.rows.length;
  setText(line.querySelector(`.${LINE_COUNT}`), n === 1 ? "1 quiet reply" : `${n} quiet replies`);
  setText(line.querySelector(`.${LINE_HINT}`), open ? "hide" : "show");
  line.setAttribute("aria-expanded", String(open));
}

/**
 * Expansion is keyed on every post number in the run, not on the run's first
 * post.
 *
 * Runs grow: scrolling up loads older posts, and a foldable one landing above
 * the current lead makes a new lead. Keyed on the lead alone, that silently
 * re-collapses a run the reader had opened. Keyed on all of them, a run is open
 * if any of its members was opened, so it survives its own boundaries moving.
 */
function toggleRun(line: HTMLElement): void {
  const row = line.parentElement;
  if (!row) return;
  const run = buildRuns().find((r) => r.lead === row);
  if (!run) return;

  const open = run.numbers.some((n) => expanded.has(n));
  for (const n of run.numbers) {
    if (open) expanded.delete(n);
    else expanded.add(n);
  }
  pass();
  // Collapsing takes everything below the line off the page. Without this the
  // reader is left wherever that content used to be, which reads as the page
  // having jumped. Same treatment as code-chrome's collapse.
  if (open) line.scrollIntoView({ block: "nearest" });
}

function applyRuns(runs: Run[]): void {
  const live = new Set<HTMLElement>();

  for (const run of runs) {
    const open = run.numbers.some((n) => expanded.has(n));
    for (const row of run.rows) {
      row.classList.add(FOLDED);
      row.classList.toggle(OPEN, open);
      live.add(row);
      // A row that used to lead a run and no longer does. Its line would
      // otherwise sit in the middle of the run, counting posts it is not in
      // front of.
      if (row !== run.lead) dropLine(row);
    }
    ensureLine(run, open);
  }

  clearRows(live);
}

/** Hand back every row that is no longer part of a run. */
function clearRows(keep?: Set<HTMLElement>): void {
  for (const row of document.querySelectorAll<HTMLElement>(`.${FOLDED}`)) {
    if (keep?.has(row)) continue;
    row.classList.remove(FOLDED, OPEN);
    dropLine(row);
  }
}

/**
 * Mount, label and unmount the toggle.
 *
 * The count is the whole reason this says more than "Quiet replies": a control
 * that folds nothing visible is indistinguishable from a broken one, and the
 * number is also the only place the reader is told how much the feature is
 * doing to a thread they have not scrolled yet.
 *
 * Zero candidates means the control is removed rather than shown inert. The
 * number counts what is loaded, so it climbs as Discourse pages more posts in —
 * that is the honest reading of it, not a bug.
 */
function syncToggle(candidates: number): void {
  let btn = document.querySelector<HTMLElement>(`.${TOGGLE}`);
  if (candidates === 0) {
    btn?.remove();
    return;
  }

  if (!btn) {
    /* `.topic-footer-main-buttons` is NOT the primary anchor, and this is the
     * one place that matters most: a fold control belongs on a long thread by
     * definition. Verified on the live forum at reply #122 of 9,163 and written
     * up in thread-view.ts — Discourse does not render the topic footer until
     * you reach the end of the stream, so that query returns null and the
     * control never mounts. `.timeline-footer-controls` is the last child of
     * the always-present timeline rail; the footer stays as the narrow-viewport
     * fallback, where the rail itself collapses. */
    const anchor =
      document.querySelector(".timeline-footer-controls") ??
      document.querySelector(".topic-footer-main-buttons") ??
      document.querySelector("#topic-footer-buttons");
    if (!anchor) return;

    const made = document.createElement("button");
    made.type = "button";
    made.className = `btn btn-default ${TOGGLE}`;
    made.addEventListener("click", () => setEnabled(!enabled));
    // Appended, so DFP's controls collect below Discourse's own rather than
    // pushing them down the rail — same as thread-view and op-pin, which keeps
    // the three toggles together.
    anchor.appendChild(made);
    btn = made;
  }

  /* "Quiet", not "Quiet replies". The timeline rail is sized by its widest
   * child, so the label is load-bearing on layout: measured, "Quiet replies (3)"
   * pushed the rail from 90px to 105px and took that width out of the reply
   * column, while "Quiet (3)" leaves it at 90. The title attribute below carries
   * the full sentence. */
  setText(btn, `Quiet (${candidates})`);
  btn.setAttribute("aria-pressed", String(enabled));
  btn.title = enabled
    ? "Show every reply"
    : `Fold ${candidates} ${candidates === 1 ? "reply" : "replies"} that say nothing`;
}

function pass(): void {
  /* Runs are built whether or not folding is on, because the count is what
   * decides the toggle exists at all. Building them only while enabled would
   * take the switch away along with the folds: candidates would read 0, the
   * control would unmount itself, and turning the feature back on would mean
   * clearing localStorage. */
  const runs = buildRuns();
  const candidates = runs.reduce((n, r) => n + r.rows.length, 0);

  if (enabled) applyRuns(runs);
  else clearRows();

  syncToggle(candidates);
}

function setEnabled(on: boolean): void {
  enabled = on;
  document.documentElement.toggleAttribute(ROOT_FLAG, on);
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Private mode or a partitioned store — the toggle still works for this
    // page, it just will not be remembered.
  }
  pass();
}

/**
 * Re-key everything for whatever topic is open now.
 *
 * Post numbers are per-topic — every topic has a #2 — so a verdict or an
 * expansion carried across a navigation is not stale, it is about a different
 * post. Cleared BEFORE the await for the same reason thread-view clears its
 * parent map there: the observer keeps running passes while the payload is in
 * flight.
 */
async function refreshTopic(): Promise<void> {
  const id = topicIdFromPath(location.pathname);
  if (id === null) {
    currentTopic = null;
    solvedPost = null;
    verdicts.clear();
    expanded.clear();
    return;
  }
  if (currentTopic === id) return;

  currentTopic = id;
  solvedPost = null;
  verdicts.clear();
  expanded.clear();

  const topic = await getCurrentTopic();
  // A newer navigation already claimed `currentTopic`; this answer is for a
  // topic nobody is looking at.
  if (currentTopic !== id) return;

  /* `accepted_answer` is a top-level field on the payload, so unlike
   * `post_stream.posts` it is not limited to the loaded window — the answer to
   * a 400-reply topic is still named when only twenty posts are here. The DOM
   * class check in `isProtected` covers the gap until this lands; nothing is
   * cached from it, so the correction is free. */
  solvedPost = topic?.accepted_answer?.post_number ?? null;
  if (solvedPost !== null) pass();
}

export function quietReplies(api: PluginApi): DfpModule {
  return {
    id: "quiet-replies",
    budgetMs: 150,

    install() {
      try {
        enabled = localStorage.getItem(STORAGE_KEY) === "1";
      } catch {
        enabled = false;
      }
      document.documentElement.toggleAttribute(ROOT_FLAG, enabled);

      api.onPageChange(() => {
        void refreshTopic();
        pass();
      });

      /* Posts arrive as you scroll and Ember re-renders the stream on reply and
       * like, so both "what is foldable" and "is the timeline here" change
       * without a route change. Coalesced to one pass per frame: Discourse
       * mutates the DOM constantly, and a pass per mutation record would spend
       * a frame's budget re-deriving the same runs.
       *
       * `childList` only. This pass writes classes and attributes, so observing
       * attributes would make the observer trigger itself; the one childList
       * write it does make — the fold line — is guarded by `setText` and by
       * `ensureLine` finding the element it already inserted. */
      onDomChange(() => pass());

      void refreshTopic();
      pass();
    },
  };
}
