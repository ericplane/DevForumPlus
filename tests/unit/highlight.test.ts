/**
 * The spec for the colouring layer.
 *
 * `detect.test.ts` covers what a snippet *means* — which APIs in it are
 * deprecated. Nothing covered what it *looks like*: until this file, nothing in
 * the repo imported `segment()` at all, so every token class, every docs link
 * and the block sniff that decides whether any of it runs were shipped on
 * inspection alone. That is the layer where a regression is invisible in code
 * review and obvious on screen.
 *
 * Read it as the spec, not as a change detector. Every case below is one where
 * getting it wrong produced a specific visible failure — the wrong colour, a
 * link to somebody else's class, a whole block greyed out — and the comment says
 * which. A case with no such story does not belong here.
 *
 * Two entry points, deliberately:
 *
 *   `segment()`       the public one, which returns the (text, class, api) run.
 *   `renderCodeBlock` the module's real decorator, driven through the small DOM
 *                     in `dom-stub.ts`. `isLuauBlock` and `renderBlock` are
 *                     module-private and should stay that way, so the sniff and
 *                     the emitted markup are tested through what actually runs.
 *
 * Plain tsx, no framework — same as detect.test.ts. `npm test` runs both.
 */

import { segment, enhancePreview } from "../../src/discourse/modules/code-intel";
import {
  renderCodeBlock,
  getPreviewDecorator,
  observerFor,
  activeElement,
  serialize,
  DElement,
  DText,
} from "./dom-stub";

let pass = 0;
let fail = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${label}` +
      (ok ? "" : `\n         expected ${e}\n         got      ${a}`),
  );
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}

/**
 * Every segment that carries ink, as `"<text>" <class>`. Whitespace-only
 * segments are dropped — they have no colour.
 *
 * The text is quoted because several cases below turn on exactly which spaces
 * and newlines a token swallowed, and `` `hp ` `` against `` `hp  `` is not a
 * difference anyone should have to count in a diff.
 */
function shape(src: string): string[] {
  return segment(src)
    .filter((s) => s.text.trim() !== "")
    .map((s) => `${JSON.stringify(s.text)} ${s.cls ?? "—"}`);
}

/** The class on each segment spelled exactly `text`, in source order. */
function classes(src: string, text: string): string[] {
  return segment(src).filter((s) => s.text === text).map((s) => s.cls ?? "—");
}

/** The Creator Docs reference on each segment spelled exactly `text`. */
function apis(src: string, text: string): string[] {
  return segment(src).filter((s) => s.text === text).map((s) => s.api ?? "—");
}

/** Every docs reference in the snippet, in source order. */
function allApis(src: string): string[] {
  return segment(src).flatMap((s) => (s.api ? [`${s.text} → ${s.api}`] : []));
}

/** `"<text> <severity>"` for every deprecation mark. */
function marks(src: string): string[] {
  return segment(src).flatMap((s) => (s.finding ? [`${s.text} ${s.finding.entry.severity}`] : []));
}

/** The nested (text, class) pieces inside the mark whose whole text is `text`. */
function parts(src: string, text: string): string[] {
  const seg = segment(src).find((s) => s.text === text && s.parts);
  return (seg?.parts ?? []).map((p) => `${JSON.stringify(p.text)} ${p.cls ?? "—"}`);
}

/* ════════════════════════════════════════════════════════════════════════
 * 1. The block sniff
 *
 * An unfenced `<pre>` is the common case in Scripting Support, so something has
 * to guess. The guess used to be `/\b(local|function|end|then|elseif)\b/ &&
 * /\bend\b/` — and because `end` was in both halves the whole expression reduced
 * to `/\bend\b/`. Every block below that expects `false` was claimed as Luau by
 * that version and had its `wait`/`spawn` underlined as deprecated Roblox API.
 * The two signals must stay disjoint: a bare `end` proves nothing.
 * ════════════════════════════════════════════════════════════════════════ */
section("block sniff — what gets Luau colouring at all");

const ONE_LINER = `local Players = game:GetService("Players")`;
const canary = renderCodeBlock(ONE_LINER);

/* First, and first on purpose. `decorate.ts` swallows exceptions so one bad post
 * cannot kill a sweep, which means a hole in the DOM stub looks exactly like a
 * rejected block. If this case fails, believe nothing below it. */
check("a GetService one-liner is Luau", canary.luau, true);
check(
  "…and it really rendered (canary: proves the stub can complete a render)",
  canary.html.startsWith('<span class="dfp-tok-kw">local</span>'),
  true,
);

