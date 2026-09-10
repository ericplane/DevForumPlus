import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `::selection` pair, checked on the hex that ships.
 *
 * build-tokens.ts asserts these floors at generation time, so this is not a
 * second opinion on the maths — it is a guard on the wiring. The bug this
 * replaced was `::selection` pointed at `--dfp-accent-soft`, a chip tint that
 * measured 0.040Δ from the light theme's surfaces, and it shipped for as long
 * as it did because no check named the pair and nothing read base.css back.
 * So: every theme block in tokens.generated.css carries both tokens, the
 * shipped hex clears the generator's floors, the highlight moves toward the
 * viewer on both polarities, and base.css actually consumes the pair.
 *
 * The colour functions are the generator's formulas, restated. If they ever
 * disagree, the generator is the one that is wrong — it is the one whose
 * numbers are printed in CI.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const atLeast = (got: number, min: number, label: string) =>
  check(got >= min, `${label}  →  ${got.toFixed(3)} (min ${min})`);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const generated = readFileSync(resolve(root, "src/styles/tokens.generated.css"), "utf8");
const base = readFileSync(resolve(root, "src/styles/base.css"), "utf8");

// ── Colour maths, after build-tokens.ts ─────────────────────────────────────

const channel = (hex: string, at: number) => parseInt(hex.slice(1 + at, 3 + at), 16) / 255;
const linear = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));

function luminance(hex: string): number {
  return (
    0.2126 * linear(channel(hex, 0)) +
    0.7152 * linear(channel(hex, 2)) +
    0.0722 * linear(channel(hex, 4))
  );
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function oklab(hex: string): { L: number; a: number; b: number } {
  const r = linear(channel(hex, 0));
  const g = linear(channel(hex, 2));
  const b = linear(channel(hex, 4));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function distance(x: string, y: string): number {
  const p = oklab(x);
  const q = oklab(y);
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

// ── Theme blocks ────────────────────────────────────────────────────────────

interface Block {
  name: string;
  scheme: string;
  vars: Map<string, string>;
}

const blocks: Block[] = [];
for (const m of generated.matchAll(/data-dfp-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
  const body = m[2]!;
  const vars = new Map<string, string>();
  for (const v of body.matchAll(/--dfp-([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)) vars.set(v[1]!, v[2]!);
  const scheme = /color-scheme:\s*(dark|light)/.exec(body)?.[1] ?? "?";
  // `off` appears twice — the light half and its dark media-query twin.
  const dupes = blocks.filter((b) => b.name.startsWith(m[1]!)).length;
  blocks.push({ name: dupes ? `${m[1]} (${scheme})` : m[1]!, scheme, vars });
}

console.log("── theme blocks ──────────────────────────────────────────────────");
check(blocks.length === 6, `six theme blocks parsed (dark, dim, black, light, off ×2)  →  ${blocks.length}`);

for (const block of blocks) {
  console.log(`── ${block.name} ──`);
  const bg = block.vars.get("selection-bg");
  const fg = block.vars.get("selection-fg");
  const s1 = block.vars.get("surface-1");
  const s2 = block.vars.get("surface-2");
  check(!!bg && !!fg, `emits --dfp-selection-bg and --dfp-selection-fg  →  ${bg} / ${fg}`);
  if (!bg || !fg || !s1 || !s2) continue;

  check(fg === "#ffffff" || fg === "#0a0a0a", `foreground is the white / near-black pick  →  ${fg}`);
  atLeast(contrast(bg, fg), 4.5, "selection-fg on selection-bg");
  // The same floors the generator asserts; 0.13 is its "perceptible highlight".
  atLeast(distance(bg, s1), 0.13, "selection-bg vs surface-1 (perceptual)");
  atLeast(distance(bg, s2), 0.13, "selection-bg vs surface-2 (perceptual)");
  // A highlight moves toward the viewer: lighter than the surface on a dark
  // theme, darker than it on light. The old accent-soft tint failed this on
  // light, where it was a near-white sitting on white.
  const toward = block.scheme === "dark" ? oklab(bg).L > oklab(s2).L : oklab(bg).L < oklab(s1).L;
  check(toward, `highlight moves toward the viewer on a ${block.scheme} scheme`);
}

console.log("── base.css wiring ───────────────────────────────────────────────");
const rule = /html\[data-dfp\]\s*::selection\s*\{([^}]*)\}/.exec(base)?.[1] ?? "";
check(rule.length > 0, "base.css has the ::selection rule");
check(/var\(--dfp-selection-bg\)/.test(rule), "::selection background is --dfp-selection-bg");
check(/var\(--dfp-selection-fg\)/.test(rule), "::selection colour is --dfp-selection-fg");
check(!/accent-soft/.test(rule), "::selection no longer reads the chip tint");

console.log("");
if (fail > 0) {
  console.log(`FAILED: ${fail} of ${pass + fail} checks`);
  process.exit(1);
}
console.log(`ALL PASS (${pass}/${pass} checks)`);
