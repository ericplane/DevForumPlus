import {
  commandMatches,
  paletteEnabled,
  parseTitle,
  pushRecent,
  recentEnabled,
  sanitizeRecent,
  score,
  topicFromPath,
} from "../../src/isolated/command-palette";
import { OLD_AFTER, YEAR, ageLabel, agoLabel } from "../../src/core/age";
import { DEFAULT_SETTINGS } from "../../src/core/settings-schema";

/**
 * The palette's pure half: ranking, the recent list's bookkeeping, and the
 * two parsers that turn a page into a recent entry.
 *
 * `parseTitle` is here because the title is the one thing the recent list
 * cannot get wrong quietly — a row that says "Developer Forum | Roblox" five
 * times is worse than no list. The cases are the shapes Discourse actually
 * writes: site name last, category before it, an unread count in front, and
 * topic titles that contain the same " - " the format uses as a separator.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);
const same = (got: unknown, want: unknown, label: string) =>
  check(JSON.stringify(got) === JSON.stringify(want), `${label}  →  ${JSON.stringify(got)}`);

console.log("── score: where the match lands, not how similar it is ───────────");
eq(score("Bug Reports", "bug"), 3, "prefix");
eq(score("Studio Bugs", "bug"), 2, "word start");
eq(score("Debugging", "bug"), 1, "inside a word");
eq(score("Scripting Support", "bug"), -1, "no match");
eq(score("Theme: dark", "dark"), 2, "after a colon-space, still a word start");
eq(score("Theme: dark", "theme"), 3, "the command's own prefix");
eq(score("anything", ""), 0, "empty needle is neutral");

console.log("\n── topicFromPath: the guarded topic shape ────────────────────────");
same(topicFromPath("/t/completing-the-dynamic-head-migration/4301387/3191"), { id: 4301387, slug: "completing-the-dynamic-head-migration" }, "slug + topic + post");
same(topicFromPath("/t/some-slug/4301387"), { id: 4301387, slug: "some-slug" }, "slug + topic");
// The bug the lookahead exists for: without it this read topic 12.
same(topicFromPath("/t/4301387/12"), { id: 4301387, slug: "" }, "slug-less form does not read the id as a slug");
same(topicFromPath("/t/4301387"), { id: 4301387, slug: "" }, "slug-less topic");
eq(topicFromPath("/c/scripting/55"), null, "a category is not a topic");
eq(topicFromPath("/latest"), null, "a list is not a topic");
eq(topicFromPath("/t/"), null, "bare /t/");
eq(topicFromPath("/t/slug/0"), null, "topic 0 is not a topic");

console.log("\n── parseTitle: Discourse's document.title format ───────────────────");
const SITE = "Developer Forum | Roblox";
const CATS = ["Scripting Support", "Announcements", "Bug Reports"];
same(parseTitle("How do I use task.wait - Scripting Support - Developer Forum | Roblox", SITE, CATS),
  { title: "How do I use task.wait", cat: "Scripting Support" }, "title - category - site");
same(parseTitle("Completing the migration - Announcements - Developer Forum | Roblox", SITE, CATS),
  { title: "Completing the migration", cat: "Announcements" }, "another category");
same(parseTitle("(3) Completing the migration - Announcements - Developer Forum | Roblox", SITE, CATS),
  { title: "Completing the migration", cat: "Announcements" }, "an unread count in front is dropped");
same(parseTitle("Part A - Part B - Scripting Support - Developer Forum | Roblox", SITE, CATS),
  { title: "Part A - Part B", cat: "Scripting Support" }, "a dash inside the title survives");
same(parseTitle("Part A - Not A Category - Developer Forum | Roblox", SITE, CATS),
  { title: "Part A - Not A Category" }, "an unknown tail is title, not category");
same(parseTitle("Some topic - Scripting Support - Developer Forum | Roblox", null, CATS),
  { title: "Some topic", cat: "Scripting Support" }, "no og:site_name: the | shape is still recognised as the site");
same(parseTitle("Some topic - Scripting Support - Developer Forum | Roblox", SITE, []),
  { title: "Some topic - Scripting Support" }, "no categories loaded: nothing is guessed");
same(parseTitle("Developer Forum | Roblox", SITE, CATS), { title: "Developer Forum | Roblox" },
  "the site name alone is left alone");
same(parseTitle("", SITE, CATS), { title: "" }, "empty in, empty out");

console.log("\n── pushRecent / sanitizeRecent ────────────────────────────────────");
const e = (id: number, at = id) => ({ id, slug: `s${id}`, title: `T${id}`, at });
same(pushRecent([e(1), e(2)], e(3), 12).map((x) => x.id), [3, 1, 2], "newest first");
same(pushRecent([e(1), e(2), e(3)], e(2, 9), 12).map((x) => x.id), [2, 1, 3], "a revisit moves up, and is not duplicated");
same(pushRecent([e(1), e(2), e(3)], e(4), 3).map((x) => x.id), [4, 1, 2], "the cap drops the oldest");

same(sanitizeRecent(null), [], "not an array → nothing");
same(sanitizeRecent([e(1), { id: "2", slug: "x", title: "y", at: 1 }, { id: 3, title: "   ", at: 1 }, { id: 4, slug: "s", title: "ok", at: "now" }]).map((x) => x.id), [1],
  "rows missing or mistyping a field are dropped");
same(sanitizeRecent([e(1), e(1)]).map((x) => x.id), [1], "a duplicate id is dropped");
same(sanitizeRecent([{ id: 5, title: "  t  ", at: 1, cat: " Scripting Support " }]), [{ id: 5, slug: "", title: "t", at: 1, cat: "Scripting Support" }],
  "slug defaults, strings are trimmed, cat is kept");
same(sanitizeRecent([{ id: 6, slug: "s", title: "t", at: 1, cat: 42 }]), [{ id: 6, slug: "s", title: "t", at: 1 }], "a non-string cat is dropped, the row is not");
eq(sanitizeRecent([e(1), e(2), e(3)], 2).length, 2, "the cap applies on read too");
eq(sanitizeRecent([{ id: 7, slug: "s", title: "x".repeat(500), at: 1 }])[0]?.title.length, 200, "titles are cut at 200");

console.log("\n── commandMatches: a prefix or word start, from two characters ────");
check(commandMatches("Theme: dark", "dark"), "the value after the colon");
check(commandMatches("Theme: dark", "th"), "two characters of the label");
check(commandMatches("Toggle thread view", "thread"), "a later word");
check(!commandMatches("Theme: dark", "ark"), "inside a word is not a match");
// The first keystroke of every topic search lit up every Theme row.
check(!commandMatches("Theme: dark", "t"), "one character is not a query");
check(!commandMatches("Density: compact", "d"), "…for any command");
check(!commandMatches("Theme: dark", ""), "nor is nothing");

console.log("\n── paletteEnabled: off when the master switch or the flag says so ─");
eq(paletteEnabled(DEFAULT_SETTINGS), true, "defaults: on");
eq(paletteEnabled({ ...DEFAULT_SETTINGS, modules: { "command-palette": false } as never }), false, "flag false: off");
eq(paletteEnabled({ ...DEFAULT_SETTINGS, modules: { "command-palette": true } as never }), true, "flag true: on");
/* root-attrs.ts drops data-dfp on the master switch, so an attached palette
 * here is an unstyled <button> in the forum header. */