const gate: [string, string, string, boolean][] = [
  // The four false positives the old sniff produced, verbatim from the corpus.
  ["python slice", "", "def tail(line, start, end):\n    return line[start:end]\n", false],
  ["js slice", "", "function trim(s, start, end) {\n  return s.slice(start, end);\n}", false],
  ["sql range", "", "SELECT id FROM plots WHERE id BETWEEN start AND end;", false],
  ["english prose", "", "Please read the thread to the end before replying, it is answered above.", false],
  // Two more shapes that live in forum <pre> blocks.
  ["json", "", '{ "start": 1, "end": 2, "name": "thing" }', false],
  ["shell transcript", "", "$ npm run build\n  built in 4.2s -> see logs/end.txt", false],

  /* An opener and a real `end` on ONE line. Anchoring `end` to the start of a
   * line would reject this, and it is the single most-pasted shape on the
   * forum — a Touched handler quoted as one statement. */
  ["one-line connect handler", "", "part.Touched:Connect(function(hit) hit:Destroy() end)", true],
  // A long comment is syntax no other language in a <pre> produces.
  ["long comment", "", "--[=[ nothing here but a long comment ]=]", true],
  // Under 12 characters there is nothing to go on, so nothing is claimed.
  ["too short to judge", "", "wait(1)", false],

  /* A class on the <code> is the author saying what the block is, so it decides
   * outright — in both directions. `lang-luajit` must not match `lang-lua`. */
  ["lang-lua fence wins over content", "lang-lua", "this block is fenced but is not luau at all", true],
  ["lang-luau fence wins too", "lang-luau", "this block is fenced but is not luau at all", true],
  ["lang-luajit is not lang-lua", "lang-luajit", "this block is fenced but is not luau at all", false],
  ["a foreign fence is respected", "lang-javascript", ONE_LINER, false],

  /* Known accepted limitation, recorded rather than hidden: a classless JS block
   * that both contains `function` and returns a bare variable named `end`. Every
   * other shape (`end` as a parameter, an argument, an object key, an index)
   * rejects above. Closing this one needs a parser, not a regex — so if you fix
   * it, flip this line rather than deleting it. */
  ["js with a variable named `end` (known limit)", "", "function x() { const end = 1; return end; }", true],
];

for (const [label, cls, src, expected] of gate) {
  check(label, renderCodeBlock(src, cls).luau, expected);
}

/* ════════════════════════════════════════════════════════════════════════
 * 2. Type positions are one colour
 *
 * The failure was never "one token is the wrong colour". In a single signature
 * `number` came out unstyled, `string` in builtin blue and `boolean` in the gold
 * reserved for `:Connect` — three annotations reading as three different kinds
 * of thing. Type-ness is a position, not a lexeme, so every position has to
 * agree.
 * ════════════════════════════════════════════════════════════════════════ */
section("type positions");

const SIGNATURE = "local function f(a: number, b: string): boolean\n\treturn true\nend";
check(
  "all three annotations in one signature are dfp-tok-type",
  [classes(SIGNATURE, "number"), classes(SIGNATURE, "string"), classes(SIGNATURE, "boolean")],
  [["dfp-tok-type"], ["dfp-tok-type"], ["dfp-tok-type"]],
);

/* Both fields are the same idea written the same way. The comma arm used to
 * rescue every field but the first, so `x` was plain and `y` was a type. */
check(
  "both fields of `type Point = { x: number, y: number }` match",
  classes("type Point = { x: number, y: number }", "number"),
  ["dfp-tok-type", "dfp-tok-type"],
);

check(
  "the name a `type` alias declares is a type, not an identifier",
  classes("type Point = {}", "Point"),
  ["dfp-tok-type"],
);

/* The whole right-hand side of an alias is a type, however it is spelled — but
 * only the NAMES take the type colour. Parens and arrows are punctuation
 * wherever they appear, so the type class stays names-only. */
check(
  "in `type Handler = (msg: string) -> ()` the parens stay punctuation",
  shape("type Handler = (msg: string) -> ()"),
  [
    `"type" dfp-tok-kw`, `"Handler" dfp-tok-type`, `"=" dfp-tok-op`, `"(" dfp-tok-op`,
    `"msg" —`, `":" dfp-tok-op`, `"string" dfp-tok-type`, `")" dfp-tok-op`,
    `"->" dfp-tok-op`, `"(" dfp-tok-op`, `")" dfp-tok-op`,
  ],
);

check(
  "a generic argument list is types: `Array<string>`",
  classes("local a: Array<string> = {}", "string"),
  ["dfp-tok-type"],
);

/* The other direction, and the expensive one: a `:` in front of a name is a
 * method call far more often than it is an annotation. Each of these puts a
 * `(`, `,` or `)` where a parameter list puts one. */
check(
  "a call's `(` does not make its contents types",
  classes("print(obj:GetName())", "GetName"),
  ["dfp-tok-method"],
);
check(
  "a `)` closing a CALL is not a return-type colon",
  classes('game:GetService("Players"):FindFirstChild("x")', "FindFirstChild"),
  ["dfp-tok-method"],
);
check(
  "a table CONSTRUCTOR is not a table type",
  classes("local t = { f(), obj:Method() }", "Method"),
  ["dfp-tok-method"],
);

