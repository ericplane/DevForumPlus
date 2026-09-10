/**
 * Age arithmetic shared by the two surfaces that mark old material.
 *
 * `ageLabel` and the two-year threshold lived in search-signals.ts, which is a
 * MAIN-world module importing dom-watch and the registry. The ⌘K palette runs
 * in the ISOLATED bundle and needed the same label for its own search rows —
 * importing the module would have pulled the MAIN-world tree into the other
 * bundle, so the six lines moved here, where nothing touches the DOM. Both
 * callers import from this file so the wording and the threshold cannot drift.
 *
 * Two years matches `stale-answer` and `topic-preview`, and for the same
 * reason — `task.wait` landed in 2021, so anything older is likely to recommend
 * an API that has since been replaced.
 */

/** A Julian year in ms — the same 315,576,000,000 topic-preview.ts writes as `315_576e5`. */
export const YEAR = 365.25 * 24 * 60 * 60 * 1000;
export const OLD_AFTER = 2 * YEAR;

/** `"3 yrs old"` for anything two years or older; empty below that. */
export function ageLabel(ms: number): string {
  const years = Math.floor(ms / YEAR);
  return years >= 2 ? `${years} yrs old` : "";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** A twelfth of the Julian year — 30.44 days — so twelve months are one year. */
const MONTH = YEAR / 12;

/**
 * How long ago, in the coarsest unit that is still honest: "just now",
 * "5 min ago", "3 h ago", "2 d ago", "4 w ago", "3 mo ago", "2 y ago".
 *
 * The month and year forms exist because the recent list is capped by count
 * (a dozen), not by age: a reader who opens the forum twice a year keeps the
 * same twelve entries, and without them a row read "37 w ago" — a figure
 * nobody converts in their head. Weeks give way to months at five, where
 * "5 w" and "1 mo" stop meaning the same thing.
 */
export function agoLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  if (ms < WEEK) return `${Math.floor(ms / DAY)} d ago`;
  if (ms < 5 * WEEK) return `${Math.floor(ms / WEEK)} w ago`;
  if (ms < YEAR) return `${Math.floor(ms / MONTH)} mo ago`;
  return `${Math.floor(ms / YEAR)} y ago`;
}
