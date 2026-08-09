/**
 * Design token generator.
 *
 * Themes are declared as a neutral ramp (lightness steps at a fixed hue and
 * chroma) plus a handful of seed hues. Every colour in the product is derived
 * from that declaration, which is what keeps five themes visually coherent
 * instead of five separately hand-tuned palettes that drift apart.
 *
 * Working in OKLCH matters here: stepping lightness in OKLab produces steps
 * that *look* evenly spaced, where the same thing in HSL does not — the reason
 * hand-built dark palettes so often have one surface level that reads wrong.
 *
 * Output is hex, not `oklch()`. The browser supports oklch fine, but emitting
 * resolved hex means the contrast numbers asserted at build time are exactly
 * the ones that ship.
 *
 * Run: npm run tokens
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Colour science ──────────────────────────────────────────────────────────
// sRGB ↔ OKLab, after Björn Ottosson.

type RGB = { r: number; g: number; b: number };
type OKLCH = { l: number; c: number; h: number };

const cbrt = Math.cbrt;

function srgbToLinear(x: number): number {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToSrgb(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function linearRgbToOklab(r: number, g: number, b: number): { L: number; a: number; bb: number } {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = cbrt(l);
  const m_ = cbrt(m);
  const s_ = cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    bb: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

function oklabToLinearRgb(L: number, a: number, b: number): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

const inGamut = ({ r, g, b }: RGB, eps = 1e-4) =>
  r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && b >= -eps && b <= 1 + eps;

/**
 * Convert OKLCH to a displayable sRGB colour, reducing chroma until it fits.
 *
 * Naive clipping shifts hue — a saturated blue clipped per channel drifts
 * purple. Binary-searching chroma preserves hue and lightness, which is what
 * you actually want when a seed colour is out of gamut at a given lightness.
 */
function oklchToRgb({ l, c, h }: OKLCH): RGB {
  const hr = (h * Math.PI) / 180;
  const at = (chroma: number) =>
    oklabToLinearRgb(l, chroma * Math.cos(hr), chroma * Math.sin(hr));

  let lin = at(c);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    lin = at(lo);
  }
  return {
    r: clamp01(linearToSrgb(lin.r)),
    g: clamp01(linearToSrgb(lin.g)),
    b: clamp01(linearToSrgb(lin.b)),
  };
}

