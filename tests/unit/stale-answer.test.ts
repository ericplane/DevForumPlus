import { bylineTime } from "../../src/discourse/modules/stale-answer";

/**
 * The byline read that decides whether a stale post is even examined.
 *
 * The module used to take the post's age from the shared topic payload, which
 * holds only the first window, so every deep-linked or paged-in reply — the
 * ones the feature exists for — was skipped without a word. The byline read
 * replaced that, and this holds the parsing underneath it: the `data-time`
 * stamp Discourse writes (ms epoch), the `title` it falls back to, and the
 * shapes that must fall through to the payload rather than pass as a date.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

console.log("── data-time ─────────────────────────────────────────────────────");
eq(bylineTime("1768392600000", null), 1768392600000, "ms epoch, as Discourse stamps it");
eq(bylineTime("1768392600000", "Post date"), 1768392600000, "the stamp wins over a title");
eq(bylineTime("abc", null), null, "a non-number is not a date");
eq(bylineTime("", null), null, "empty is not a date");
eq(bylineTime("0", null), null, "zero is a missing value, not 1970");
eq(bylineTime(null, null), null, "nothing rendered → fall through to the payload");

console.log("── title fallback ────────────────────────────────────────────────");
{
  // Discourse's long-date title, as rendered on an English forum.
  const t = bylineTime(null, "Jan 14, 2026 1:10 pm");
  check(t !== null && Number.isFinite(t), `a long-date title parses  →  ${JSON.stringify(t)}`);
  check(t !== null && new Date(t).getFullYear() === 2026, "…to the year it names");
}
// The fixture's placeholder title, which must not be mistaken for a date.
eq(bylineTime(null, "Post date"), null, "a non-date title falls through");
check(bylineTime("abc", "Jan 14, 2026 1:10 pm") !== null, "a bad stamp still lets the title answer");

console.log("");
if (fail > 0) {
  console.log(`FAILED: ${fail} of ${pass + fail} checks`);
  process.exit(1);
}
console.log(`ALL PASS (${pass}/${pass} checks)`);