/* ════════════════════════════════════════════════════════════════════════
 * 3. Contextual keywords
 *
 * `type` is reserved only where it declares. Purple on `type(v)` two tokens away
 * from a builtin-blue `typeof(v)` said the two were different kinds of thing,
 * and `config.type` was purple in the one position a reserved word cannot
 * appear — where it did not even get the field colour `config.name` gets.
 * ════════════════════════════════════════════════════════════════════════ */
section("contextual keywords");

check(
  "type(v) and typeof(v) are both the stdlib function",
  [classes("print(type(v), typeof(v))", "type"), classes("print(type(v), typeof(v))", "typeof")],
  [["dfp-tok-builtin"], ["dfp-tok-builtin"]],
);
check(
  "config.type is a field, exactly like config.name",
  [classes("print(config.type, config.name)", "type"), classes("print(config.type, config.name)", "name")],
  [["dfp-tok-prop"], ["dfp-tok-prop"]],
);
check(
  "…and `type` keeps the keyword colour where it declares",
  classes("type Point = {}", "type"),
  ["dfp-tok-kw"],
);

/* ════════════════════════════════════════════════════════════════════════
 * 4. Interpolated strings
 *
 * Backticks are not Lua at all, which is a third of the reason this tokenizer
 * exists. Two separate failures lived here: the interior was one opaque string
 * token, so an expression inside a template lost the colouring and the docs
 * links it gets three characters outside one; and there was no newline bail, so
 * a single stray backtick collapsed every following line into one string span,
 * taking every mark and link on those lines with it.
 * ════════════════════════════════════════════════════════════════════════ */
section("interpolated strings");

const TEMPLATE = "local hum: Humanoid = nil\nlocal s = `hp {hum.Health}`\nprint(hum.Health)";
check(
  "an expression inside a template resolves the same as outside one",
  apis(TEMPLATE, "Health"),
  ["Humanoid.Health", "Humanoid.Health"],
);
check(
  "…and it is coloured the same too",
  classes(TEMPLATE, "Health"),
  ["dfp-tok-prop", "dfp-tok-prop"],
);
check(
  "the braces are punctuation, the literal runs between them are string",
  shape("local s = `hp {n} left`"),
  [
    `"local" dfp-tok-kw`, `"s" —`, `"=" dfp-tok-op`,
    `"\`hp " dfp-tok-str`, `"{" dfp-tok-op`, `"n" —`, `"}" dfp-tok-op`, `" left\`" dfp-tok-str`,
  ],
);

/* One unmatched backtick must cost one line, not the rest of the block. */
const STRAY = "local s = `oops\nlocal n = 5\nwait(1)";
check(
  "a stray backtick does not swallow the lines after it",
  shape(STRAY).slice(3),
  [`"\`oops" dfp-tok-str`, `"local" dfp-tok-kw`, `"n" —`, `"=" dfp-tok-op`, `"5" dfp-tok-num`,
   `"wait" dfp-tok-legacy`, `"(" dfp-tok-op`, `"1" dfp-tok-num`, `")" dfp-tok-op`],
);
check("…and the deprecation mark on that later line survives", marks(STRAY), ["wait warn"]);

/* ════════════════════════════════════════════════════════════════════════
 * 5. Long brackets
 *
 * `readLongBracket` used to report failure as a successful read to end of
 * source, which conflated two answers that need opposite handling. An unclosed
 * `--[[` really does comment out the rest of the file, so swallowing is correct.
 * An unclosed `[[` almost certainly was not a string at all — `[` opens an index
 * expression far more often than a forty-line literal — and treating it as one
 * greyed out the remainder of the block and lost every mark and link in it.
 * ════════════════════════════════════════════════════════════════════════ */
section("long brackets");

const OPEN_STRING = "local s = [[ never closed\nwait(1)";
check(
  "an unterminated [[ falls back to punctuation and the block carries on",
  shape(OPEN_STRING),
  [`"local" dfp-tok-kw`, `"s" —`, `"=" dfp-tok-op`, `"[" dfp-tok-op`, `"[" dfp-tok-op`,
   `"never" —`, `"closed" —`, `"wait" dfp-tok-legacy`, `"(" dfp-tok-op`, `"1" dfp-tok-num`, `")" dfp-tok-op`],
);
check("…so the later `wait` is still found", marks(OPEN_STRING), ["wait warn"]);

check(
  "an unterminated --[[ still comments out everything after it",
  shape("--[[ never closed\nwait(1)"),
  [`"--[[ never closed\\nwait(1)" dfp-tok-com`],
);

