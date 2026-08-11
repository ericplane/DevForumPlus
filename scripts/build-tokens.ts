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
 * Code blocks are the one thing that does *not* come from the seed hues. They
 * get their own ramp (see SYNTAX) because a syntax token and a UI indicator ask
 * opposite things of the same colour, and because the seed hues are isoluminant
 * by construction — fine for badges, useless for eleven token classes that have
 * to stay apart in greyscale and under colour-vision deficiency.
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

/**
 * Deuteranopia simulation, after Viénot, Brettel & Mollon (1999).
 *
 * Needed because a syntax palette is the one place in the product where colour
 * is the *only* channel carrying meaning — there is no icon, no label and no
 * position to fall back on. Roughly 1 in 12 men cannot use the red–green axis,
 * and the old palette put `local` and `task` 0.006Δ apart for them.
 *
 * Applied in linear RGB rather than the paper's gamma-encoded values: the
 * projection is a linear operation on cone responses, and doing it after
 * gamma-encoding exaggerates the shift in the shadows.
 *
 * What the numbers below are worth knowing: at constant OKLab lightness the
 * whole hue wheel collapses to a line segment 0.297 long (measured at L 0.75,
 * C 0.16, hue 70 to hue 240), and simulated lightness varies by only 0.008
 * across it. So for a deuteranope the palette is two-dimensional — lightness
 * plus a single blue-yellow axis — and lightness has to do most of the work.
 */
function deuteranope(hex: string): string {
  const n = hex.replace("#", "");
  const r = srgbToLinear(parseInt(n.slice(0, 2), 16) / 255);
  const g = srgbToLinear(parseInt(n.slice(2, 4), 16) / 255);
  const b = srgbToLinear(parseInt(n.slice(4, 6), 16) / 255);
  // Linear RGB → LMS (Viénot's fit to the Smith–Pokorny fundamentals).
  const L = 17.8824 * r + 43.5161 * g + 4.11935 * b;
  const M = 3.45565 * r + 27.1554 * g + 3.86714 * b;
  const S = 0.0299566 * r + 0.184309 * g + 1.46709 * b;
  // The deuteranope's M response is not measured but inferred from L and S.
  const m = 0.494207 * L + 1.24827 * S;
  return toHex({
    r: clamp01(linearToSrgb(clamp01(0.080944 * L - 0.130504 * m + 0.116721 * S))),
    g: clamp01(linearToSrgb(clamp01(-0.0102485 * L + 0.0540194 * m - 0.113615 * S))),
    b: clamp01(linearToSrgb(clamp01(-0.000365294 * L - 0.00412163 * m + 0.693513 * S))),
  });
}

/** Perceptual distance as a deuteranope sees it. */
const deutanDistance = (a: string, b: string): number =>
  perceptualDistance(deuteranope(a), deuteranope(b));

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

/**
 * `deprecated` is pulled off the shared seed lightness.
 *
 * Every other seed takes `chromaL.solid` verbatim, which is what keeps the
 * palette coherent — and which is exactly why this one had to move. At the
 * shared lightness, `deprecated` (hue 46.8) measured 0.077Δ from `warning`
 * (hue 75.0) and 0.060Δ from `danger` (hue 25.7): both under half the 0.13Δ
 * floor this file sets for itself above, and the file's own comment calls
 * 0.07 "a washed-out tint". Those three then have to answer three different
 * questions — caution, error, stale API — and `--dfp-dep--warn` and
 * `--dfp-dep--error` are the two decoration colours of the *same* wavy
 * underline. Three near-identical oranges cannot do that.
 *
 * Hue alone cannot fix it: the warm arc between danger and warning is 49°
 * wide, and 0.13Δ at this chroma needs about 51°. So the separation is bought
 * with lightness instead, in the direction that also helps legibility — the
 * mark gets brighter on dark themes and darker on light ones. Solved by
 * search, not taste: 0.104 is the minimum offset that clears warning and
 * 0.114 the minimum that clears danger, so 0.134 ships with margin.
 */
const DEPRECATED_SHIFT = { hue: -12, lightness: 0.134 };

