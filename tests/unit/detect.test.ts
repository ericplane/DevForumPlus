import { detect } from "../../src/luau/detect";
import { tokenize } from "../../src/luau/tokenizer";

const cases: [string, string, number][] = [
  ["real global call", `wait(1)`, 1],
  ["inside a line comment", `-- never use wait(1) here`, 0],
  ["inside a block comment", `--[[ wait(1) spawn(f) ]]`, 0],
  ["inside a string", `print("call wait(1) instead")`, 0],
  ["inside a long string", `local s = [[ wait(1) ]]`, 0],
  // A user's own `.wait` field is not the deprecated `event:wait()` alias.
  // This expectation started at 1 and was wrong: the access-mode rule makes 0
  // correct, and getting this wrong is how a linter earns a reputation for
  // crying wolf.
  ["user's own .wait field", `local t = {}; t.wait = 5; t.wait(1)`, 0],
  ["legacy event:wait()", `local c = e:wait()`, 1],
  ["shadowed by local", `local wait = task.wait`, 0],
  ["deprecated class ctor", `Instance.new("BodyVelocity")`, 1],
  ["Instance.new 2-arg", `Instance.new("Part", workspace)`, 1],
  ["both class + 2-arg", `Instance.new("BodyGyro", p)`, 2],
  ["member :remove()", `part:remove()`, 1],
  ["modern is clean", `task.wait(1); part:Destroy(); local v = Instance.new("Part")\nv.Parent = workspace`, 0],
  ["LoadAnimation on Humanoid", `humanoid:LoadAnimation(anim)`, 1],
  ["LoadAnimation on Animator", `animator:LoadAnimation(anim)`, 0],
  ["interpolated string", "local s = `hi {name}, wait(1)`", 0],

  // ── Receiver-type inference ──────────────────────────────────────────────
  // `.Velocity` is deprecated on BasePart and correct on BodyVelocity. Before
  // the index was keyed by class, both of these were flagged, which told people
  // the right property was wrong. The pair has to stay split.
  ["Velocity on an inferred Part", `local p = Instance.new("Part")\np.Velocity = v`, 1],
  ["Velocity on a BodyVelocity", `local bv = Instance.new("BodyVelocity")\nbv.Velocity = v`, 1],
  // ...and an unresolvable receiver must produce nothing rather than a guess.
  ["Velocity on an unknown receiver", `thing.Velocity = v`, 0],
  // A user's own signal library must not be told its `:fire()` is deprecated.
  ["user-defined :fire()", `local sig = Signal.new()\nsig:fire("x")`, 0],
  ["inherited from BasePart", `local p = Instance.new("WedgePart")\np.Friction = 1`, 1],
  ["service resolved via GetService", `local l = game:GetService("Lighting")\nl.FogEnd = 100`, 0],
  ["bare workspace global", `workspace.DistributedGameTime = 0`, 0],

  // ── Found by running the detector over 46 real Scripting Support blocks ──
  // A variable named after a deprecated class is not a use of it. This fired 6×
  // on one corpus post that opens `local Skin = Instance.new("StringValue", …)`.
  ["variable named after a class", `local Skin = Instance.new("StringValue")`, 0],
  // Defining your own method is not calling the legacy alias...
  ["own method definition", `function ragdoll:destroy()\n\tprint("bye")\nend`, 0],
  // ...and neither is calling the one you just defined.
  ["call to own defined method", `function r:destroy() end\nfunction r:go() self:destroy() end`, 0],
  // Type position is still a real use.
  ["class in a type annotation", `local bv: BodyVelocity = nil`, 1],
  ["class in a cast", `local bv = x :: BodyVelocity`, 1],
];

let pass = 0, fail = 0;
for (const [label, src, expected] of cases) {
  const found = detect(src);
  const ok = found.length === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label.padEnd(26)} expected ${expected}, got ${found.length}` +
    (ok ? "" : `  → ${found.map(f => f.text).join(", ")}`));
}

// Luau-specific syntax the Lua grammar mishandles
const luau = `local x: number = 1
type T<A> = { v: A }
local y = x :: any
for i = 1, 3 do continue end
x += 1
local s = \`sum {x}\``;
const kinds = tokenize(luau).filter(t => t.kind !== "whitespace");
const hasCast = kinds.some(t => t.kind === "operator" && t.value === "::");
const hasCompound = kinds.some(t => t.kind === "operator" && t.value === "+=");
const hasContinue = kinds.some(t => t.kind === "keyword" && t.value === "continue");
const hasInterp = kinds.some(t => t.kind === "string" && t.value.startsWith("`"));
console.log(`\n  Luau syntax: :: ${hasCast} | += ${hasCompound} | continue ${hasContinue} | \`interp\` ${hasInterp}`);
if (!(hasCast && hasCompound && hasContinue && hasInterp)) fail++;

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${cases.length} cases)`);
process.exit(fail === 0 ? 0 : 1);