/* ════════════════════════════════════════════════════════════════════════
 * 6. Deprecated globals get their own colour
 *
 * `wait` and `task` used to be the same accent blue: the colour said "blessed
 * stdlib" while the wavy underline three pixels below said the opposite. Only
 * the BARE word dims — `task.wait` is the replacement for `wait`, not a use of
 * it, and dimming it would recommend against the correct answer.
 * ════════════════════════════════════════════════════════════════════════ */
section("legacy globals");

const LEGACY = "wait(1)\nspawn(f)\ntask.wait(1)";
check(
  "bare wait and spawn are legacy; task is a builtin and its .wait a field",
  [classes(LEGACY, "wait"), classes(LEGACY, "spawn"), classes(LEGACY, "task")],
  [["dfp-tok-legacy", "dfp-tok-prop"], ["dfp-tok-legacy"], ["dfp-tok-builtin"]],
);

/* The new kind is also the thing that could have silently killed detection:
 * detect.ts is keyed off token kind in a dozen places, and any one of them still
 * asking `kind === "ident"` would have stopped finding the most common
 * deprecations there are, with nothing failing loudly. */
check("…and detection still fires on the demoted kind", marks(LEGACY), ["wait warn", "spawn warn"]);

/* The set is the docs' own deprecated flag, not a list kept in the tokenizer.
 * The list dimmed `time` and `tick`, which the docs do not flag — `time()` is
 * current API, so the colour said "legacy" on a correct call — and never
 * dimmed `getfenv` or `elapsedTime`, which they do, so those got no colour and
 * no mark while the hover card, reading the shard, called them deprecated.
 * Three channels, three answers; now one source. */
const CURRENT = "time()\ntick()";
check(
  "time and tick are current API: plain identifiers, and not marked",
  [classes(CURRENT, "time"), classes(CURRENT, "tick"), marks(CURRENT)],
  [["—"], ["—"], []],
);
const FLAGGED = "getfenv()\nelapsedTime()";
check(
  "getfenv and elapsedTime are dimmed AND marked, from the docs' flag alone",
  [classes(FLAGGED, "getfenv"), classes(FLAGGED, "elapsedTime"), marks(FLAGGED)],
  [["dfp-tok-legacy"], ["dfp-tok-legacy"], ["getfenv info", "elapsedTime info"]],
);

/* The docs' set also lists `stats`, `version` and `DebuggerManager` — ordinary
 * names for a local — and the tokenizer answers from spelling alone, so
 * `local stats = {}` painted every `stats` dimmed with no mark and no finding:
 * the `time()` wrong signal, moved. A name the block declared is the block's. */
const OWN = "local stats = {}\nstats.kills = 1\nprint(stats.kills)";
check(
  "a declared name is never legacy, whatever the docs flag",
  [classes(OWN, "stats"), marks(OWN)],
  [["—", "—", "—"], []],
);

/* `info`, because a flag on its own says "there is a newer way", not "this is
 * harmful"; the curated entry for `wait` says the latter and must keep winning. */
check("a curated entry still outranks the docs' plain flag", marks("wait(1)"), ["wait warn"]);

/* Three severities, because they are three different underline colours. */
check(
  "severity reaches the segment: error, warn and info are distinguishable",
  marks('LoadLibrary("RbxUtility")\nwait(1)\nInstance.new("Hat")'),
  ["LoadLibrary error", "wait warn", '"Hat" info'],
);

/* ════════════════════════════════════════════════════════════════════════
 * 7. A finding spanning several tokens keeps their colours
 *
 * `Instance.new(…, parent)` marks the whole second argument, because that is
 * what has to be deleted — a four-pixel underline under a comma is not a finding
 * anyone notices. Swallowing the tokens used to drop their classes, so
 * `Instance.new("ScreenGui", game.Players.LocalPlayer:WaitForChild("PlayerGui"))`
 * flattened a builtin, two properties, a method and a string to plain white
 * under one underline. The mark is an underline, not a recolour.
 * ════════════════════════════════════════════════════════════════════════ */
section("multi-token findings");

const PARENTED = 'Instance.new("Part", game.Workspace)';
check("the whole `, parent` argument is one mark", marks(PARENTED), [", game.Workspace warn"]);
check(
  "…and every token under it keeps its own colour",
  parts(PARENTED, ", game.Workspace"),
  [`"," dfp-tok-op`, `" " —`, `"game" dfp-tok-builtin`, `"." dfp-tok-op`, `"Workspace" dfp-tok-prop`],
);
/* A single-token finding stays flat — no nesting, the class rides on the mark. */
check("a single-token finding needs no nesting", parts("wait(1)", "wait"), []);

/* ════════════════════════════════════════════════════════════════════════
 * 8. Punctuation is an operator
 *
 * `.` `:` `,` `;` and the brackets were unmapped, so they inherited --dfp-text
 * while the `=` beside them sat at --dfp-text-2 — 1.80:1 apart on dark, one
 * syntactic category rendered two ways, decided only by which characters
 * happened to be listed in the tokenizer's operator string. In `a.b:c(d, e)` the
 * glue was the brightest thing on the line.
 * ════════════════════════════════════════════════════════════════════════ */