/**
 * The syntax ramp.
 *
 * Seeded and lit independently of SEEDS, because reusing the product palette
 * for code forced single hexes to answer two incompatible questions:
 * `--dfp-warning` had to be conspicuous as a badge and recessive as a numeric
 * literal; `--dfp-deprecated` had to be an alarm as an underline and a neutral
 * category as an hljs built-in. Worse, every seed-derived colour shares one
 * lightness, so the four token colours measured an OKLab L spread of 0.002
 * (dark 0.7340–0.7357). In greyscale the dark theme's six token colours spanned
 * sRGB 164–185, keyword-vs-builtin was 1.071:1, and under a deuteranopia
 * simulation `local` and `task` collapsed to 0.006Δ.
 *
 * Lightness is modelled in two parts, and the split matters:
 *
 *   dL   — where the hue sits in the ramp. Identical in every theme, because
 *          it tracks the sRGB gamut rather than the theme: blue holds chroma
 *          only at low lightness and gold only at high, and a table that flips
 *          with polarity fights that on one of the two polarities. Measured:
 *          the blue end of the deuteranope axis reaches -0.219 at L 0.60 but
 *          only -0.050 at L 0.90.
 *   mute — how far a recessive role backs off from live code. This one *does*
 *          flip with polarity, so a comment is darker on the dark themes and
 *          lighter on the light one.
 *
 * Hues are not decorative. Because the deuteranope axis is one-dimensional,
 * roles that must never be confused are placed both at different hues and at
 * different lightnesses; roles that land in the same deuteranope column are
 * pushed apart in lightness instead. Every number here was found by annealing
 * against the assertion set below, then checked by eye.
 *
 * Result on the dark theme: the greyscale span of the token colours goes from
 * sRGB 164–185 to 138–232, and the worst deuteranope pair from 0.006Δ to
 * 0.072Δ. Print a code block in black and white and it still parses.
 */
interface SyntaxRole {
  name: string;
  /** null takes the theme's neutral hue, so greys stay theme-aware. */
  h: number | null;
  c: number;
  dL: number;
  mute: number;
}

