import {
  isInbound,
  isRequest,
  isRoutePath,
  type Diagnostics,
  type Push,
  type Request,
} from "../../src/core/bridge/protocol";
import type { ModuleRecord } from "../../src/core/registry";
import { DEFAULT_SETTINGS } from "../../src/core/settings-schema";

/**
 * The bridge validator, against its own request union.
 *
 * This file exists because `strikes:clear` was declared in `Request`, sent by
 * `MainBridge.clearStrike`, and fully handled by `IsolatedBridge` — but missing
 * from `isRequest`'s switch, so it was dropped on arrival for its entire life.
 * Nothing caught it: `v["t"]` is `unknown` inside the validator, so an unlisted
 * case is indistinguishable from a hostile message, and the `default` fails
 * closed exactly as it should. The failure was silent and one-directional —
 * strike counters could only ever go up.
 *
 * The guard is `Record<Request["t"], …>` below. It is total over the union, so
 * adding a variant to `Request` without adding a sample here is a COMPILE
 * error, and the sample then fails at runtime until the validator learns it.
 * Both halves are needed: the type catches the omission, the assertion proves
 * the validator actually accepts it.
 */

/* One installed module in the sample, so the accept path exercises the record
 * validator and not just the empty-array case. Typed, so the sample cannot
 * drift from the shape the registry actually sends. */
const record: ModuleRecord = {
  id: "code-intel",
  status: "installed",
  installMs: 0.1,
  workMs: 7.2,
  budgetMs: 100,
  strikes: 0,
};

const diagnostics: Diagnostics = {
  rung: "post-boot",
  pluginApiVersion: "1.39.2",
  bootMs: 12,
  modules: [record],
  notes: [],
};

const withModule = (patch: Record<string, unknown>) => ({
  ...diagnostics,
  modules: [{ ...record, ...patch }],
});

/* One well-formed sample per variant. Typed as a total record so the compiler
 * refuses a missing key. */
const SAMPLES: Record<Request["t"], Request> = {
  "settings:get": { id: 1, t: "settings:get" },
  "strikes:get": { id: 2, t: "strikes:get" },
  "strikes:bump": { id: 3, t: "strikes:bump", module: "code-intel", ms: 42 },
  "strikes:clear": { id: 4, t: "strikes:clear", module: "code-intel" },
  "diag:push": { id: 5, t: "diag:push", diagnostics },
};

/* Messages that must NOT get through. The validator runs on the ISOLATED side,
 * which is the only half with chrome.* access, so a false accept here is the
 * one that reaches storage. */
const REJECT: [string, unknown][] = [
  ["not an object", "strikes:clear"],
  ["null", null],
  ["no id", { t: "strikes:clear", module: "code-intel" }],
  ["id is not a number", { id: "4", t: "strikes:clear", module: "code-intel" }],
  ["unknown verb", { id: 6, t: "strikes:nuke", module: "code-intel" }],
  // A module id is an allow-list, not a string. Without this check the isolated
  // side would write an attacker-chosen key into extension storage.
  ["clear with an unknown module", { id: 7, t: "strikes:clear", module: "../../etc" }],
  ["clear with no module", { id: 8, t: "strikes:clear" }],
  ["bump with no ms", { id: 9, t: "strikes:bump", module: "code-intel" }],
  ["bump with an unknown module", { id: 10, t: "strikes:bump", module: "nope", ms: 1 }],
  ["diag with a bogus rung", { id: 11, t: "diag:push", diagnostics: { ...diagnostics, rung: "x" } }],
  /* The popup does arithmetic on `workMs` and `budgetMs`; a record without
   * them used to pass (modules was "any array") and would render "NaN ms". */
  ["diag module with no workMs", { id: 12, t: "diag:push", diagnostics: withModule({ workMs: undefined }) }],
  ["diag module with a string budget", { id: 13, t: "diag:push", diagnostics: withModule({ budgetMs: "100" }) }],
  ["diag module with a bogus status", { id: 14, t: "diag:push", diagnostics: withModule({ status: "sleeping" }) }],
  ["diag module with an unknown id", { id: 15, t: "diag:push", diagnostics: withModule({ id: "nope" }) }],
  ["diag module with a non-string error", { id: 16, t: "diag:push", diagnostics: withModule({ error: 42 }) }],
  ["diag with a non-string note", { id: 17, t: "diag:push", diagnostics: { ...diagnostics, notes: [1] } }],
];