section("punctuation");

check(
  "separators and brackets are dfp-tok-op, like the operators beside them",
  shape("local t = { a = 1; b = 2 }\nprint(t.a, t.b)"),
  [
    `"local" dfp-tok-kw`, `"t" —`, `"=" dfp-tok-op`, `"{" dfp-tok-op`, `"a" —`, `"=" dfp-tok-op`,
    `"1" dfp-tok-num`, `";" dfp-tok-op`, `"b" —`, `"=" dfp-tok-op`, `"2" dfp-tok-num`, `"}" dfp-tok-op`,
    `"print" dfp-tok-builtin`, `"(" dfp-tok-op`, `"t" —`, `"." dfp-tok-op`, `"a" dfp-tok-prop`,
    `"," dfp-tok-op`, `"t" —`, `"." dfp-tok-op`, `"b" dfp-tok-prop`, `")" dfp-tok-op`,
  ],
);

/* ════════════════════════════════════════════════════════════════════════
 * 9. Function declaration sites
 *
 * Four spellings of one thing that came out in three colours — none, none, a
 * field colour and a method colour — so a definition was byte-identical to every
 * one of its call sites. The declared name is the LAST hop before the `(`: in
 * `function M.init()` the `M` is an ordinary table reference and keeps the
 * colour it wears everywhere else.
 * ════════════════════════════════════════════════════════════════════════ */
section("function declaration sites");

const FORMS = "local function a() end\nfunction b() end\nfunction M.init() end\nfunction M:update() end";
check(
  "all four declaration forms are dfp-tok-fn",
  [classes(FORMS, "a"), classes(FORMS, "b"), classes(FORMS, "init"), classes(FORMS, "update")],
  [["dfp-tok-fn"], ["dfp-tok-fn"], ["dfp-tok-fn"], ["dfp-tok-fn"]],
);
check(
  "…and the owner in `function M.init()` is not a declaration",
  classes(FORMS, "M"),
  ["—", "—"],
);

/* The lying link. `local Sound = {}` plus `function Sound:Play()` resolved to
 * `Sound.Play`, which the isolated world confirms against the real member index
 * and turns into a live link to the ENGINE's Sound.Play — someone else's method,
 * on someone else's class. 53 of the 647 documented class names are ordinary
 * module names. The rule this renderer states is a missing link, never a lying
 * one, so a declaration site may not carry a reference at all. */
const OWN_MODULE = 'local Sound = {}\nfunction Sound:Play()\n\tprint("x")\nend\nSound:Play()';
check(
  "a module you declared yourself links to nothing, at the definition or the call",
  allApis(OWN_MODULE),
  ["print → globals.print"],
);
check(
  "…the definition is a declaration site, the later call is an ordinary method",
  classes(OWN_MODULE, "Play"),
  ["dfp-tok-fn", "dfp-tok-method"],
);

/* ════════════════════════════════════════════════════════════════════════
 * 10. Where a docs link is allowed to land
 *
 * Every link has to be provable from POSITION. `local hum: Humanoid` puts a `:`
 * exactly where a method call puts one, so `hum` entered the receiver branch and
 * resolved through the type map that annotation had just filled in — the dotted
 * underline landed on the one token that is definitionally not an API name,
 * while the class three characters away stayed bare.
 * ════════════════════════════════════════════════════════════════════════ */
section("docs links");

const ANNOTATED = "local hum: Humanoid = nil";
check("an annotation links the CLASS, never the variable", allApis(ANNOTATED), ["Humanoid → Humanoid"]);
check("…and the annotation is a type, whatever the colon suggests", classes(ANNOTATED, "Humanoid"), ["dfp-tok-type"]);

/* Spelling is never enough on its own, once the snippet has declared the name.
 * `local Skin = …` fired six times on one corpus post; `local Model: number = 5`
 * linked to classes/Model from the spelling alone. */
check(
  "a name the snippet declared resolves to nothing, however it is spelled",
  allApis("local Model: number = 5\nlocal Skin = {}\nprint(Model, Skin)"),
  ["print → globals.print"],
);
/* The bare-global branch had a narrower veto of its own — `local` one token to
 * the left — so `local version = 2` linked nothing on that line and
 * `globals.version` two lines down, where the isolated world would confirm it
 * into a live link to the engine's `version()` on the author's own number. */
check(
  "…and neither does a declared name that is spelled like a global",
  allApis("local version = 2\nprint(version)"),
  ["print → globals.print"],
);

/* …but what was PROVED still links. Inference outranks the veto. */
check(
  "a service captured into a local still links",
  apis('local Players = game:GetService("Players")\nprint(Players.LocalPlayer)', "Players"),
  ["—", "Players"],
);
check(
  "a fixed global links to the class it actually is",
  allApis("workspace.DistributedGameTime = 0"),
  ["workspace → Workspace", "DistributedGameTime → Workspace.DistributedGameTime"],
);