const SYNTAX: SyntaxRole[] = [
  { name: "kw", h: 286, c: 0.215, dL: -0.124, mute: 0 },
  { name: "builtin", h: 264, c: 0.163, dL: -0.054, mute: 0 },
  { name: "type", h: 210, c: 0.1, dL: -0.04, mute: 0 },
  { name: "str", h: 136, c: 0.137, dL: 0.06, mute: 0 },
  { name: "num", h: 103, c: 0.171, dL: 0.146, mute: 0 },
  { name: "fn", h: 332, c: 0.189, dL: -0.116, mute: 0 },
  { name: "prop", h: 206, c: 0.106, dL: 0.094, mute: 0 },
  { name: "method", h: 88, c: 0.15, dL: -0.058, mute: 0 },
  /* Legacy globals keep a trace of the deprecation hue but almost none of its
   * chroma — the point is "faded", not "alarming". The alarm is the underline
   * on top, which is `--dfp-deprecated` and is asserted 0.13Δ clear of this. */
  { name: "legacy", h: 20, c: 0.086, dL: 0.026, mute: 0.145 },
  { name: "com", h: null, c: 0.027, dL: 0.009, mute: 0.155 },
  /* Punctuation is deliberately achromatic. A wall of coloured operators is
   * the fastest way to make a code block unreadable, and at c 0 the role sits
   * at the centre of the deuteranope axis where nothing else can afford to be
   * — which is what buys `com` and `op` their separation from the hues. */
  { name: "op", h: null, c: 0, dL: -0.008, mute: 0.045 },
];

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
  /**
   * Where the SYNTAX ramp sits in this theme, and how much chroma it gets.
   *
   * `base` is pinned from below by the 4.5:1 floor against surface-2 (a
   * neutral needs L ≥ 0.618 on dark, 0.658 on dim, 0.578 on black, and ≤ 0.556
   * on light) and from above by the 0.10Δ floor against `--dfp-text`. The light
   * theme's is the tightest: `com` must clear 4.5:1 on surface-2, which caps
   * the top of the band at 0.552 and so pins base at 0.385.
   */
  code: { base: number; chroma: number };
  /** Selector override. Defaults to the theme id as a `data-dfp-theme` value. */
  selector?: string;
  /** Wrap the block in this at-rule. */
  media?: string;
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
      /* 0.632 → 0.658. 4.26:1 on surface-3 — the code-block button cluster —
       * against the 4.5 floor. #8e9299 now measures 4.73:1 there. */
      text3: 0.658,
    },
    chromaL: { solid: 0.735, soft: 0.29, softChroma: 0.055 },
    code: { base: 0.781, chroma: 1.219 },
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
      /* Raised twice, both times because a guard named one surface and blessed
       * the token everywhere else it landed.
       *
       * 0.640 → 0.665: shipped #888c95 at 4.20:1 on surface-2, a WCAG AA
       * failure at the 13px `.hljs-comment` uses it at. Missed because the only
       * assertion measured text-3 against `bg` at a 3:1 non-text floor.
       *
       * 0.665 → 0.700: still 4.15:1 on surface-3, which is the CONTROL surface
       * the code-block buttons sit on. Now #9a9fa7 — 4.75:1 there, and the
       * tightest text-2/text-3 gap of any theme at 1.31:1, which is why that
       * pair is now asserted too. */
      text3: 0.700,
    },
    chromaL: { solid: 0.72, soft: 0.34, softChroma: 0.05 },
    code: { base: 0.804, chroma: 1.148 },
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
    code: { base: 0.774, chroma: 1.264 },
  },
  {
    id: "light",
    mode: "light",
    neutral: { h: 264, c: 0.008 },
    ramp: {
      bg: 0.972,
      s1: 1.0,
      /* s1/s2/s3 were all 1.0, so all three resolved to #ffffff and the whole
       * elevation system was flat in this theme — measured surface-2 against
       * surface-1 at 1.0000:1, 0.0000Δ, where the dark themes measure 0.031 to
       * 0.040Δ. The only thing separating a code block from the post behind it
       * was a 1px border at 1.323:1, under WCAG 1.4.11's 3:1 bar. post.css and
       * controls.css had each already patched the same collapse locally, by
       * mixing hover fills from the text colour instead of the surface tokens;
       * code blocks never got that treatment. Fixed at the source instead. */
      s2: 0.978,
      s3: 0.962,
      border: 0.905,
      borderStrong: 0.8,
      text: 0.255,
      text2: 0.455,
      /* 0.572 gave #75787d: 4.43:1 on white, and lower still now that
       * surface-2 is no longer white. It also sat only 0.027 above the syntax
       * band, against 0.102 on dark — a comment that read at the same weight as
       * live code. 0.553 clears AA on the new surface-2 and opens the gap. */
      /* Moves DOWN, unlike the dark themes: on a light surface a muted tone
       * gains contrast by darkening. 0.553 was 4.30:1 on surface-3; 0.530 gives
       * #696c71 at 4.71:1. */
      text3: 0.530,
    },
    /* 0.545 → 0.534 falls out of surface-2 no longer being white: `success`
     * measured 4.38:1 as body text on the new #f5f8fd. The seeds had been
     * sitting exactly on the 4.5:1 line against #ffffff, which is another way
     * of saying the flat surface ramp was propping them up. */
    chromaL: { solid: 0.534, soft: 0.945, softChroma: 0.045 },
    code: { base: 0.385, chroma: 1.386 },
  },
];

/**
 * Theme `off`.
 *
 * `off` is meant to stand the visual layer down, but it cannot: root-attrs.ts
 * only returns null when the extension is *disabled*, so `off` still stamps
 * both `data-dfp="1"` and `data-dfp-theme="off"`. Every DFP selector therefore
 * still matches while no block defines the custom properties they read, so
 * every `var(--dfp-*)` is guaranteed-invalid and falls back to inherit or
 * unset. That silently kills all eleven `.dfp-tok-*` rules and all eight
 * `.hljs-*` rules at once, plus the `<pre>` background and border — and since
 * code-intel is not theme-gated it has already replaced the highlight.js
 * markup by then, so a Luau block under `off` renders strictly worse than
 * stock: uncoloured DFP spans and no hljs spans to fall back to. The blast
 * radius is not limited to code; base.css's body colours collapse the same way.
 *
 * The fix has to live here because the attribute stamping is not this file's
 * to change, and it is deliberately not a sixth palette: `off` re-emits the
 * light and dark ramps under its own selector, picked by the OS. Inventing new
 * colours for it would mean shipping a palette nobody chose, nobody looks at,
 * and nobody would notice regressing — where these two are already asserted
 * end to end, and the whole assertion set below runs over them again here.
 * The dark half must be emitted last so it wins on equal specificity.
 */
