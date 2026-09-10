import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import { detect } from "../../luau/detect";
import { articleOf, getCurrentTopic, postNumberOf, postsByNumber } from "../topic-data";

/**
 * Warn when an old post recommends something that is no longer the answer.
 *
 * This is the case the whole code-intelligence milestone exists for. A 2018
 * reply saying "just use `wait()` and a `BodyVelocity`" ranks well in Google,
 * reads as authoritative, and is wrong — and the person who wrote it will never
 * come back to edit it. The deprecation marks from M3 already say *which* call
 * is stale; this says *the post* is.
 *
 * Two conditions, both required:
 *
 *   1. The post is old. Age alone is not a defect — most old posts are fine.
 *   2. It contains a `warn` or `error` deprecation. Severity matters: `info`
 *      findings are lowercase legacy aliases like `:connect()`, which are
 *      untidy rather than harmful, and banner-ing those would train people to
 *      ignore the banner.
 *
 * Deliberately not shown on the opening post: a question that happens to be old
 * and uses `wait()` is not giving anyone bad advice, and warning about it reads
 * as a scold.
 *
 * ── Where the age comes from ────────────────────────────────────────────────
 * The byline, not the topic payload. This used to look the post up in the
 * shared `/t/{id}.json`, and that payload carried only the first window —
 * thread-view.ts measured "20 posts loaded, 178 not" on a 198-post topic — so
 * for any reply past roughly #20 the lookup missed and the module returned
 * without a word. Every post reached by scrolling, and every post reached by a
 * deep link (a `/t/…/400` render holds posts 395-414 and the payload was fetched
 * without a post number, so it still held 1-20), was skipped. The Google
 * result that lands you on a 2019 reply mid-thread is a deep link: the exact
 * post this module exists for was the one it could never see.
 *
 * Discourse stamps the byline with the same number it uses for its own
 * relative-age refresh — `a.post-date span.relative-date[data-time]`, the ms
 * epoch, with the full date in `title` — measured on the live forum. Reading it
 * costs no request, needs no await, and puts the tokenizing back inside the
 * window `decorateCooked` charges to this module. The payload stays as the
 * fallback for a byline that is missing or unparseable.
 * ───────────────────────────────────────────────────────────────────────────
 */

const MARK = "data-dfp-stale";
/** Claimed by the decorator, so repeat sweeps cost a attribute read. */
const SEEN = "data-dfp-stale-seen";
const YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * How old is old.
 *
 * Two years is chosen against the actual breakage: `task.wait` shipped in 2021
 * and the body movers were superseded around the same time, so a post older
 * than that predates the current answer to most of what it discusses.
 */
const STALE_AFTER = 2 * YEAR;

/** Dismissals live for the session only — a reload is a fresh judgement. */
const dismissed = new Set<number>();

/**
 * The post's creation time from what Discourse rendered into the byline.
 *
 * `data-time` first: it is the ms epoch Discourse itself re-reads to refresh
 * "3h" into "4h", so it is exact and locale-free. The `title` is the fallback —
 * a formatted long date ("Jan 14, 2026 1:10 pm"), which V8 parses (see the
 * unit test) but which depends on the forum's locale, so it is only consulted
 * when the stamp is absent; an engine that returns NaN for it falls through to
 * the payload, which is the designed floor. `null` means neither answered, and
 * the caller falls through to the topic payload. Exported for the test.
 */
