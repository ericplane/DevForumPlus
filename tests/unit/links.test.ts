import { apiFromUrl } from "../../src/discourse/modules/docs-links";
import { docsUrl } from "../../src/discourse/modules/code-intel";

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
// The shipped expression, kept in step with topic-preview.ts by this test.
const TOPIC_HREF = /^\/t\/(?:(?!\d+(?:\/|$))[^/]+\/)?(\d+)(?:\/(\d+))?(?:[/?#]|$)/;
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