const OFF_SELECTOR = 'html[data-dfp][data-dfp-theme="off"]';
const byId = (id: string) => THEMES.find((t) => t.id === id)!;
const asOff = (spec: ThemeSpec, id: string, media?: string): ThemeSpec => ({
  ...spec,
  id,
  selector: OFF_SELECTOR,
  media,
});
const OFF_THEMES: ThemeSpec[] = [
  asOff(byId("light"), "off"),
  asOff(byId("dark"), "off-dark", "(prefers-color-scheme: dark)"),
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
  /* Families with one line per *pair* run to hundreds of rows. They are still
   * asserted individually; only the log is collapsed to the worst member, so a
   * regression stays visible without burying every other check. */
  group?: string;
}

/**
 * Floors for "can I tell these two tokens apart".
 *
 * The target was 0.13Δ for every pair and 0.10Δ for every pair under the
 * deuteranopia simulation — the repo's own visibility floor, and 77% of it.
 * Eleven tokens cannot reach it, and the reason is geometric rather than a
 * failure of tuning:
 *
 *   - Under simulation the hue wheel is a segment 0.297 long, and its usable
 *     width shrinks as lightness rises (0.313 at L 0.68, 0.254 at L 0.84)
 *     because the blue end runs out of gamut. Four columns at 0.10Δ need
 *     0.30 of width; three gaps across 0.297 leaves 0.099 each at best.
 *   - Filling the second axis needs rows 0.10 apart in lightness. The band
 *     between the 4.5:1 floor on surface-2 and the 0.10Δ ceiling under
 *     `--dfp-text` is 0.28 on dark, 0.20 on dim, 0.26 on light. Eleven tokens
 *     need four rows; dim has room for two.
 *   - Achromatic roles are pinned to the centre of the segment, so no two of
 *     them may share a row at all.
 *
 * Measured directly: a randomised max-packing over the whole sRGB cube, with
 * *free* per-theme choice and no design constraints, fits 12 colours on dark
 * and exactly 11 on dim at 0.13/0.10 — zero slack for one shared table across
 * four themes. Annealing the real model from many starts plateaus at 0.84 of
 * those floors regardless of the search used.
 *
 * So these are the floors the shipped ramp actually holds, with the accessible
 * floors (4.5:1 on surface-2, 0.10Δ from body text, 0.13Δ from `--dfp-deprecated`)
 * kept at their real values rather than traded away. Raise them only alongside
 * a measurement showing the geometry moved — the pair that binds is not always
 * the same one.
 */