/* ════════════════════════════════════════════════════════════════════════
 * 11. The markup the renderer actually emits
 *
 * The CSS is written against these exact shapes: `.dfp-doc-link` composed with a
 * token class, an inert member-level anchor with no href, and token spans nested
 * inside a `.dfp-dep` mark. The visual fixture is generated from this same path.
 * ════════════════════════════════════════════════════════════════════════ */
section("emitted markup");

const RENDERED = renderCodeBlock(
  'local hum: Humanoid = nil\nprint(hum.Health)\nInstance.new("Part", workspace)',
);

/* Owner-level: provable from this bundle, so it ships as a real link. */
check(
  "an owner-level reference is a real link, with the token class alongside",
  RENDERED.html.includes(
    '<a class="dfp-doc-link dfp-tok-type" href="https://create.roblox.com/docs/reference/engine/classes/Humanoid"',
  ),
  true,
);
/* Member-level: deciding whether `ReplicatedStorage.Assets` is an engine member
 * or a folder somebody made needs the member tables, which are 28 kB gzipped. So
 * it ships inert — an <a> with no href is not a link and is not styled as one —
 * and the isolated world adds the href once it has confirmed it. Affordances are
 * only ever ADDED. */
check(
  "a member-level reference ships inert: no href, no .dfp-doc-link",
  RENDERED.html.includes('<a class="dfp-tok-prop" data-dfp-api="Humanoid.Health">Health</a>'),
  true,
);
check(
  "a multi-token mark nests real elements, never innerHTML",
  RENDERED.html.includes(
    '<span class="dfp-tok-op">,</span> <span class="dfp-tok-builtin">workspace</span></span>',
  ),
  true,
);
/* Grouped, not counted: one corpus block produced 48 findings that were all the
 * same idiom, and "48 deprecated APIs" is both a wall and a lie. */
check(
  "the summary names the distinct issues",
  RENDERED.note,
  "Instance.new(…, parent) — hover or Tab for details",
);

/* ════════════════════════════════════════════════════════════════════════
 * 12. A mark keeps the docs reference its token earned
 *
 * The finding branch used to push segments without `api`, so `wait` carried no
 * `data-dfp-api` while the unmarked `tick` beside it did — the fixture showed
 * exactly that on adjacent lines. The one token a reader most wants both the
 * signature and the deprecation for was the one token that had neither. The
 * isolated world's card reads the attribute off the mark's span.
 * ════════════════════════════════════════════════════════════════════════ */
section("marks carry a docs reference");

check(
  "a marked global keeps the reference the unmarked one beside it has",
  [apis("wait(1)\ntick()", "wait"), apis("wait(1)\ntick()", "tick")],
  [["globals.wait"], ["globals.tick"]],
);
check(
  "a marked member resolves through its receiver, in the anchors' own vocabulary",
  apis('local part = Instance.new("Part")\npart:remove()', "remove"),
  ["Part.remove"],
);
check("…and stays bare when the receiver is unknown", apis("thing:remove()", "remove"), ["—"]);
check(
  "a deprecated class in type position references its page",
  apis("local bv: BodyVelocity = nil", "BodyVelocity"),
  ["BodyVelocity"],
);
/* The pattern finding spans `, workspace` — an argument to delete, not an API. */
check(
  "a multi-token mark names an argument, not an API",
  apis('Instance.new("Part", workspace)', ", workspace"),
  ["—"],
);

/* Fenced, because `wait(1)` on its own is under the sniff's twelve-character
 * floor — see section 1. The fence is the author saying what the block is. */
const MARKED = renderCodeBlock("wait(1)", "lang-lua");
check(
  "the mark carries title, replacement, why, group and api",
  MARKED.html.startsWith(
    '<span class="dfp-dep dfp-dep--warn dfp-tok-legacy" title="Deprecated — use task.wait(). Throttled and imprecise. ' +
      "`task.wait()` resumes on the next frame with the real elapsed time, and returns it.\" " +
      'data-dfp-replacement="task.wait()" data-dfp-why="Throttled and imprecise. `task.wait()` resumes on the next frame ' +
      'with the real elapsed time, and returns it." data-dfp-group="wait" data-dfp-api="globals.wait">wait</span>',
  ),
  true,
);

/* ════════════════════════════════════════════════════════════════════════
 * 13. The note is the keyboard surface
 *
 * It used to be inert text ending "hover for details" — a sentence a phone
 * cannot act on and a screen reader cannot follow, since `title` on a
 * non-interactive span is never announced. Each group is now a button that
 * carries the same data as its marks, one tab stop per block with arrows
 * between chips, and a click reaches the mark even under code-chrome's
 * collapse, going through that module's own button so its label stays true.
 * ════════════════════════════════════════════════════════════════════════ */
