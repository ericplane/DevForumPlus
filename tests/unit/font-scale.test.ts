import {
  FONT_SCALE_LABELS,
  FONT_SCALES,
  fontScaleLabel,
  normalizeSettings,
} from "../../src/core/settings-schema";

/**
 * The Text control's ramp against the schema's clamp.
 *
 * FONT_SCALES and the clamp in normalizeSettings are one pair of numbers now
 * (the clamp reads FONT_SCALES.S / FONT_SCALES.XL), but the checks below stay:
 * they are the tripwire for a ramp edit that leaves the clamp reading a stale
 * literal again. A step the clamp rewrites is a button that never reads as
 * pressed, and a clamp wider than the ramp is a size nobody can reach.
 *
 * The three exports used to live in Popup.tsx, which reads `chrome` at module
 * scope, so this file stubbed `chrome` and imported the popup dynamically —
 * and would have broken for any module-scope DOM access anywhere in that
 * import graph. They moved to settings-schema.ts together, and the stub went.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

console.log("── the ramp ──────────────────────────────────────────────────────");
eq(FONT_SCALE_LABELS.join(","), "S,M,L,XL", "four steps, in display order");
eq(
  [...FONT_SCALE_LABELS].sort().join(","),
  Object.keys(FONT_SCALES).sort().join(","),
  "the order names every key of FONT_SCALES once",
);
check(
  FONT_SCALE_LABELS.every((l, i) => i === 0 || FONT_SCALES[l] > FONT_SCALES[FONT_SCALE_LABELS[i - 1]!]),
  "and the steps ascend",
);
eq(FONT_SCALES.M, 1, "M is the unscaled default");

console.log("\n── against normalizeSettings ─────────────────────────────────────");
eq(normalizeSettings({ fontScale: 0 }).fontScale, FONT_SCALES.S, "S is the bottom of the clamp");
eq(normalizeSettings({ fontScale: 9 }).fontScale, FONT_SCALES.XL, "XL is the top of the clamp");
for (const label of FONT_SCALE_LABELS) {
  eq(
    normalizeSettings({ fontScale: FONT_SCALES[label] }).fontScale,
    FONT_SCALES[label],
    `${label} survives the clamp unchanged`,
  );
}

console.log("\n── which button a stored scale lights ────────────────────────────");
for (const label of FONT_SCALE_LABELS) {
  eq(fontScaleLabel(FONT_SCALES[label]), label, `${FONT_SCALES[label]} reads as ${label}`);
}
eq(fontScaleLabel(1.04), "M", "1.04, nearer M than L");
eq(fontScaleLabel(1.07), "L", "1.07, nearer L than M");
eq(fontScaleLabel(0.93), "S", "0.93, nearer S than M");
eq(fontScaleLabel(1.18), "XL", "1.18, nearer XL than L");
eq(fontScaleLabel(0), "S", "below the ramp still lights the bottom step");
eq(fontScaleLabel(2), "XL", "above it still lights the top step");
eq(fontScaleLabel(Number.NaN), "M", "NaN cannot arrive, and would read as M");

console.log("");
if (fail > 0) {
  console.log(`FAILED: ${fail} of ${pass + fail} checks`);
  process.exit(1);
}
console.log(`ALL PASS (${pass}/${pass} checks)`);
