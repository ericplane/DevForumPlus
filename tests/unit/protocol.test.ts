import { isRequest, type Diagnostics, type Request } from "../../src/core/bridge/protocol";

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

const diagnostics: Diagnostics = {
  rung: "post-boot",
  pluginApiVersion: "1.39.2",
  bootMs: 12,
  modules: [],
  notes: [],
};

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

const total = Object.keys(SAMPLES).length + REJECT.length;
console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${total} checks)`);
process.exit(fail === 0 ? 0 : 1);
