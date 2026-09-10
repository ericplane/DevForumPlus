import { colorTools } from "../../scripts/harness-color";

/**
 * The colour maths check-harness.ts ships into the page.
 *
 * It grades every run of text in the harness, and a wrong matrix or a
 * mis-parsed alpha does not fail loudly — it grades a black-on-black bar as
 * fine, which is the failure the audit exists to catch. So the conversions are
 * pinned to known answers here: CSS Color 4's own examples for OKLab, the WCAG
 * reference pair for contrast, and the serialisations Chromium was measured
 * to produce for the computed values of this stylesheet.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;
const rgb = (c: readonly number[] | null, r: number, g: number, b: number, tol = 1) =>
  c !== null && near(c[0]!, r, tol) && near(c[1]!, g, tol) && near(c[2]!, b, tol);

const t = colorTools();

console.log("── legacy and hex serialisations ──────────────────────────────────");

{
  check(rgb(t.parseColor("rgb(12, 14, 20)"), 12, 14, 20, 0) && t.parseColor("rgb(12, 14, 20)")![3] === 1, "rgb(r, g, b) is opaque");
  const a = t.parseColor("rgba(20, 23, 28, 0.13)");
  check(rgb(a, 20, 23, 28, 0) && near(a![3], 0.13, 1e-9), "rgba(r, g, b, a) keeps its alpha");
  const m = t.parseColor("rgb(1 2 3 / 50%)");
  check(rgb(m, 1, 2, 3, 0) && near(m![3], 0.5, 1e-9), "modern rgb(r g b / a%) reads too");
  check(rgb(t.parseColor("#37b3ff"), 0x37, 0xb3, 0xff, 0), "#rrggbb");
  check(near(t.parseColor("#37b3ff80")![3], 128 / 255, 1e-9), "#rrggbbaa carries alpha");
  check(t.parseColor("transparent")![3] === 0, "transparent has alpha 0");
}

console.log("\n── OKLab / OKLCH / color(), what color-mix() computes to ─────────");

{
  check(rgb(t.parseColor("oklab(0 0 0)"), 0, 0, 0, 0), "oklab black");
  check(rgb(t.parseColor("oklab(1 0 0)"), 255, 255, 255), "oklab white");
  // CSS Color 4 §9.2 example: sRGB red.
  check(rgb(t.parseColor("oklab(0.627955 0.224863 0.125846)"), 255, 0, 0, 2), "oklab red (spec example)");
  check(rgb(t.parseColor("oklch(0.627955 0.257683 29.2339)"), 255, 0, 0, 2), "oklch red (spec example)");
  // 50% grey has L ≈ 0.5981 in OKLab.
  check(rgb(t.parseColor("oklab(0.5981 0 0)"), 128, 128, 128, 2), "oklab mid grey");
  const a = t.parseColor("oklab(0.585481 0.195017 0.108438 / 0.13)");
  check(a !== null && near(a[3], 0.13, 1e-9), "oklab with `/ alpha` keeps the alpha (a tinted surface token)");
  check(rgb(t.parseColor("oklab(100% 0% 0%)"), 255, 255, 255), "percentages are relative to the channel range");
  check(rgb(t.parseColor("color(srgb 1 0 0)"), 255, 0, 0, 0), "color(srgb …)");
  check(rgb(t.parseColor("color(srgb-linear 0.2140 0.2140 0.2140)"), 128, 128, 128, 2), "color(srgb-linear …) is gamma-encoded");
  check(t.parseColor("color(display-p3 1 0 0)") === null, "an unsupported colour space is refused, not guessed");
}

console.log("\n── unparseable input is refused and remembered ────────────────────");

{
  const before = t.unparsed.length;
  check(t.parseColor("not-a-colour") === null, "garbage parses to null");
  check(t.unparsed.length === before + 1 && t.unparsed.includes("not-a-colour"), "…and is recorded for the report");
  t.parseColor("not-a-colour");
  check(t.unparsed.length === before + 1, "recorded once, not per call");
  check(typeof document === "undefined", "(this test runs without a document, so the canvas fallback is skipped)");
}

console.log("\n── compositing ────────────────────────────────────────────────────");

{
  const halfWhite: [number, number, number, number] = [255, 255, 255, 0.5];
  const black: [number, number, number, number] = [0, 0, 0, 1];
  const o = t.over(halfWhite, black);
  check(rgb(o, 127.5, 127.5, 127.5, 0.01) && o[3] === 1, "50% white over black is mid grey, opaque");
  check(t.over(t.CLEAR, black).join() === black.join(), "transparent over a colour is that colour");
  check(t.over(black, t.CLEAR).join() === black.join(), "a colour over transparent is that colour");
  const q = t.over([255, 0, 0, 0.5], [0, 0, 255, 0.5]);
  check(near(q[3], 0.75, 1e-9) && rgb(q, 170, 0, 85, 0.5), "two half-alpha layers: alpha 0.75, straight-alpha mix");
  check(t.fade(black, 0.4)[3] === 0.4, "fade scales alpha only");
  check(t.hex([255, 179.6, 0, 1]) === "#ffb400", "hex rounds channels");
}

console.log("\n── WCAG contrast ──────────────────────────────────────────────────");

{
  const white: [number, number, number, number] = [255, 255, 255, 1];
  const black: [number, number, number, number] = [0, 0, 0, 1];
  check(near(t.contrast(black, white), 21, 1e-6), "black on white is 21:1");
  check(near(t.contrast(white, black), 21, 1e-6), "…and symmetric");
  check(near(t.contrast(white, white), 1, 1e-9), "a colour against itself is 1:1");
  // #767676 on white is the canonical "just passes 4.5:1" pair.
  check(near(t.contrast([0x76, 0x76, 0x76, 1], white), 4.54, 0.01), "#767676 on white is 4.54:1");
  // The composer bar as it shipped: page background as ink on the surface.
  check(t.contrast([12, 14, 20, 1], [20, 23, 28, 1]) < 1.1, "rgb(12,14,20) on rgb(20,23,28) — the Saving bar — is ~1:1");
}

console.log("\n── gradient backgrounds ───────────────────────────────────────────");

{
  check(Array.isArray(t.imageColors("none")) && t.imageColors("none")!.length === 0, "no image → no stops");
  check(t.imageColors('url("avatar.png")') === null, "a bitmap is opaque to the audit");
  const stops = t.imageColors("linear-gradient(158deg, rgb(28, 31, 37), rgb(20, 23, 28) 60%)");
  check(stops !== null && stops.length === 2 && rgb(stops[0]!, 28, 31, 37, 0), "gradient stops are read in order");
  const mixed = t.imageColors("linear-gradient(to top, rgba(0, 0, 0, 0.78), rgba(0, 0, 0, 0))");
  check(mixed !== null && near(mixed[0]![3], 0.78, 1e-9) && mixed[1]![3] === 0, "stop alphas survive");
  check(t.imageColors("url(x.png), linear-gradient(red, blue)") === null, "a bitmap under a gradient is still a bitmap");
  const ok = t.imageColors("radial-gradient(circle, oklab(0.5 0 0), color(srgb 0 0 1))");
  check(ok !== null && ok.length === 2 && rgb(ok[1]!, 0, 0, 255, 0), "modern colour stops parse through the same path");
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
