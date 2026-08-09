import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { decorateCooked } from "../decorate";
import { detect } from "../../luau/detect";
import { getCurrentTopic, postNumberOf, postsByNumber } from "../topic-data";

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

function enhance(element: HTMLElement, createdAt: string, postNumber: number): void {
  const age = Date.now() - new Date(createdAt).getTime();
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

export function staleAnswer(api: PluginApi): DfpModule {
  return {
    id: "stale-answer",
    budgetMs: 6,

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
          element.setAttribute(SEEN, "1");

          void getCurrentTopic().then((topic) => {
            if (!topic || !element.isConnected) return;
            const post = postsByNumber(topic).get(postNumber);
            if (!post?.created_at) return;
            if (dismissed.has(postNumber)) return;
            try {
              enhance(element, post.created_at, postNumber);
            } catch {
              // A malformed snippet must never break the post it is in.
            }
          });
        },
        { id: "dfp-stale-answer", onlyStream: true },
      );
    },
  };
}
