import {
  composerState,
  draftContext,
  fenceNoteStays,
  fencePaste,
  foldLegacyDraft,
  insideFence,
  luauFence,
  menuLabel,
  pruneDrafts,
  settleSubmit,
  topicOf,
  undoFencedPaste,
  wantsLuauFence,
  type ComposerState,
} from "../../src/isolated/composer";

/**
 * The composer's pure parts.
 *
 * The wiring itself needs a live composer, and its one real bug — bailing on
 * every REPLY because a reply has no title field, so the Luau button and the
 * draft vault only ever worked for new topics — was found by opening one, not
 * by a test. What a test can hold is the logic underneath: which slot a
 * composer's draft lives in and when the store lets go of one, what the Luau
 * button inserts, and the three decisions a paste goes through before it is
 * fenced — is the caret already in a fence, is this Luau at all, and can the
 * fence be undone in place.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

// ── topicOf ─────────────────────────────────────────────────────────────────

console.log("── topicOf ───────────────────────────────────────────────────────");
eq(topicOf("/t/scribe-v230/4738905"), "4738905", "slug + id");
eq(topicOf("/t/scribe-v230/4738905/85"), "4738905", "slug + id + post number");
// The trap from links.test.ts: a slug-less path must not read the id as a slug.
eq(topicOf("/t/4738905/85"), "4738905", "slug-less form keeps the topic id");
eq(topicOf("/t/4738905"), "4738905", "slug-less, no post");
eq(topicOf("/latest"), null, "a list is not a topic");
eq(topicOf("/c/resources/71"), null, "a category is not a topic");

// ── draftContext ────────────────────────────────────────────────────────────

console.log("── draftContext ──────────────────────────────────────────────────");
eq(draftContext("createTopic", true, "/latest"), "new-topic", "new topic from a list page");
eq(draftContext("createTopic", true, "/t/slug/99"), "new-topic", "new topic from inside a topic: still one slot");
eq(draftContext("reply", false, "/t/scribe-v230/4738905/85"), "topic:4738905", "reply keyed by its topic");
// The composer stays open across navigation, so the caller passes the header
// link's href rather than the location — but a bare path must still key.
eq(draftContext("reply", false, "/latest"), "topic:/latest", "reply with no topic in the path keeps a key");
eq(draftContext("privateMessage", true, "/u/someone/messages"), "pm", "messages share one slot");
eq(draftContext("edit", false, "/t/slug/99/3"), null, "an edit is never kept");
eq(draftContext("edit", true, "/t/slug/99"), null, "…even when it is the first post and shows a title");
// No composer-action class at all: the title field decides, as it did before.
eq(draftContext(null, true, "/latest"), "new-topic", "unknown action with a title is a topic");
eq(draftContext(null, false, "/t/slug/99"), "topic:99", "unknown action without one is a reply");

// ── pruneDrafts ─────────────────────────────────────────────────────────────

console.log("── pruneDrafts ───────────────────────────────────────────────────");
const now = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const d = (at: number) => ({ title: "", body: "x".repeat(40), at });

const aged = pruneDrafts({ fresh: d(now - DAY), stale: d(now - 8 * DAY) }, now);
check("fresh" in aged && !("stale" in aged), "a week-old draft is dropped, a day-old one kept");
check("edge" in pruneDrafts({ edge: d(now - 7 * DAY) }, now), "exactly seven days is still kept");

const many: Record<string, ReturnType<typeof d>> = {};
for (let i = 0; i < 14; i++) many[`topic:${i}`] = d(now - i * 1000);
const capped = pruneDrafts(many, now);
eq(Object.keys(capped).length, 10, "capped at ten slots");
check("topic:0" in capped && "topic:9" in capped, "the ten newest survive");
check(!("topic:10" in capped) && !("topic:13" in capped), "the oldest go first");

// ── foldLegacyDraft ─────────────────────────────────────────────────────────

console.log("── foldLegacyDraft ───────────────────────────────────────────────");
const legacy = (over: Record<string, unknown>) => ({ title: "", body: "x".repeat(40), at: now, ...over });
// The reviewer's case: `null` in the old slot passed `!== undefined` and threw
// on the destructure, so nothing after it — the key's removal included — ran.
const nullSlot = (() => {
  try {
    return foldLegacyDraft({}, null);
  } catch {
    return "threw";
  }
})();
eq(JSON.stringify(nullSlot), "{}", "a stored null folds to nothing and does not throw");
eq(JSON.stringify(foldLegacyDraft({}, "dfp:draft")), "{}", "a string is not a draft");
eq(JSON.stringify(foldLegacyDraft({}, { title: "t", body: "b" })), "{}", "a draft with no `at` is not one");
check("new-topic" in foldLegacyDraft({}, legacy({ title: "A title", path: "/latest" })), "a titled draft was a new topic");
check("new-topic" in foldLegacyDraft({}, legacy({ kind: "topic", path: "/t/slug/99" })), "…and so was one marked `topic`, title or not");
check("topic:99" in foldLegacyDraft({}, legacy({ path: "/t/slug/99/3" })), "an untitled draft was a reply, keyed by its path's topic");
check("topic:99" in foldLegacyDraft({}, legacy({ kind: "reply", title: "kept", path: "/t/slug/99" })), "`kind` wins over the title");
eq(JSON.stringify(foldLegacyDraft({}, legacy({ path: "/latest" }))), "{}", "a reply with no topic in its path has nowhere to go");
eq(JSON.stringify(foldLegacyDraft({}, legacy({}))), "{}", "…or no path at all");
const kept = foldLegacyDraft({ "new-topic": d(now - 1000) }, legacy({ title: "older", at: now - 5000 }));
eq(kept["new-topic"].at, now - 1000, "a slot already written is not overwritten");
const folded = foldLegacyDraft({}, legacy({ title: "T", kind: "topic", path: "/x" }));
eq(JSON.stringify(Object.keys(folded["new-topic"])), '["title","body","at"]', "only the draft's own fields are kept");

// ── luauFence ───────────────────────────────────────────────────────────────

console.log("── luauFence ─────────────────────────────────────────────────────");
const empty = luauFence("", 0, 0);
eq(empty.value, "```lua\n\n```\n", "empty body");
eq(empty.caret, 7, "caret lands inside the fence");
eq(empty.length, 0, "nothing selected");

const afterProse = luauFence("text", 4, 4);
eq(afterProse.value, "text\n```lua\n\n```\n", "a fence after prose starts on its own line");
eq(afterProse.caret, 12, "caret past the added newline");

const afterNewline = luauFence("text\n", 5, 5);
eq(afterNewline.value, "text\n```lua\n\n```\n", "no second newline when one is already there");

const wrapped = luauFence("a\nprint(1)\nb", 2, 10);
eq(wrapped.value, "a\n```lua\nprint(1)\n```\n\nb", "wraps the selection");
eq(wrapped.caret, 9, "caret at the start of the selection");
eq(wrapped.length, 8, "selection kept selected");

// ── insideFence ─────────────────────────────────────────────────────────────

console.log("── insideFence ───────────────────────────────────────────────────");
const doc = "intro\n```lua\nlocal a = 1\n```\noutro\n~~~\nmore\n";
check(!insideFence(doc, 0), "start of the document is outside");
check(!insideFence(doc, 5), "prose before the first fence is outside");
check(insideFence(doc, doc.indexOf("local")), "inside the lua fence");
check(insideFence(doc, doc.indexOf("\n```\noutro") + 1), "on the closing fence's line, before it closes, is inside");
check(!insideFence(doc, doc.indexOf("outro")), "after the closing fence is outside");
check(insideFence(doc, doc.indexOf("more")), "a tilde fence counts too");
check(!insideFence("use ``` inline", 14), "three ticks mid-line are not a fence");
check(insideFence("   ```lua\nx", 10), "up to three spaces of indent still opens one");
check(!insideFence("    ```lua\nx", 11), "four spaces is an indented code line, not a fence");

// ── wantsLuauFence ──────────────────────────────────────────────────────────

console.log("── wantsLuauFence ────────────────────────────────────────────────");
const studio = 'local Players = game:GetService("Players")\r\n\r\nPlayers.PlayerAdded:Connect(function(p)\r\n\tprint(p.Name)\r\nend)\r\n';
check(wantsLuauFence(studio), "a Studio paste (CRLF, trailing newline) is fenced");
check(wantsLuauFence("for i = 1, 10 do\n\tprint(i)\nend"), "three lines of structure, no signal keyword");
check(!wantsLuauFence('local Players = game:GetService("Players")'), "a one-liner is not");
check(!wantsLuauFence("local a = 1\nlocal b = 2"), "two lines are not");
check(!wantsLuauFence("local a = 1\n\n\n\n"), "blank lines do not make up the count");
check(!wantsLuauFence("```lua\nlocal a = 1\nprint(a)\n```"), "already fenced: left alone");
check(!wantsLuauFence("~~~\nlocal a = 1\nprint(a)\n~~~"), "…with tildes too");
// The sniff's own example: a bare `end` proves nothing without an opener.
check(!wantsLuauFence("read the thread\nto the end please\nand reply there"), "prose with an `end` is not Luau");
check(!wantsLuauFence("def f(x):\n    for x in y:\n        return line[start:end]"), "Python is not Luau");
check(!wantsLuauFence("{\n  \"end\": 2,\n  \"function\": \"then\"\n}"), "JSON is not Luau");

// ── fencePaste / undoFencedPaste ────────────────────────────────────────────

console.log("── fencePaste ────────────────────────────────────────────────────");
const code = "local a = 1\nprint(a)\n";
const p1 = fencePaste("", 0, 0, code);
eq(p1.value, "```lua\nlocal a = 1\nprint(a)\n```\n", "trailing newline trimmed inside the fence");
eq(p1.at, 0, "block starts where the paste went");
eq(p1.block, p1.value, "with nothing around it, the block is the whole value");
eq(p1.caret, p1.value.length, "caret after the closing fence");
eq(p1.text, code, "raw paste kept whole, newline and all");

const p2 = fencePaste("before|after", 6, 7, "local a = 1\r\nprint(a)\r\nprint(a)");
eq(p2.value, "before\n```lua\nlocal a = 1\nprint(a)\nprint(a)\n```\nafter", "replaces the selection, CRLF normalised, own line");
eq(p2.at, 6, "block starts at the selection");
eq(p2.block, "\n```lua\nlocal a = 1\nprint(a)\nprint(a)\n```\n", "block includes the lead newline");
eq(p2.caret, 6 + p2.block.length, "caret sits at the start of `after`");

console.log("── undoFencedPaste ───────────────────────────────────────────────");
const u1 = undoFencedPaste(p1.value, p1);
eq(u1?.value, code, "undo restores the raw paste");
eq(u1?.caret, code.length, "caret at the end of the raw paste");

const u2 = undoFencedPaste(p2.value, p2);
eq(u2?.value, "before" + "local a = 1\nprint(a)\nprint(a)" + "after", "undo drops the lead newline with the fence");
eq(u2?.caret, 6 + "local a = 1\nprint(a)\nprint(a)".length, "caret after the raw paste");

const typedAfter = p2.value + " and then some prose";
const u3 = undoFencedPaste(typedAfter, p2);
eq(u3?.value, "before" + "local a = 1\nprint(a)\nprint(a)" + "after and then some prose", "typing after the block does not defeat undo");

const editedInside = p2.value.replace("print(a)\nprint(a)", "print(b)");
eq(undoFencedPaste(editedInside, p2), null, "editing inside the block does");

// ── fenceNoteStays ──────────────────────────────────────────────────────────

console.log("── fenceNoteStays ────────────────────────────────────────────────");
// The floor is a floor, not a ceiling: the note outlives it while nothing has
// been typed, and an edit inside it does not take the undo away early.
check(fenceNoteStays(60_000, false), "a minute on, untouched: still up");
check(fenceNoteStays(1_000, true), "typed after one second: still up until the floor");
check(!fenceNoteStays(5_000, true), "typed, and the floor passed: gone");
check(!fenceNoteStays(60_000, true), "typed a minute on: gone");

// ── composerState ───────────────────────────────────────────────────────────

console.log("── composerState ─────────────────────────────────────────────────");
eq(composerState("open composer-action-createTopic ember-view"), "open", "open");
eq(composerState("fullscreen composer-action-reply show-preview ember-view"), "open", "fullscreen is the same editor, larger");
// The class string transcribed into tests/visual/fixture.html from the live DOM.
eq(composerState("saving composer-action-reply show-preview ember-view"), "saving", "saving: the request is out");
eq(composerState("draft composer-action-reply ember-view"), "draft", "minimised");
eq(composerState("closed ember-view"), "closed", "closed");
eq(composerState(""), "closed", "no class at all is closed");
eq(composerState(undefined), "closed", "no node at all is closed");
// The state is a whole class, never a prefix: `opened` is not `open`.
eq(composerState("opened composer-action-reply"), "closed", "a prefix match is not a state");

// ── settleSubmit ────────────────────────────────────────────────────────────

console.log("── settleSubmit ──────────────────────────────────────────────────");
/** Feed a sequence of states through the step and collect what it spends. */
const run = (submitted: string | null, states: ComposerState[]) => {
  let s = submitted;
  let inFlight = false;
  const spent: string[] = [];
  for (const state of states) {
    const next = settleSubmit(state, s, inFlight);
    s = next.submitted;
    inFlight = next.inFlight;
    if (next.spend) spent.push(next.spend);
  }
  return { submitted: s, inFlight, spent: spent.join(",") };
};

