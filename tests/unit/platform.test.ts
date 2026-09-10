import { MOD, chord, chordFor, modifierFor } from "../../src/isolated/platform";

/**
 * The modifier label, which is the whole of what platform.ts decides.
 *
 * The bug it replaced was a literal `⌘` shown to everyone, so the cases here
 * are the platform strings the two navigator APIs actually return — the
 * Chromium `userAgentData.platform` names and the frozen `navigator.platform`
 * ones — rather than a guess at what a platform string looks like.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

console.log("── modifierFor ───────────────────────────────────────────────────");
// userAgentData.platform, Chromium.
eq(modifierFor("Windows"), "Ctrl", "Windows");
eq(modifierFor("macOS"), "⌘", "macOS");
eq(modifierFor("Linux"), "Ctrl", "Linux");
eq(modifierFor("Chrome OS"), "Ctrl", "Chrome OS");
eq(modifierFor("Android"), "Ctrl", "Android");
// navigator.platform, Firefox and WebKit.
eq(modifierFor("Win32"), "Ctrl", "Win32");
eq(modifierFor("MacIntel"), "⌘", "MacIntel");
eq(modifierFor("Linux x86_64"), "Ctrl", "Linux x86_64");
eq(modifierFor("iPhone"), "⌘", "iPhone");
eq(modifierFor("iPad"), "⌘", "iPad");
// Nothing known: Ctrl, because it is the majority answer on this forum.
eq(modifierFor(""), "Ctrl", "empty string");

console.log("── chordFor ──────────────────────────────────────────────────────");
eq(chordFor("⌘", "K"), "⌘K", "Mac: glyph and key, no joiner");
eq(chordFor("Ctrl", "K"), "Ctrl+K", "elsewhere: plus-joined");
eq(chordFor("⌘", "⏎"), "⌘⏎", "Mac: enter");
eq(chordFor("Ctrl", "⏎"), "Ctrl+⏎", "elsewhere: enter");

console.log("── the live values ───────────────────────────────────────────────");
check(MOD === "⌘" || MOD === "Ctrl", `MOD resolves to one of the two labels  →  ${JSON.stringify(MOD)}`);
eq(chord("K"), chordFor(MOD, "K"), "chord() is chordFor() over MOD");

console.log("");
if (fail > 0) {
  console.log(`FAILED: ${fail} of ${pass + fail} checks`);
  process.exit(1);
}
console.log(`ALL PASS (${pass}/${pass} checks)`);