eq(paletteEnabled({ ...DEFAULT_SETTINGS, enabled: false }), false, "master switch off: off");

console.log("\n── recentEnabled: the palette's flag, then its own ────────────────");
eq(recentEnabled(DEFAULT_SETTINGS), true, "defaults: on");
eq(recentEnabled({ ...DEFAULT_SETTINGS, modules: { "recent-topics": false } as never }), false, "its own flag false: off");
eq(recentEnabled({ ...DEFAULT_SETTINGS, modules: { "command-palette": false } as never }), false, "no palette, no list to show: off");
eq(recentEnabled({ ...DEFAULT_SETTINGS, enabled: false }), false, "master switch off: off");
eq(recentEnabled({ ...DEFAULT_SETTINGS, modules: { "command-palette": true, "recent-topics": true } as never }), true, "both true: on");

console.log("\n── age.ts: the shared wording ─────────────────────────────────────");
eq(ageLabel(OLD_AFTER), "2 yrs old", "exactly two years is old");
eq(ageLabel(OLD_AFTER - 1), "", "a day short of it is not");
eq(ageLabel(5.9 * YEAR), "5 yrs old", "floors, never rounds up");
const DAY = 86_400_000;
eq(agoLabel(0), "just now", "0 ms");
eq(agoLabel(59_000), "just now", "under a minute");
eq(agoLabel(5 * 60_000), "5 min ago", "minutes");
eq(agoLabel(3 * 3_600_000), "3 h ago", "hours");
eq(agoLabel(2 * DAY), "2 d ago", "days");
eq(agoLabel(15 * DAY), "2 w ago", "weeks");
eq(agoLabel(34 * DAY), "4 w ago", "four weeks and change is still weeks");
/* The list is capped by count, not age, so a row could read "37 w ago". */
eq(agoLabel(35 * DAY), "1 mo ago", "five weeks is a month");
eq(agoLabel(37 * 7 * DAY), "8 mo ago", "months, not thirty-seven weeks");
eq(agoLabel(YEAR - 1), "11 mo ago", "the last day of a year is still months");
eq(agoLabel(YEAR), "1 y ago", "a year");
eq(agoLabel(2.9 * YEAR), "2 y ago", "years floor too");
eq(agoLabel(Number.NaN), "just now", "a bad timestamp does not print NaN");

console.log("");
if (fail > 0) {
  console.log(`FAILED: ${fail} of ${pass + fail} checks`);
  process.exit(1);
}
console.log(`ALL PASS (${pass}/${pass} checks)`);
