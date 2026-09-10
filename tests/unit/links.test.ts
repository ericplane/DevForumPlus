import { apiFromUrl, apiFromInlineCode } from "../../src/discourse/modules/docs-links";
import { docsUrl } from "../../src/discourse/modules/code-intel";
import { TOPIC_HREF, topicIdFromPath } from "../../src/discourse/topic-data";

/**
 * Link parsing, for the two features that read a URL and promise something
 * about what is behind it.
 *
 * Both failures here are the same shape and both are worse than doing nothing:
 * a card that describes the WRONG thing. `/t/4301387/3191` parsed as topic 3191
 * — a real topic, entirely unrelated — because the slug arm happily matched a
 * bare number. And a docs URL for a page this bundle has never heard of would
 * open a card with nothing in it.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

// ── Topic links ─────────────────────────────────────────────────────────────
// The shipped expression itself, from topic-data.ts. It used to be a copy kept
// in step by hand; now topic-preview.ts, prefetch.ts and topicIdFromPath all
// import the one tested here.
const topic = (p: string) => {
  const m = TOPIC_HREF.exec(p);
  return m ? `${m[1]}${m[2] ? "#" + m[2] : ""}` : null;
};

console.log("── topic links ────────────────────────────────────────────────────");
eq(topic("/t/completing-the-dynamic-head-migration/4301387/3191"), "4301387#3191",
  "slug + topic + post");
eq(topic("/t/some-slug/4301387"), "4301387", "slug + topic");
// The bug: without the guard this answered "12", a different real topic.
eq(topic("/t/4301387/12"), "4301387#12", "slug-less form does not read the id as a slug");
eq(topic("/t/4301387"), "4301387", "slug-less topic");
eq(topic("/t/slug/4301387?u=x"), "4301387", "query string");
eq(topic("/t/slug/4301387/12#post_12"), "4301387#12", "fragment after a post number");
eq(topic("/c/help-and-feedback/55"), null, "a category is not a topic");
eq(topic("/u/someone"), null, "a profile is not a topic");

// `topicIdFromPath` reads `location.pathname` for every module on a topic
// page. It had its own `[^/]+/` slug arm, with the same trap: `/t/4301387/12`
// answered 12.
console.log("\n── topicIdFromPath ────────────────────────────────────────────────");
eq(topicIdFromPath("/t/some-slug/4301387"), 4301387, "slug + topic");
eq(topicIdFromPath("/t/some-slug/4301387/85"), 4301387, "slug + topic + post");
eq(topicIdFromPath("/t/4301387/12"), 4301387, "slug-less form keeps the topic id");
eq(topicIdFromPath("/t/4301387"), 4301387, "slug-less topic");
eq(topicIdFromPath("/t/some-slug/4301387/print"), 4301387, "print view");
eq(topicIdFromPath("/latest"), null, "a list is not a topic");

// ── Docs links ──────────────────────────────────────────────────────────────
console.log("\n── docs links ─────────────────────────────────────────────────────");
const doc = (p: string, h = "") => apiFromUrl(p, h);

eq(doc("/docs/reference/engine/classes/Humanoid"), "Humanoid", "class");
eq(doc("/docs/reference/engine/classes/Humanoid", "#Health"), "Humanoid.Health", "class member");
eq(doc("/en-us/docs/reference/engine/classes/Humanoid"), "Humanoid", "locale prefix");
eq(doc("/docs/reference/engine/datatypes/Vector3", "#new"), "Vector3.new", "datatype member");
eq(doc("/docs/reference/engine/libraries/task", "#wait"), "task.wait", "library member");
eq(doc("/docs/reference/engine/globals/LuaGlobals", "#print"), "globals.print", "lua global");
eq(doc("/docs/reference/engine/globals/RobloxGlobals", "#warn"), "globals.warn", "roblox global");

// Things that must NOT be marked — each would open a card with nothing in it.
eq(doc("/docs/reference/engine/globals/RobloxGlobals"), null, "a bucket page alone");
eq(doc("/docs/reference/engine/classes/NotAThing"), null, "unknown class");
eq(doc("/docs/reference/engine/libraries/nope"), null, "unknown library");
eq(doc("/docs/scripting/events/bindable-events"), null, "a guide, not a reference page");
eq(doc("/docs/reference/engine/enums/KeyCode", "#Space"), "KeyCode",
  "an enum ITEM falls back to the enum, which the card can answer");

// ── Inline code ─────────────────────────────────────────────────────────────
// `DataStoreService` written inline in a sentence is how most replies name an
// API — more often than by URL, more often than in a fenced block — and it got
// nothing. Exact membership only: the card must never open on a name the
// bundle cannot describe, and a backticked English word must never get one.
console.log("\n── inline code ────────────────────────────────────────────────────");
const inline = (t: string) => apiFromInlineCode(t);

eq(inline("DataStoreService"), "DataStoreService", "a class on its own");
eq(inline(" Humanoid "), "Humanoid", "surrounding whitespace is trimmed");
eq(inline("Vector3"), "Vector3", "a datatype (one digit is not an asset id)");
eq(inline("Humanoid.Health"), "Humanoid.Health", "Owner.Member");
eq(inline("Humanoid:TakeDamage()"), "Humanoid.TakeDamage", "Owner:Method() speaks the anchors' dotted form");
eq(inline("task.wait()"), "task.wait", "a library member");
eq(inline("Vector3.new"), "Vector3.new", "a constructor");
eq(inline("Enum.KeyCode"), "KeyCode", "an enum through Enum");
eq(inline("Enum.KeyCode.Space"), "KeyCode", "an enum ITEM falls back to the enum, as the URL form does");
eq(inline("print()"), "globals.print", "a bare global as a call");
eq(inline("wait()"), "globals.wait", "…a deprecated one too: the card describes, it does not scold");
eq(inline("game.Players"), "Players", "game.Service lands on the service, as it does in a block");
eq(inline("script.Parent"), "Script.Parent", "script resolves to the class it is");
eq(inline("ReplicatedStorage.Assets"), "ReplicatedStorage.Assets",
  "an unproven member ships; docs-card falls back to the owner's card");

// Things that must NOT be marked.
eq(inline("print"), null, "a bare global without parens is more often the word");
eq(inline("error"), null, "…`error` especially");
eq(inline("UpdateAsync"), null, "a member with no owner cannot be resolved");
eq(inline("BindToClose"), null, "…however API-shaped it looks");
eq(inline("Foo.Bar"), null, "an owner the bundle does not know");
eq(inline("Humanoid.Health.Changed"), null, "a third hop is a chain, not a reference");
eq(inline('game:GetService("Players")'), null, "arguments make it a statement");
eq(inline("local x = 1"), null, "whitespace and assignment make it code, not a name");
eq(inline("Part1234"), null, "four digits is an asset id, or shaped like one");
eq(inline("rbxassetid://1234567"), null, "an asset id belongs to asset-preview");
eq(inline(""), null, "empty");
// Not a bucket: `Enum` has a datatype page of its own, and that is what opens.
eq(inline("Enum"), "Enum", "Enum on its own is the Enum datatype");

// ── The two must agree ──────────────────────────────────────────────────────
// `docsUrl` builds these; `apiFromUrl` reads them. A change to either that is
// not mirrored shows up here rather than as a silently dead hover.
console.log("\n── docsUrl() and apiFromUrl() are inverses ────────────────────────");
for (const api of ["Humanoid", "Humanoid.Health", "Vector3.new", "task.wait", "globals.print"]) {
  const url = new URL(docsUrl(api));
  eq(apiFromUrl(url.pathname, url.hash), api, `round-trip ${api}`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