export function bylineTime(dataTime: string | null, title: string | null): number | null {
  const ms = Number(dataTime);
  if (dataTime && Number.isFinite(ms) && ms > 0) return ms;
  const parsed = title ? Date.parse(title) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Embedded replies — the ones a reader expands above the post through
 * `section.embedded-posts.top` and below it through `.bottom` — render their
 * byline as `.topic-meta-data.embedded-reply`: a poster name and a link arrow,
 * with no `.post-infos` at all (Discourse's embedded-post widget), so this
 * selector can only ever match the post's own byline. That is what protects
 * the read, not document order: the `top` section is rendered in a row BEFORE
 * the post's own avatar/body row, so the first match in document order would
 * be the wrong byline whenever "in reply to" is expanded.
 */
function bylineTimeOf(element: HTMLElement): number | null {
  const stamp = articleOf(element)?.querySelector(".post-infos .post-date .relative-date");
  if (!stamp) return null;
  return bylineTime(stamp.getAttribute("data-time"), stamp.getAttribute("title"));
}

function ageText(ms: number): string {
  const years = ms / YEAR;
  if (years >= 2) return `${Math.floor(years)} years old`;
  const months = Math.floor(ms / (30 * 24 * 60 * 60 * 1000));
  return `${months} months old`;
}

function build(postNumber: number, age: number, replacements: string[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "dfp-stale-post";
  box.setAttribute(MARK, "1");

  const text = document.createElement("p");
  text.className = "dfp-stale-post__text";
  /* Names what to use instead rather than only saying "this is old" — a
   * warning a reader cannot act on is just noise on someone else's post. */
  const list = replacements.slice(0, 3).join(", ");
  text.textContent =
    `This reply is ${ageText(age)} and uses APIs that have since been replaced` +
    (list ? ` — current equivalents: ${list}.` : ".");
  box.appendChild(text);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "dfp-stale-post__dismiss";
  close.setAttribute("aria-label", "Dismiss this notice");
  close.textContent = "Dismiss";
  close.addEventListener("click", () => {
    dismissed.add(postNumber);
    box.remove();
  });
  box.appendChild(close);

  return box;
}

function enhance(element: HTMLElement, createdMs: number, postNumber: number): void {
  const age = Date.now() - createdMs;
  // Age gate first, deliberately: `detect()` is the expensive half, and most
  // posts in a thread are recent, so this skips tokenizing nearly all of them.
  if (!Number.isFinite(age) || age < STALE_AFTER) return;

  const blocks = element.querySelectorAll<HTMLElement>("pre > code");
  if (!blocks.length) return;

  const replacements = new Set<string>();
  let serious = 0;
  for (const code of blocks) {
    for (const f of detect(code.textContent ?? "")) {
      if (f.entry.severity === "info") continue;
      serious++;
      if (f.entry.replacement) replacements.add(f.entry.replacement);
    }
  }
  if (serious === 0) return;

  if (element.previousElementSibling?.hasAttribute?.(MARK)) return;
  element.before(build(postNumber, age, [...replacements]));
}

/**
 * `decorateCooked` catches a throw on the synchronous path, but the payload
 * path resolves after it has returned, where nothing else is listening — so
 * the catch lives here and both paths share it.
 */
function tryEnhance(element: HTMLElement, createdMs: number, postNumber: number): void {
  try {
    enhance(element, createdMs, postNumber);
  } catch {
    // A malformed snippet must never break the post it is in.
  }
}

export function staleAnswer(api: PluginApi): DfpModule {
  return {
    id: "stale-answer",
    budgetMs: 100,

    install() {
      decorateCooked(
        api,
        (element) => {
          const postNumber = postNumberOf(element);
          // Post 1 is the question, not the advice. See the header comment.
          if (postNumber === null || postNumber <= 1) return;
          if (dismissed.has(postNumber)) return;

          /* Claim the element before doing any work. `detect()` is the
           * expensive half, and the sweep visits each element up to four times
           * — without this the whole thread is re-tokenized on every pass,
           * because the old guard was only checked after the tokenizing. */
          if (element.hasAttribute(SEEN)) return;

          const fromByline = bylineTimeOf(element);
          if (fromByline !== null) {
            element.setAttribute(SEEN, "1");
            tryEnhance(element, fromByline, postNumber);
            return;
          }

          /* Fallback: the topic payload, which knows only the window Discourse
           * loaded — the head of the thread, or on a deep link the posts around
           * the linked one. The claim is made when the payload ANSWERS, not
           * before the await: a miss leaves the element unclaimed so a later
           * sweep can try again, and a miss is cheap — the promise is cached,
           * so a retry builds a Map over the loaded window and tokenizes
           * nothing. The sweeps overlap the await, so the first callback to
           * land re-checks the claim and the rest stand down; that is what
           * keeps the tokenizing to once per post. */
          void getCurrentTopic().then((topic) => {
            if (!topic || !element.isConnected) return;
            const created = postsByNumber(topic).get(postNumber)?.created_at;
            const createdMs = created ? Date.parse(created) : NaN;
            if (!Number.isFinite(createdMs)) return;
            if (element.hasAttribute(SEEN)) return;
            element.setAttribute(SEEN, "1");
            if (dismissed.has(postNumber)) return;
            tryEnhance(element, createdMs, postNumber);
          });
        },
        { id: "dfp-stale-answer", onlyStream: true },
      );
    },
  };
}