/* The other direction. `Push` is what ISOLATED sends unsolicited and MAIN
 * validates with `isInbound`; the same total-record guard applies, so a Push
 * variant without a sample here does not compile. */
const PUSHES: Record<Push["t"], Push> = {
  "settings:changed": { t: "settings:changed", settings: DEFAULT_SETTINGS },
  "nav:route": { t: "nav:route", href: "/t/some-slug/4301387" },
};

/* Paths `nav:route` must carry, and the ones it must not. MAIN hands the
 * string to Discourse's router, which redirects anything it decides is
 * external, so a URL that names another origin — or one a browser would read
 * as naming another origin — is refused before it gets that far. */
const ROUTE_OK = [
  "/",
  "/latest",
  "/c/scripting/55",
  "/search?q=task%20wait",
  "/t/4301387/12#reply",
  // Non-ASCII is a path the parser percent-encodes, not one it strips.
  "/c/日本語/55",
];
/* Built from char codes rather than written as escapes, so the characters
 * under test are unmistakably the raw bytes and not whatever an editor or a
 * tool made of `\n`. */
const ch = (code: number) => String.fromCharCode(code);
const ROUTE_BAD: [string, unknown][] = [
  ["an absolute URL", "https://evil.example/"],
  ["a protocol-relative URL", "//evil.example"],
  ["a backslash second, which Chrome reads as //", "/\\evil.example"],
  /* The URL parser strips ASCII tab, LF and CR before it parses, so each of
   * these passed the leading-slash test and reached `location.assign` as
   * `//evil.example`. */
  ["a newline that the URL parser would strip", "/" + ch(10) + "/evil.example"],
  ["a carriage return, likewise", "/" + ch(13) + "/evil.example"],
  ["a tab, likewise", "/" + ch(9) + "/evil.example"],
  ["a NUL", "/latest" + ch(0)],
  ["a raw space, which a built path never carries", "/search?q=task wait"],
  ["a relative path", "latest"],
  ["an empty string", ""],
  ["a javascript: URL", "javascript:alert(1)"],
  ["a non-string", 42],
  ["a path over the cap", "/" + "a".repeat(2048)],
];

const REJECT_INBOUND: [string, unknown][] = [
  ["settings:changed without settings", { t: "settings:changed" }],
  ["an unknown push", { t: "nav:reload" }],
  ["a route with no href", { t: "nav:route" }],
  ["a route to another origin", { t: "nav:route", href: "https://evil.example/" }],
  ["a response without ok", { id: 1, data: null }],
];

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};

console.log("── every declared request variant is accepted ─────────────────────────");
for (const [verb, sample] of Object.entries(SAMPLES)) {
  check(isRequest(sample), `${verb} round-trips the validator`);
}

console.log("\n── malformed and hostile messages are dropped ─────────────────────────");
for (const [label, message] of REJECT) {
  check(!isRequest(message), `rejected: ${label}`);
}

console.log("\n── every declared push variant is accepted by MAIN ─────────────────────");
for (const [verb, sample] of Object.entries(PUSHES)) {
  check(isInbound(sample), `${verb} round-trips isInbound`);
}
check(isInbound({ id: 3, ok: true, data: null }), "an ok response round-trips isInbound");
check(isInbound({ id: 4, ok: false, error: "no" }), "an error response round-trips isInbound");

console.log("\n── nav:route carries a same-origin path and nothing else ───────────────");
for (const href of ROUTE_OK) {
  check(isRoutePath(href), `accepted: ${href}`);
  check(isInbound({ t: "nav:route", href }), `…and as a push`);
}
for (const [label, href] of ROUTE_BAD) {
  check(!isRoutePath(href), `rejected: ${label}`);
  check(!isInbound({ t: "nav:route", href }), `…and as a push`);
}
check(isRoutePath("/" + "a".repeat(2047)), "a path exactly at the cap is accepted");

console.log("\n── malformed inbound messages are dropped ──────────────────────────────");
for (const [label, message] of REJECT_INBOUND) {
  check(!isInbound(message), `rejected: ${label}`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