const accepted = run("new-topic", ["saving", "closed"]);
eq(accepted.spent, "new-topic", "accepted: saving then closed spends the draft");
eq(accepted.submitted, null, "…and the name is cleared");
eq(accepted.inFlight, false, "…and nothing is in flight");

// The reviewer's case: a 422 reopens the composer with the text intact, and
// the copy must still be in the vault when it does.
const refused = run("new-topic", ["saving", "open"]);
eq(refused.spent, "", "refused: saving then open spends nothing");
eq(refused.submitted, null, "…and withdraws the name, so a later close keeps the copy");
eq(run("new-topic", ["saving", "open", "closed"]).spent, "", "…even when the author then gives up and closes");
eq(run("new-topic", ["saving", "open", "draft", "closed"]).spent, "", "…or minimises first");

// Minimising is not closing, and fullscreen is not either.
eq(run("topic:99", ["draft"]).spent, "", "minimised spends nothing");
eq(run("topic:99", ["draft"]).submitted, "topic:99", "…and keeps the name for the close that follows");
eq(run("topic:99", ["draft", "closed"]).spent, "topic:99", "close from the minimised bar spends a named submit");
eq(run("topic:99", ["open", "open"]).spent, "", "fullscreen toggles (open → open) spend nothing");
eq(run("topic:99", ["open", "open"]).submitted, "topic:99", "…and keep the name");

// Both class flips landing in one observer callback, which reads only `closed`.
eq(run("pm", ["closed"]).spent, "pm", "a close that never showed saving still spends");

// Steady states are no-ops; the step is safe to run on every mutation.
eq(run(null, ["open", "open", "closed", "closed", "saving", "open"]).spent, "", "nothing named, nothing spent");
eq(run(null, ["saving", "open"]).inFlight, false, "an unnamed save still settles");

// ── menuLabel ───────────────────────────────────────────────────────────────

console.log("── menuLabel ─────────────────────────────────────────────────────");
eq(menuLabel("toggle-spreadsheet"), "Insert table", "the table builder's id, mapped");
eq(menuLabel("Hide Details"), "Hide Details", "a translated name passes through");
eq(menuLabel("insert_footnote"), "Insert footnote", "an untranslated id is humanised");

console.log("");
if (fail > 0) {
  console.log(`FAILED: ${fail} of ${pass + fail} checks`);
  process.exit(1);
}
console.log(`ALL PASS (${pass}/${pass} checks)`);