function hexToOklch(hex: string): OKLCH {
  const n = hex.replace("#", "");
  const r = srgbToLinear(parseInt(n.slice(0, 2), 16) / 255);
  const g = srgbToLinear(parseInt(n.slice(2, 4), 16) / 255);
  const b = srgbToLinear(parseInt(n.slice(4, 6), 16) / 255);
  const { L, a, bb } = linearRgbToOklab(r, g, b);
  return {
    l: L,
    c: Math.hypot(a, bb),
    h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toHex = ({ r, g, b }: RGB) =>
  "#" +
  [r, g, b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

const oklch = (l: number, c: number, h: number) => toHex(oklchToRgb({ l, c, h }));

/** WCAG 2.1 relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const r = srgbToLinear(parseInt(n.slice(0, 2), 16) / 255);
  const g = srgbToLinear(parseInt(n.slice(2, 4), 16) / 255);
  const b = srgbToLinear(parseInt(n.slice(4, 6), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Perceptual distance between two colours in OKLab.
 *
 * WCAG contrast is a luminance ratio, which is the right question for "can I
 * read this text" and the WRONG question for "can I see this highlight". A
 * yellow highlighter on white paper is about 1.16:1 — by contrast ratio it is
 * invisible, yet everyone can see it, because the difference is chroma rather
 * than lightness. Asking for 3:1 there would force a highlighter dark enough to
 * look like a redaction bar.
 *
 * Calibrated against real values: a washed-out tint on white measures 0.07, the
 * `<mark>` bug that prompted this (near-black navy on a near-black surface)
 * measures 0.10, and a real highlighter pen on paper measures 0.15.
 */
function perceptualDistance(a: string, b: string): number {
  const x = hexToOklch(a);
  const y = hexToOklch(b);
  const toLab = ({ l, c, h }: OKLCH) => {
    const r = (h * Math.PI) / 180;
    return { L: l, a: c * Math.cos(r), b: c * Math.sin(r) };
  };
  const p = toLab(x);
  const q = toLab(y);
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ── Theme declarations ──────────────────────────────────────────────────────

interface Seeds {
  accent: string;
  success: string;
  warning: string;
  danger: string;
  solved: string;
  staff: string;
  deprecated: string;
}

/**
 * Seed hues. Only hue and chroma are taken from these — lightness comes from
 * the theme, so the same seed reads correctly on a black background and a white
 * one. `accent` and `danger` are sampled from the live forum so DFP stays
 * recognisably Roblox; `staff` is deliberately not blue, because a "staff
 * replied" marker that looks like a link is a marker nobody sees.
 */
const SEEDS: Seeds = {
  accent: "#2bb1ff",
  success: "#3ddc84",
  warning: "#ffb020",
  danger: "#f4645d",
  solved: "#3ddc84",
  staff: "#b47cff",
  deprecated: "#ff8a4c",
};

interface ThemeSpec {
  id: string;
  mode: "dark" | "light";
  /** Neutral ramp hue/chroma. A little chroma stops greys looking dead. */
  neutral: { h: number; c: number };
  /** Lightness stops for the neutral ramp, 0–1. */
  ramp: {
    bg: number;
    s1: number;
    s2: number;
    s3: number;
    border: number;
    borderStrong: number;
    text: number;
    text2: number;
    text3: number;
  };
  /** Lightness applied to seed hues. */
  chromaL: { solid: number; soft: number; softChroma: number };
}

const THEMES: ThemeSpec[] = [
  {
    id: "dark",
    mode: "dark",
    neutral: { h: 264, c: 0.012 },
    ramp: {
      bg: 0.165,
      s1: 0.203,
      s2: 0.238,
      s3: 0.275,
      border: 0.3,
      borderStrong: 0.385,
      text: 0.965,
      text2: 0.782,
      text3: 0.632,
    },
    chromaL: { solid: 0.735, soft: 0.29, softChroma: 0.055 },
  },
  {
    id: "dim",
    mode: "dark",
    neutral: { h: 264, c: 0.014 },
    ramp: {
      bg: 0.225,
      s1: 0.258,
      s2: 0.29,
      s3: 0.322,
      border: 0.35,
      borderStrong: 0.43,
      text: 0.93,
      text2: 0.775,
      text3: 0.64,
    },
    chromaL: { solid: 0.72, soft: 0.34, softChroma: 0.05 },
  },
  {
    id: "black",
    mode: "dark",
    neutral: { h: 264, c: 0.006 },
    ramp: {
      bg: 0.02,
      s1: 0.115,
      s2: 0.155,
      s3: 0.195,
      border: 0.235,
      borderStrong: 0.33,
      text: 0.97,
      text2: 0.79,
      text3: 0.635,
    },
    chromaL: { solid: 0.75, soft: 0.235, softChroma: 0.06 },
  },
  {
    id: "light",
    mode: "light",
    neutral: { h: 264, c: 0.008 },
    ramp: {
      bg: 0.972,
      s1: 1.0,
      s2: 1.0,
      s3: 1.0,
      border: 0.905,
      borderStrong: 0.8,
      text: 0.255,
      text2: 0.455,
      text3: 0.572,
    },
    chromaL: { solid: 0.545, soft: 0.945, softChroma: 0.045 },
  },
];

// ── Generation ──────────────────────────────────────────────────────────────

interface Check {
  theme: string;
  pair: string;
  ratio: number;
  min: number;
  /* Most checks are WCAG luminance ratios. A few ask a different question —
   * "is this highlight perceptible" — and are OKLab distances, which must not
   * be printed as "N:1". */
  unit?: "ratio" | "distance";
}

function buildTheme(spec: ThemeSpec): { css: string; checks: Check[] } {
  const { h, c } = spec.neutral;
  const n = (l: number) => oklch(l, c, h);

  const bg = n(spec.ramp.bg);
  const s1 = n(spec.ramp.s1);
  const s2 = n(spec.ramp.s2);
  const s3 = n(spec.ramp.s3);
  const border = n(spec.ramp.border);
  const borderStrong = n(spec.ramp.borderStrong);
  const text = n(spec.ramp.text);
  const text2 = n(spec.ramp.text2);
  const text3 = n(spec.ramp.text3);

  const vars: string[] = [
    `--dfp-bg: ${bg};`,
    `--dfp-surface-1: ${s1};`,
    `--dfp-surface-2: ${s2};`,
    `--dfp-surface-3: ${s3};`,
    `--dfp-border: ${border};`,
    `--dfp-border-strong: ${borderStrong};`,
    `--dfp-text: ${text};`,
    `--dfp-text-2: ${text2};`,
    `--dfp-text-3: ${text3};`,
  ];

  const checks: Check[] = [
    { theme: spec.id, pair: "text on bg", ratio: contrast(text, bg), min: 7 },
    { theme: spec.id, pair: "text-2 on bg", ratio: contrast(text2, bg), min: 4.5 },
    { theme: spec.id, pair: "text-3 on bg", ratio: contrast(text3, bg), min: 3 },
    { theme: spec.id, pair: "text on surface-1", ratio: contrast(text, s1), min: 7 },
    { theme: spec.id, pair: "text-2 on surface-1", ratio: contrast(text2, s1), min: 4.5 },
  ];

  /** Captured from the loop below to build the `<mark>` pair. */
  let warningSolid = "";
  let warningSoft = "";

  for (const [name, seed] of Object.entries(SEEDS) as [keyof Seeds, string][]) {
    const { c: seedC, h: seedH } = hexToOklch(seed);
    const solid = oklch(spec.chromaL.solid, seedC, seedH);
    const soft = oklch(spec.chromaL.soft, spec.chromaL.softChroma, seedH);
    if (name === "warning") {
      warningSolid = solid;
      warningSoft = soft;
    }

    // Pick the foreground that actually reads on this colour rather than
    // assuming white — a bright warning yellow needs dark text.
    const onWhite = contrast(solid, "#ffffff");
    const onBlack = contrast(solid, "#0a0a0a");
    const fg = onWhite >= onBlack ? "#ffffff" : "#0a0a0a";

    vars.push(`--dfp-${name}: ${solid};`);
    vars.push(`--dfp-${name}-soft: ${soft};`);
    vars.push(`--dfp-${name}-fg: ${fg};`);

    checks.push({
      theme: spec.id,
      pair: `${name}-fg on ${name}`,
      ratio: Math.max(onWhite, onBlack),
      min: 4.5,
    });
    // Non-text UI colour against the surface it sits on: WCAG 1.4.11.
    checks.push({
      theme: spec.id,
      pair: `${name} on surface-1`,
      ratio: contrast(solid, s1),
      min: 3,
    });
    /* Code blocks reuse these same colours as syntax tokens on surface-2,
     * where they are body text rather than indicators — so 3:1 is not enough.
     * Measured in the browser at 6.6–7.6:1; this keeps a future ramp change
     * from quietly dropping a token colour below legible. */
    checks.push({
      theme: spec.id,
      pair: `${name} as code token on surface-2`,
      ratio: contrast(solid, s2),
      min: 4.5,
    });
    checks.push({
      theme: spec.id,
      pair: `text on ${name}-soft`,
      ratio: contrast(text, soft),
      min: 4.5,
    });
  }

  /* ── Highlighted text: <mark> ────────────────────────────────────────────
   * What `==this==` compiles to in a post — an author saying "read this part".
   *
   * It needs its own pair because neither existing token works across
   * polarities. `--dfp-warning` is tuned as an *indicator* and is dark in the
   * light theme (#976500), which would make a light-theme highlight a brown
   * block; `--dfp-warning-soft` is a dark tint in the dark themes and would be
   * a highlight you cannot see. A highlighter has to be brighter than the page,
   * so the direction flips: saturated on dark, pale on light.
   *
   * Amber rather than the accent, deliberately. `::selection` is already the
   * accent blue, and an author's highlight that looks identical to the reader's
   * own text selection is unreadable in a different way — I misread one for the
   * other while diagnosing this. A highlighter is yellow everywhere else in the
   * world, and keeping that is worth more than palette purity. */
  const warnHue = hexToOklch(SEEDS.warning).h;
  /* The dark themes take the saturated warning directly. The light theme needs
   * its own stop: `--dfp-warning-soft` on white measures 0.07 perceptual
   * distance — *fainter than the bug this is fixing* — so it is built here at a
   * highlighter's lightness and chroma instead. */
  /* Chroma is gamut-capped at this hue, so lightness is the only real dial:
   * 0.92 measured 0.104Δ (still invisible), 0.88 measures 0.158Δ — just past a
   * real highlighter pen, and 10.8:1 against light-theme body text. */
  const markBg = spec.mode === "dark" ? warningSolid : oklch(0.88, 0.18, warnHue);
  const markFg =
    contrast(markBg, "#ffffff") >= contrast(markBg, "#0a0a0a") ? "#ffffff" : "#0a0a0a";
  vars.push(`--dfp-mark-bg: ${markBg};`);
  vars.push(`--dfp-mark-fg: ${markFg};`);
  checks.push({
    theme: spec.id,
    pair: "mark-fg on mark-bg",
    ratio: contrast(markBg, markFg),
    min: 4.5,
  });
  /* And the highlight must be visible *as* a highlight against the post
   * surface, or it is decoration nobody notices. This is the check that would
   * have caught the original bug — but measured perceptually, not by luminance
   * ratio, because a highlighter is supposed to differ in chroma. */
  checks.push({
    theme: spec.id,
    pair: "mark-bg vs surface-1 (perceptual)",
    ratio: perceptualDistance(markBg, s1),
    min: 0.13,
    unit: "distance",
  });

  /* ── Filled-button accent ────────────────────────────────────────────────
   * The plain `--dfp-accent` is tuned to read as a link and an indicator on a
   * dark surface, which makes it bright — bright enough that white text fails
   * against it, so `--dfp-accent-fg` resolves to near-black. Contrast-correct,
   * but a cyan button with black text is the one element that refuses to look
   * like it belongs in a dark UI.
   *
   * So filled buttons get their own step: the darkest version of the same hue
   * that still clears 4.5:1 against white. Found by search rather than guessed,
   * so it stays correct if a seed hue changes. */
  const { c: accentC, h: accentH } = hexToOklch(SEEDS.accent);
  let accentStrong = oklch(0.5, accentC, accentH);
  for (let l = 0.68; l >= 0.3; l -= 0.005) {
    const candidate = oklch(l, accentC, accentH);
    if (contrast(candidate, "#ffffff") >= 4.6) {
      accentStrong = candidate;
      break;
    }
  }
  vars.push(`--dfp-accent-strong: ${accentStrong};`);
  vars.push(`--dfp-on-accent: #ffffff;`);
  checks.push({
    theme: spec.id,
    pair: "white on accent-strong",
    ratio: contrast(accentStrong, "#ffffff"),
    min: 4.5,
  });
  checks.push({
    theme: spec.id,
    pair: "accent-strong on surface-1",
    ratio: contrast(accentStrong, s1),
    min: 3,
  });

  const css =
    `html[data-dfp][data-dfp-theme="${spec.id}"] {\n` +
    `  color-scheme: ${spec.mode};\n` +
    vars.map((v) => `  ${v}`).join("\n") +
    `\n}\n`;

  return { css, checks };
}

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, "../src/styles/tokens.generated.css");

const blocks: string[] = [];
const allChecks: Check[] = [];

for (const spec of THEMES) {
  const { css, checks } = buildTheme(spec);
  blocks.push(css);
  allChecks.push(...checks);
}

const failures = allChecks.filter((c) => c.ratio < c.min);

// Report every pair so a regression is visible in CI logs, not just failures.
const width = Math.max(...allChecks.map((c) => `${c.theme} ${c.pair}`.length));
for (const c of allChecks) {
  const label = `${c.theme} ${c.pair}`.padEnd(width);
  const status = c.ratio < c.min ? "FAIL" : "ok  ";
  const value =
    c.unit === "distance"
      ? `${c.ratio.toFixed(3)}Δ  (min ${c.min})`
      : `${c.ratio.toFixed(2)}:1  (min ${c.min})`;
  console.log(`  ${status} ${label}  ${value}`);
}

if (failures.length > 0) {
  console.error(
    `\ntokens: ${failures.length} contrast check(s) failed. ` +
      `Adjust the lightness stops in scripts/build-tokens.ts.`,
  );
  process.exit(1);
}

const header = `/* GENERATED by scripts/build-tokens.ts — do not edit.
 * Run \`npm run tokens\` after changing a theme spec.
 *
 * ${allChecks.length} contrast assertions passed at generation time.
 */\n\n`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, header + blocks.join("\n"), "utf8");

console.log(
  `\ntokens: wrote ${THEMES.length} themes to src/styles/tokens.generated.css ` +
    `(${allChecks.length} contrast checks passed)`,
);