section("the findings note");

check(
  "no findings, no note",
  renderCodeBlock('local Players = game:GetService("Players")').note,
  null,
);

const MANY = 'wait(1)\nwait(2)\nspawn(f)\nInstance.new("Hat")\nLoadLibrary("x")';
const NOTED = renderCodeBlock(MANY, "lang-lua");
check(
  "grouped, most frequent first, folded past three, ending in the keyboard hint",
  NOTED.note,
  "wait ×2 · spawn · Hat · +1 more — hover or Tab for details",
);

const chips = NOTED.bar!.querySelectorAll(".dfp-code-finding");
check(
  "each group is a button carrying the mark's own data",
  serialize(chips[0]!),
  '<button type="button" class="dfp-code-finding" tabindex="0" title="Deprecated — use task.wait(). Throttled and imprecise. ' +
    "`task.wait()` resumes on the next frame with the real elapsed time, and returns it.\" " +
    'data-dfp-group="wait" data-dfp-replacement="task.wait()" data-dfp-why="Throttled and imprecise. `task.wait()` resumes ' +
    'on the next frame with the real elapsed time, and returns it." data-dfp-api="globals.wait">wait ×2</button>',
);
check(
  "a finding with no replacement ships an empty one, and no api when none resolved",
  serialize(chips[2]!),
  '<button type="button" class="dfp-code-finding" tabindex="-1" title="Deprecated. Hat is marked deprecated in Roblox\'s API dump." ' +
    'data-dfp-group="Hat" data-dfp-replacement="" data-dfp-why="Hat is marked deprecated in Roblox\'s API dump." data-dfp-api="Hat">Hat</button>',
);

const stops = () => chips.map((c) => c.tabIndex);
check("one tab stop per block: only the first chip is in the tab order", stops(), [0, -1, -1]);
chips[0]!.fire("keydown", { key: "ArrowRight" });
check(
  "ArrowRight moves the stop and the focus to the next chip",
  [stops(), activeElement() === chips[1]],
  [[-1, 0, -1], true],
);
chips[1]!.fire("keydown", { key: "End" });
check("End reaches the last chip", [stops(), activeElement() === chips[2]], [[-1, -1, 0], true]);
chips[2]!.fire("keydown", { key: "ArrowRight" });
check("…and the row wraps", stops(), [0, -1, -1]);
chips[0]!.fire("keydown", { key: "Tab" });
check("Tab is left to the browser, so it leaves the note", stops(), [0, -1, -1]);

/* A clipped block: code-chrome's button sits right after the <pre>, and the
 * chip must go through it rather than toggle the class itself — the button's
 * label is that module's state. */
let expanded = false;
const expand = new DElement("button");
expand.className = "dfp-code-expand";
expand.addEventListener("click", () => {
  expanded = true;
  NOTED.pre.classList.remove("dfp-code--clipped");
});
NOTED.pre.classList.add("dfp-code--clipped");
NOTED.pre.parentElement!.appendChild(expand);
chips[1]!.click();
const spawnMark = NOTED.pre.querySelectorAll(".dfp-dep").find((m) => m.dataset["dfpGroup"] === "spawn")!;
check(
  "clicking a chip expands through code-chrome's button, scrolls to the group's mark and flashes it",
  [expanded, spawnMark.scrolled, spawnMark.classList.contains("dfp-dep--flash")],
  [true, true, true],
);

/* "N below the fold" is measured on hover, from geometry the decorator could not
 * have read — and re-measured, so it goes when the block is opened. */
const FOLDED = renderCodeBlock(MANY, "lang-lua");
FOLDED.pre.classList.add("dfp-code--clipped");
FOLDED.pre.clientHeight = 100;
FOLDED.pre.querySelectorAll(".dfp-dep").forEach((m, i) => {
  m.offsetTop = i * 40;
  m.offsetHeight = 16;
});
FOLDED.bar!.fire("pointerenter");
check(
  "hovering a clipped block's note counts the marks below the fold",
  FOLDED.bar!.querySelector(".dfp-code-note__fold")?.textContent,
  "2 below the fold",
);
FOLDED.pre.classList.remove("dfp-code--clipped");
FOLDED.bar!.fire("focusin");
check("…and the count goes once the block is open", FOLDED.bar!.querySelector(".dfp-code-note__fold"), null);

/* ════════════════════════════════════════════════════════════════════════
 * 14. The composer preview
 *
 * Both code modules registered `onlyStream: true`, which is the flag that
 * excludes `.d-editor-preview` — so the one place an author could still fix a
 * `wait()` showed highlight.js's Lua colouring and no mark. The preview path
 * runs highlight and marks only, reads "already done" from the children rather
 * than an attribute (hljs's worker rewrites `innerHTML` after us on some
 * cooks, and attributes survive that while children do not), leaves a paste
 * over 400 lines alone, and is reached through a debounce.
 * ════════════════════════════════════════════════════════════════════════ */
