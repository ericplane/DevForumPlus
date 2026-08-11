import type { DfpModule } from "../../core/registry";
import type { PluginApi } from "../types";
import { onDomChange } from "../dom-watch";

/**
 * Age marks on full-page search results.
 *
 * Search is where this forum's central problem bites hardest. A 2016 answer and
 * a 2025 answer are rendered identically, sorted by relevance rather than by
 * whether the advice still works, and search is the surface people arrive on
 * from Google. The topic list already marks dormant threads and old replies
 * already carry a caution; results had nothing.
 *
 * The date is in the DOM as text and nothing else — `span.date` inside
 * `.blurb`, carrying no `data-time` and no `title`. That is workable because of
 * how Discourse formats it: anything from a previous year states that year
 * ("Oct 2017", "Feb 2024"), and only current-year results use the short forms
 * ("Jun 1", "24d"). Measured on a real query: 39 of 50 results carried an
 * explicit year, and every one that did not was current-year.
 *
 * Two years matches `stale-answer`, and for the same reason — `task.wait`
 * landed in 2021, so anything older is likely to recommend an API that has
 * since been replaced.
 */

const MARK = "data-dfp-age";
const YEAR = 365.25 * 24 * 60 * 60 * 1000;
const OLD_AFTER = 2 * YEAR;

/** `"Oct 2017 -"` → a Date; `"Jun 1"` / `"24d"` → null (both current-year). */
export function dateFromLabel(label: string, now: number): Date | null {
  const m = /\b(19|20)\d{2}\b/.exec(label);
  if (!m) return null;

  const year = Number(m[0]);
  // Guard against a stray four-digit number that is not a year at all.
  const thisYear = new Date(now).getFullYear();
  if (year < 2004 || year > thisYear) return null;

  const month = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.exec(label);
  const parsed = new Date(`${month ? month[0] : "Jun"} 15, ${year}`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function ageLabel(ms: number): string {
  const years = Math.floor(ms / YEAR);
  return years >= 2 ? `${years} yrs old` : "";
}

function enhance(result: HTMLElement, now: number): void {
  if (result.hasAttribute(MARK)) return;

  const date = result.querySelector<HTMLElement>(".blurb .date");
  if (!date) return;

  // Claim it either way, so a current-year result is not re-parsed on every
  // mutation for the life of the page.
  result.setAttribute(MARK, "");

  const when = dateFromLabel(date.textContent ?? "", now);
  if (!when) return;

  const age = now - when.getTime();
  if (age < OLD_AFTER) return;

  const label = ageLabel(age);
  if (!label) return;

  result.setAttribute(MARK, label);

  const chip = document.createElement("span");
  chip.className = "dfp-search-age";
  chip.textContent = label;
  /* After the date rather than before the title: the title is what you read
   * first, and this is the qualifier you want a beat later. */
  date.after(chip);
}

function scan(root: ParentNode, now: number): void {
  for (const r of root.querySelectorAll<HTMLElement>(".fps-result")) enhance(r, now);
}

export function searchSignals(api: PluginApi): DfpModule {
  return {
    id: "search-signals",
    budgetMs: 80,

    install() {
      const run = () => {
        try {
          scan(document, Date.now());
        } catch {
          // A result that renders differently must not break the page.
        }
      };

      // Deferred: 50 results parsed synchronously would be charged to install.
      queueMicrotask(run);
      api.onPageChange(() => setTimeout(run, 150));

      /* Results stream in as you scroll, and re-running a search replaces the
       * whole list. */
      onDomChange((records) => {
        const now = Date.now();
        for (const rec of records) {
          for (const node of rec.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.classList.contains("fps-result")) enhance(node, now);
            else scan(node, now);
          }
        }
      });
    },
  };
}