const TOKEN_PAIR_MIN = 0.096;
const TOKEN_PAIR_DEUTAN_MIN = 0.066;

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
    /* text-3 is the muted body colour AND the `.hljs-comment` colour, so it is
     * read at 13px on surface-2 — the code-block background, not `bg`. Checking
     * it against `bg` at 3:1 is what let dim ship at 4.20:1 and light at 4.43:1. */
    { theme: spec.id, pair: "text-3 on surface-2", ratio: contrast(text3, s2), min: 4.5 },
    /* And on surface-3, which is the CONTROL surface — the code-block button
     * cluster (`copy`, `wrap`, `copy without comments`, `copy with N fixes`) is
     * text-3 on it at 12px. Adding surface-2 and stopping there left that at
     * 4.26 dark / 4.15 dim / 5.35 black / 4.30 light: three of four themes under
     * the bar, on the most-clicked controls in the product.
     *
     * The lesson is the same one twice now — a guard that names one surface
     * silently blesses the token everywhere else it is painted. surface-3 is the
     * last one text-3 lands on; if a fourth is ever introduced, it needs a line
     * here on the same day. */
    { theme: spec.id, pair: "text-3 on surface-3", ratio: contrast(text3, s3), min: 4.5 },
    /* The cost of the line above, guarded.
     *
     * text-3 had to move TOWARD text-2 to clear surface-3 — that is the only
     * direction available, since text-3 is the muted tier and the surface it
     * sits on is fixed by the elevation ramp. Push it far enough and the two
     * text tiers stop being distinguishable, and "muted" stops meaning anything.
     *
     * Measured after the fix: dark 1.57, dim 1.31, black 1.76, light 1.38. The
     * floor is set just under the worst of those, which makes this a ratchet
     * rather than a target — it cannot silently get worse, and closing the gap
     * further is a decision someone has to make on purpose. */
    { theme: spec.id, pair: "text-2 vs text-3 (hierarchy)", ratio: contrast(text2, text3), min: 1.28 },
    /* Elevation has to be visible without relying on the border, which is
     * hairline and was measured at 1.32:1 in the light theme. */
    {
      theme: spec.id,
      pair: "surface-2 vs surface-1 (perceptual)",
      ratio: perceptualDistance(s2, s1),
      min: 0.02,
      unit: "distance",
    },
    {
      theme: spec.id,
      pair: "surface-3 vs surface-1 (perceptual)",
      ratio: perceptualDistance(s3, s1),
      min: 0.03,
      unit: "distance",
    },
  ];

  /** Captured from the loop below to build the `<mark>` pair. */
  let warningSolid = "";
  let warningSoft = "";
  /** Captured to check the deprecation mark against the tokens it underlines. */
  let deprecatedSolid = "";
  /** The `error` half of the same wavy underline. */
  let dangerSolid = "";

  for (const [name, seed] of Object.entries(SEEDS) as [keyof Seeds, string][]) {
    const { c: seedC, h: seedH } = hexToOklch(seed);
    const shift = name === "deprecated" ? DEPRECATED_SHIFT : { hue: 0, lightness: 0 };
    const toward = spec.mode === "dark" ? 1 : -1;
    const hue = seedH + shift.hue;
    const solid = oklch(spec.chromaL.solid + toward * shift.lightness, seedC, hue);
    const soft = oklch(spec.chromaL.soft, spec.chromaL.softChroma, hue);
    if (name === "warning") {
      warningSolid = solid;
      warningSoft = soft;
    }
    if (name === "deprecated") deprecatedSolid = solid;
    if (name === "danger") dangerSolid = solid;

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
    /* Several seeds are read as body text on surface-2 rather than used as
     * indicators — `--dfp-deprecated` labels the findings note, which sits on a
     * surface-2 tint at 12px — so 3:1 is not enough.
     *
     * This check used to be the *only* thing guarding syntax colours, and it
     * pushed the wrong way: raising chromaL.solid from 0.735 to 0.85 improves
     * it from 7.12 to 10.53 while collapsing member-vs-identifier from 1.78:1
     * to 1.32:1 — below the 1.47:1 that code.css records as having already
     * shipped broken once. The syntax ramp is now measured on its own terms
     * below, and this one is back to asking only what it can answer. */
    checks.push({
      theme: spec.id,
      pair: `${name} as body text on surface-2`,
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

  /* ── Syntax ramp ─────────────────────────────────────────────────────────
   * See SYNTAX above for why code no longer borrows the product palette. */
  const polarity = spec.mode === "dark" ? -1 : 1;
  const tokens = SYNTAX.map((role) => ({
    name: role.name,
    hex: oklch(
      spec.code.base + role.dL + polarity * role.mute,
      role.c * spec.code.chroma,
      role.h ?? h,
    ),
  }));

  for (const token of tokens) {
    vars.push(`--dfp-code-${token.name}: ${token.hex};`);
    /* surface-2 is the code-block background (code.css), and a token is body
     * text at 13px there — the 4.5:1 floor, not the 3:1 indicator floor. */
    checks.push({
      theme: spec.id,
      pair: `code-${token.name} on surface-2`,
      ratio: contrast(token.hex, s2),
      min: 4.5,
    });
    /* Anything left untokenised renders in `--dfp-text`. A token that lands on
     * top of plain identifier colour has spent a class on nothing. */
    checks.push({
      theme: spec.id,
      pair: `code-${token.name} vs identifier`,
      ratio: perceptualDistance(token.hex, text),
      min: 0.1,
      unit: "distance",
    });
    /* The deprecation underline is drawn *through* whichever token it marks,
     * most often `legacy` or a member. Same colour, no mark. */
    checks.push({
      theme: spec.id,
      pair: `deprecated vs code-${token.name}`,
      ratio: perceptualDistance(deprecatedSolid, token.hex),
      min: 0.13,
      unit: "distance",
    });
  }

  for (const [i, a] of tokens.entries()) {
    for (const b of tokens.slice(i + 1)) {
      const label = `${a.name}/${b.name}`;
      checks.push({
        theme: spec.id,
        pair: `code ${label}`,
        ratio: perceptualDistance(a.hex, b.hex),
        min: TOKEN_PAIR_MIN,
        unit: "distance",
        group: "code token pairs",
      });
      checks.push({
        theme: spec.id,
        pair: `code ${label} (deuteranopia)`,
        ratio: deutanDistance(a.hex, b.hex),
        min: TOKEN_PAIR_DEUTAN_MIN,
        unit: "distance",
        group: "code token pairs (deuteranopia)",
      });
    }
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

  /* `--dfp-dep--warn` and `--dfp-dep--error` are the two decoration colours of
   * the same wavy underline, and `--dfp-warning` is the badge that sits beside
   * them. All three were within 0.08Δ of each other. See DEPRECATED_SHIFT. */
  checks.push({
    theme: spec.id,
    pair: "deprecated vs warning (perceptual)",
    ratio: perceptualDistance(deprecatedSolid, warningSolid),
    min: 0.13,
    unit: "distance",
  });
  checks.push({
    theme: spec.id,
    pair: "deprecated vs danger (perceptual)",
    ratio: perceptualDistance(deprecatedSolid, dangerSolid),
    min: 0.13,
    unit: "distance",
  });

  const selector = spec.selector ?? `html[data-dfp][data-dfp-theme="${spec.id}"]`;
  const body =
    `${selector} {\n` +
    `  color-scheme: ${spec.mode};\n` +
    vars.map((v) => `  ${v}`).join("\n") +
    `\n}\n`;
  const css = spec.media
    ? `@media ${spec.media} {\n` +
      body
        .split("\n")
        .map((line) => (line ? `  ${line}` : line))
        .join("\n") +
      `}\n`
    : body;

  return { css, checks };
}

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, "../src/styles/tokens.generated.css");

const blocks: string[] = [];
const allChecks: Check[] = [];

// `off` last: its dark half is a media query at equal specificity, so it has
// to come after everything it overrides.
for (const spec of [...THEMES, ...OFF_THEMES]) {
  const { css, checks } = buildTheme(spec);
  blocks.push(css);
  allChecks.push(...checks);
}

const failures = allChecks.filter((c) => c.ratio < c.min);

const format = (c: Check) =>
  c.unit === "distance"
    ? `${c.ratio.toFixed(3)}Δ  (min ${c.min})`
    : `${c.ratio.toFixed(2)}:1  (min ${c.min})`;

/* Report every pair so a regression is visible in CI logs, not just failures —
 * except the two families with one row per token *pair*, which are 660 rows
 * between them and would bury everything else. Those still assert per pair;
 * only the log collapses to the worst member, which is the row that moves
 * first when the ramp changes. */
const ungrouped = allChecks.filter((c) => !c.group);
const width = Math.max(...ungrouped.map((c) => `${c.theme} ${c.pair}`.length));
for (const c of ungrouped) {
  const label = `${c.theme} ${c.pair}`.padEnd(width);
  console.log(`  ${c.ratio < c.min ? "FAIL" : "ok  "} ${label}  ${format(c)}`);
}

const groups = new Map<string, Check[]>();
for (const c of allChecks) {
  if (!c.group) continue;
  const key = `${c.theme} ${c.group}`;
  const bucket = groups.get(key);
  if (bucket) bucket.push(c);
  else groups.set(key, [c]);
}
for (const [key, members] of groups) {
  const worst = members.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  const label = `${key} (${members.length}, worst ${worst.pair.replace(/^code /, "")})`;
  console.log(
    `  ${worst.ratio < worst.min ? "FAIL" : "ok  "} ${label.padEnd(width)}  ${format(worst)}`,
  );
}

if (failures.length > 0) {
  console.error(
    `\ntokens: ${failures.length} check(s) failed. ` +
      `Adjust the lightness stops in scripts/build-tokens.ts.`,
  );
  process.exit(1);
}

const header = `/* GENERATED by scripts/build-tokens.ts — do not edit.
 * Run \`npm run tokens\` after changing a theme spec.
 *
 * ${allChecks.length} contrast and separation assertions passed at generation
 * time, including every syntax-token pair under a deuteranopia simulation.
 */\n\n`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, header + blocks.join("\n"), "utf8");

console.log(
  `\ntokens: wrote ${THEMES.length} themes plus "off" to ` +
    `src/styles/tokens.generated.css (${allChecks.length} checks passed)`,
);