section("composer preview");

/** A preview block as highlight.js leaves it: the Lua grammar's spans around the text. */
function previewBlock(source: string): { preview: DElement; pre: DElement; code: DElement } {
  const preview = new DElement("div");
  preview.className = "d-editor-preview";
  const pre = new DElement("pre");
  const code = new DElement("code");
  code.className = "lang-lua hljs language-lua";
  const kw = new DElement("span");
  kw.className = "hljs-keyword";
  kw.textContent = source.slice(0, 5);
  code.appendChild(kw);
  code.appendChild(new DText(source.slice(5)));
  pre.appendChild(code);
  preview.appendChild(pre);
  return { preview, pre, code };
}
const codeHtml = (code: DElement) => code.childNodes.map(serialize).join("");

const DRAFT = "local t = wait(1)\nprint(t)";
const P = previewBlock(DRAFT);
check(
  "a pass over the preview re-tokenises the block",
  [enhancePreview(P.preview), P.code.classList.contains("dfp-luau")],
  [1, true],
);
check(
  "…with DFP's spans and a mark carrying its data, and no anchors at all",
  [
    codeHtml(P.code).startsWith('<span class="dfp-tok-kw">local</span>'),
    codeHtml(P.code).includes('data-dfp-group="wait" data-dfp-api="globals.wait">wait</span>'),
    codeHtml(P.code).includes("<a "),
    codeHtml(P.code).includes('<span class="dfp-tok-builtin">print</span>'),
  ],
  [true, true, false, true],
);
check("no note in the preview — the <pre> is still the preview's only child", P.preview.children.length, 1);
check("a second pass finds nothing to do", enhancePreview(P.preview), 0);

/* A render that is text only. A lone identifier is emitted as a text node, so
 * the guard's old "first element child wears dfp-" read a rendered `myVar` as
 * hljs's and rendered it again — [1, 1, 1] over three passes, and in the
 * browser each pass is a mutation the observer turns into the next: a timer
 * loop for as long as the composer is open, on a block anyone types. */
const BARE = previewBlock("myVar");
check(
  "a text-only render converges: passes over `myVar` go 1, 0, 0",
  [enhancePreview(BARE.preview), enhancePreview(BARE.preview), enhancePreview(BARE.preview)],
  [1, 0, 0],
);

/* hljs's worker landing after us: the attribute guard would say "done" over
 * Lua-grammar markup, because attributes survive an innerHTML write. */
const late = new DElement("span");
late.className = "hljs-keyword";
late.textContent = "local";
P.code.replaceChildren(late, new DText(DRAFT.slice(5)));
check(
  "a block hljs rewrote after us is rendered again",
  [enhancePreview(P.preview), codeHtml(P.code).startsWith('<span class="dfp-tok-kw">local</span>')],
  [1, true],
);

const HUGE = previewBlock("local a = 1\n".repeat(401));
check(
  "a paste over 400 lines is left to hljs — typing must not stutter",
  [enhancePreview(HUGE.preview), HUGE.code.classList.contains("dfp-luau")],
  [0, false],
);

/* The registration itself: called for every cooked element, acts only inside
 * the preview, and only after the debounce. */
const decorate = getPreviewDecorator();
const OUTSIDE = previewBlock(DRAFT);
OUTSIDE.preview.className = "cooked";
decorate(OUTSIDE.preview);
const INSIDE = previewBlock(DRAFT);
decorate(INSIDE.pre); // handed a child; `closest()` climbs to the preview
/* Closed before the debounce ran. The timer is the one code path that runs
 * after detach — nothing is ever delivered to an observer on a detached
 * subtree — so it is where the observer has to be let go. */
const GONE = previewBlock(DRAFT);
decorate(GONE.pre);
GONE.preview.isConnected = false;
check("the preview decorator renders nothing synchronously", INSIDE.code.classList.contains("dfp-luau"), false);
await new Promise((r) => setTimeout(r, 400));
check(
  "…and after the debounce, only the block inside a preview",
  [INSIDE.code.classList.contains("dfp-luau"), OUTSIDE.code.classList.contains("dfp-luau")],
  [true, false],
);
/* The observer sees the module's own render as a mutation. Drained in the task
 * that made it, or the next pass is 300ms away, and the one after that. */
check(
  "the pass drains its own mutation from the observer, which stays connected",
  [observerFor(INSIDE.preview)?.drained, observerFor(INSIDE.preview)?.disconnected],
  [1, false],
);
check(
  "a preview closed before its timer fired is left alone and unwatched",
  [GONE.code.classList.contains("dfp-luau"), observerFor(GONE.preview)?.disconnected],
  [false, true],
);

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILING`} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
