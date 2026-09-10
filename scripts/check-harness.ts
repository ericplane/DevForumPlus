/**
 * Renders the visual harness in a headless Chromium and grades what it painted.
 *
 * Until this existed CI had never looked at a pixel of the product.
 * check-styles.ts proves every styled class has fixture markup and
 * build-tokens.ts proves the palette's 1122 token pairs contrast — and the
 * composer's "Saving" bar still shipped black on black, because the bar's text
 * took `color` from #reply-control, which resolved to the page background, and
 * no token pair describes "an unstyled element inherits the page background".
 * That failure is only visible in the rendered page, so this is the check that
 * reads the rendered page:
 *
 *   1. Every visible run of text under the fixture — text nodes, ::before and
 *      ::after content, input values and placeholders — is graded for WCAG
 *      contrast against what is actually painted behind it: its own colour
 *      composited up the ancestor chain through each background colour,
 *      gradient stop and opacity until the paint is opaque. Under 3:1 fails
 *      (the floor for anything, large text included — WCAG 1.4.3 and 1.4.11).
 *      Under 4.5:1 on body-sized text is held by a ratchet, the shape
 *      check-styles.ts uses for fixture coverage:
 *      tests/visual/contrast-warnings.json lists the runs that sit between
 *      the two today (the Solved badge at 3.67:1, #696c71 on the tinted post
 *      surfaces at 4.32:1, the op-pin toggle at 4.38:1 — the file itself is
 *      the count), a run not listed fails, and a listed run that stops firing
 *      is reported so the file shrinks as those get fixed.
 *      Without the ratchet a composite-surface regression from 7:1 to 3.5:1
 *      printed one `warn` line in a CI log nobody reads. Text painted over a
 *      bitmap is counted but not graded: there is no one colour to grade it
 *      against. Disabled controls are exempt, as 1.4.3 exempts them.
 *
 *      And the grading has to have happened. A copy of the harness with
 *      `.page { display: none }` reported `0 runs 0 <3:1 0 <4.5:1` for all 42
 *      combinations and ended `check:harness: ok` — the fixture check's own
 *      failure, "reports success whether or not it rendered anything",
 *      reproduced one rung up. So every fixture block (`section.harness-block`,
 *      five today) must grade at least one run on every render; a floor, not a
 *      count, because the flags renders legitimately fold posts and drop
 *      4–23 runs. A rule that hides a block, or the whole fixture, now fails
 *      the build instead of cleaning it.
 *
 *   2. The document must not scroll horizontally at either width. A chip that
 *      wraps or a table that grows past the viewport is a layout regression the
 *      fixture check cannot express.
 *
 *   3. The corner radii follow the radius tokens. The four `--dfp-r-*` lengths
 *      are read off <html> for whichever radius the toolbar has selected, and
 *      two things are asserted against them: a fixed list of pills and cards
 *      (RADIUS_ANCHORS) resolves every named corner to its token's value — the
 *      "pill that lost its radius" the fixture check cannot see — on the
 *      matches that are actually rendered (getComputedStyle reports a radius
 *      on a display: none element too, which is how the hidden-fixture copy
 *      above passed every anchor; an anchor none of whose matches has a box
 *      fails like one that matches nothing) — and, on the `sharp` and `round`
 *      renders, every box under the fixture whose corner
 *      was a token value at `soft` has moved to the same token's new value.
 *      The second catches a hard-coded 8px that happens to match soft's `sm`
 *      without a list; corners that were not a token value at soft (0, 50%,
 *      the 999px pills, `calc(var(--dfp-r-sm) - 1px)` on a <summary>) are not
 *      the token's to move and are left alone.
 *
 *   4. A full-page PNG per combination lands in .output/harness-shots/, which
 *      ci.yml uploads — the evidence behind a failure and the review material
 *      for a pass, across the combinations nobody opens by hand.
 *
 * Every theme x density the toolbar offers is rendered at 1280 px and 720 px —
 * real window widths, so the width media queries that the toolbar's column
 * buttons cannot fire (build-harness.ts, VIEWPORTS) do apply here — plus `off`
 * under an OS dark scheme (tokens.generated.css swaps its palette on
 * prefers-color-scheme, a second look the toolbar cannot select), the three
 * module flags together at the harness default — the only way rules gated on
 * data-dfp-threaded / -op-pin / -quiet get rendered at all — and each radius
 * other than the default at the harness default, so `sharp` and `round` are
 * rendered by something: until they were, the screenshots only ever showed
 * `soft`. The combinations are read off the toolbar rather than listed here so
 * a theme added to build-harness.ts is audited without anyone remembering
 * this file.
 *
 * Shapes considered and turned down:
 *
 *   - Pixel baselines. 45 combinations x 2 widths of committed PNGs, and
 *     BuilderSans is absent in CI, so every baseline would have to be born on
 *     the runner — a maintenance cost with no owner yet. The audit here is
 *     deterministic across machines because it reads computed styles, not
 *     pixels; baselines can come later, on top of the screenshots it writes.
 *   - A structural smoke over every `.dfp-*` element (non-zero box, resolved
 *     colour). Many are legitimately empty or invisible at rest — the code-block
 *     buttons are opacity: 0 until hover — and a "resolved colour" cannot tell
 *     rgb(12,14,20) on rgb(20,23,28) from a fine one. Contrast can.
 *   - Full `playwright` with a downloaded browser. playwright-core drives the
 *     Chrome the ubuntu runner already ships (channel "chrome"); the fallback
 *     to "msedge" is for the development machine, which turned out to have
 *     Edge and Brave and no Chrome. DFP_BROWSER=<path> overrides both.
 *   - Grading text against whatever is painted behind it, siblings included.
 *     `composite` walks the ancestor chain only, so text over a sibling's
 *     paint — a badge over an avatar, the timeline handle over the scroller
 *     track, any absolutely positioned overlay — is graded against its
 *     ancestors' backgrounds, not the box it is actually on top of. Bitmaps
 *     underneath are counted as indeterminate; sibling overlap is neither
 *     counted nor graded. elementsFromPoint at the run's centre would see
 *     the real stack and is the shape to reach for when an overlay regresses.
 *
 * Two things about running it that the code does not make obvious:
 *
 *   - tsx compiles with esbuild's keepNames, which wraps every nested function
 *     in `__name(fn, "fn")`. Playwright ships a function to the page as source,
 *     so the audit's helpers arrived referencing a `__name` the page does not
 *     have: `ReferenceError: __name is not defined` on the first evaluate. The
 *     one-line init script defines it as identity; nothing else in the page is
 *     touched. The colour maths is installed the same way, from
 *     harness-color.ts, so that a unit test can reach it.
 *   - A theme switch starts `transition: color` across most of the page
 *     (120–320 ms per tokens.css), getComputedStyle reports the colour
 *     mid-flight, and perf.css's `content-visibility: auto` keeps posts below
 *     the fold on the old theme entirely until they render. `settle` below
 *     records what was measured and why the viewport briefly grows to the
 *     document's height; stamping data-dfp-motion="off" was not taken because
 *     it would also stop the skeleton shimmer and change what the screenshots
 *     show, and would not have touched the skipped posts anyway.
 *
 * Run: npm run harness && npm run check:harness
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { colorTools, type ColorTools, type Rgba } from "./harness-color";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
/* DFP_HARNESS=<path> audits a harness that is not this checkout's build — the
 * harness.html a CI run uploaded, or a copy with a candidate fix pasted in,
 * which is how the harness-side fixes reported by this script get verified
 * without touching build-harness.ts. */
const harnessPath = resolve(root, process.env["DFP_HARNESS"] || ".output/harness.html");
const shotsDir = resolve(root, ".output/harness-shots");
/* The runs accepted between 3:1 and 4.5:1, one `path|fg|bg` key each. Written
 * on the first local run if absent, the way check-styles.ts bootstraps
 * uncovered.json (on CI an absent file is a failure, not a bootstrap: a
 * baseline born on the runner accepts everything); after that a key not listed
 * fails and a listed key that no longer fires is reported. The path in a key
 * is up to four levels of fixture markup, so a fixture edit that moves a run
 * makes a NEW key: delete the file and re-run to regenerate it, then review
 * the keys before committing. */
const ratchetPath = resolve(root, "tests/visual/contrast-warnings.json");

/* WCAG 1.4.3: 4.5:1 for body text, 3:1 for large text; 1.4.11: 3:1 for
 * anything that has to be seen. 3:1 is therefore the floor a build fails on,
 * and 4.5:1 is what body text should reach — reported, not enforced, because
 * the palette today has runs that sit between the two (the run output lists
 * them) and a wall there would be a wall nobody could pass. */
const FAIL_BELOW = 3;
const WARN_BELOW = 4.5;

/* Desktop and the narrowest width the layout is expected to hold at. 720 is
 * where the topic list and the composer bar start to compete for the row. */
const WIDTHS = [1280, 720] as const;
const VIEWPORT_HEIGHT = 900;

/* Branded channels playwright-core can launch without downloading anything,
 * in the order tried. GitHub's ubuntu image ships Chrome; Windows ships Edge. */
const CHANNELS = ["chrome", "msedge"] as const;

/* Transitions are 120–320 ms; a switch that has not settled in this long is a
 * transition that never ends, which is a bug worth the failure. */
const SETTLE_TIMEOUT_MS = 5000;

/* How tall the viewport may grow while a switch settles (see `settle`). The
 * harness measured 4999 px at 1280 and 5175 px at 720 today, about a third of
 * this; anything past the cap would stay skipped and could grade stale, so the
 * cap is generous rather than tight. */
const MAX_SETTLE_HEIGHT = 16000;

/* The tokens tokens.css declares per radius variant, in the order they are
 * reported; `full` is the 999px pill radius, the same in every variant. */
const RADIUS_TOKENS = ["xs", "sm", "md", "lg", "full"] as const;
type RadiusToken = (typeof RADIUS_TOKENS)[number];
type Corner = "top-left" | "top-right" | "bottom-right" | "bottom-left";

interface RadiusAnchor {
  /** Matched under the fixture; matching nothing is a failure, so a renamed fixture block is noticed. */
  selector: string;
  token: RadiusToken;
  /** All four corners unless the rule rounds only some, as a row's end cells do. */
  corners?: Corner[];
}

/* What must be rounded, and with which token — the pills and cards a person
 * would notice going square. Each is a rule in src/styles that resolves to
 * the token on fixture markup with nothing more specific overriding it, so a
 * miss is the rule (or the fixture) and not the cascade. The full-radius
 * pills are here for the regression the spec names: a 999px pill that lost
 * its radius is a square with the same colours, invisible to every other
 * check. The differential sweep in `geometry` covers everything else. */
const RADIUS_ANCHORS: RadiusAnchor[] = [
  { selector: ".topic-list-item > td:first-child", token: "md", corners: ["top-left", "bottom-left"] },
  { selector: ".topic-list-item > td:last-child", token: "md", corners: ["top-right", "bottom-right"] },
  { selector: ".topic-post > article.boxed", token: "md" },
  // A pre under a deprecation note squares its top corners to join the note
  // (code.css, `.dfp-code-note + pre`); the fixture has one of each.
  { selector: ".cooked pre:not(.dfp-code-note + pre)", token: "md" },
  { selector: ".cooked code:not(pre code)", token: "xs" },
  { selector: ".cooked blockquote", token: "sm", corners: ["top-right", "bottom-right"] },
  { selector: ".dfp-topic-preview", token: "md" },
  { selector: ".dfp-topic-card__badge", token: "sm" },
  { selector: ".dfp-asset-preview", token: "md" },
  { selector: ".topic-timeline .btn", token: "sm" },
  { selector: "button.btn-primary", token: "sm" },
  { selector: 'input[type="text"]', token: "sm" },
  { selector: ".alert", token: "md" },
  { selector: ".discourse-tag", token: "full" },
  { selector: ".badge-notification", token: "full" },
];

/* Findings per combination past this many are counted, not listed: a token
 * that stopped resolving fails every box at once, and the first dozen say it. */
const MAX_GEOMETRY_LINES = 12;

// ── In-page helpers ─────────────────────────────────────────────────────────
//
// Everything from here to the driver is serialised and run inside the page,
// so it must be self-contained: no imports, no closure over module state. The
// colour maths comes from `globalThis.__dfpColor` and the helpers below from
// `globalThis.__dfpPage`, both installed by init scripts (harness-color.ts
// says why the factory shape); anything a pass wants to report comes back as
// plain data.

function pageTools() {
  /**
   * `tag#id.class` for the element and up to three ancestors, stopping at the
   * fixture root. The element itself keeps its whole class list: the class a
   * reader greps for was the fourth on the composer's mini-toggles
   * (`.btn.no-text.btn-icon.btn-transparent`) and the first report cut it, so
   * the line named a button the fixture has no such rule for. Ancestors keep
   * three, dfp- classes first — they are context, not the subject.
   */
  const describe = (el: Element, scope: Element): string => {
    const parts: string[] = [];
    let depth = 0;
    for (let e: Element | null = el; e && e !== scope && e !== document.body && depth < 4; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) s += `#${e.id}`;
      const classes = Array.from(e.classList).filter((c) => c !== "ember-view");
      classes.sort((a, b) => Number(b.startsWith("dfp-")) - Number(a.startsWith("dfp-")));
      s += (depth === 0 ? classes : classes.slice(0, 3)).map((c) => `.${c}`).join("");
      parts.unshift(s);
      depth++;
    }
    return parts.join(" > ");
  };

  return { describe };
}

type PageTools = ReturnType<typeof pageTools>;

// ── In-page audit ───────────────────────────────────────────────────────────

interface AuditOptions {
  failBelow: number;
  warnBelow: number;
}

interface Finding {
  level: "fail" | "warn";
  ratio: number;
  fg: string;
  bg: string;
  text: string;
  path: string;
  count: number;
}

interface Report {
  /** Runs of text that were graded. */
  runs: number;
  /**
   * Graded runs per fixture block, keyed by the block's label, every block
   * present even at 0 — the driver's presence floor reads the zeros.
   */
  runsByBlock: Record<string, number>;
  /** Runs skipped as invisible: hidden, clipped away, opacity ~0, or disabled. */
  hidden: number;
  /** Runs over a bitmap, which have no single colour behind them. */
  indeterminate: number;
  /** Computed colour strings the colour tools could not read — coverage silently lost. */
  unparsed: string[];
  findings: Finding[];
  overflow: null | { scrollWidth: number; clientWidth: number; culprits: string[] };
}

function audit(opts: AuditOptions): Report {
  const g = globalThis as unknown as { __dfpColor?: ColorTools; __dfpPage?: PageTools };
  if (!g.__dfpColor || !g.__dfpPage) throw new Error("the page tools were not installed in the page");
  const { WHITE, CLEAR, unparsed, parseColor, over, fade, contrast, hex, imageColors } = g.__dfpColor;
  unparsed.length = 0;

  // Coordinates below are viewport-relative; pinning the scroll makes them
  // document-relative, which is what the off-page tests assume.
  window.scrollTo(0, 0);

  const scope = document.querySelector<HTMLElement>(".page") ?? document.body;
  const describe = (el: Element): string => g.__dfpPage!.describe(el, scope);

  interface Pair {
    fg: Rgba;
    bg: Rgba;
  }

  /**
   * Walks from a run of text up to the page, painting its colour and the
   * accumulated background over each layer's own background and fading both
   * by the layer's opacity, until the background is opaque. A gradient forks
   * the walk once per stop, so the worst stop is what gets graded; the fork
   * count is capped because a gradient inside a gradient is a corner nobody
   * needs graded 256 ways. `styles` are layers with no element of their own
   * (a pseudo-element), applied before `from` and its ancestors.
   */
  const composite = (
    fg: Rgba,
    styles: CSSStyleDeclaration[],
    from: Element,
  ): { pairs: Pair[]; indeterminate: boolean; visibility: number } => {
    const layers = [...styles];
    for (let e: Element | null = from; e; e = e.parentElement) layers.push(getComputedStyle(e));

    let pairs: Pair[] = [{ fg, bg: CLEAR }];
    let indeterminate = false;
    let visibility = 1;
    for (const cs of layers) {
      const plain = parseColor(cs.backgroundColor) ?? CLEAR;
      const stops = imageColors(cs.backgroundImage);
      let fills: Rgba[];
      if (stops === null) {
        indeterminate = true;
        fills = [plain];
      } else if (stops.length > 0) {
        // The image paints over the element's own background colour.
        fills = stops.map((s) => over(s, plain));
      } else {
        fills = [plain];
      }
      const o = Number.isFinite(Number(cs.opacity)) ? Number(cs.opacity) : 1;
      visibility *= o;
      const next: Pair[] = [];
      for (const p of pairs) {
        for (const f of fills) next.push({ fg: fade(over(p.fg, f), o), bg: fade(over(p.bg, f), o) });
      }
      pairs = next.slice(0, 16);
      if (pairs.every((p) => p.bg[3] >= 0.999)) return { pairs, indeterminate, visibility };
    }
    // Nothing opaque all the way up: the canvas behind the root is white.
    return {
      pairs: pairs.map((p) => ({ fg: over(p.fg, WHITE), bg: over(p.bg, WHITE) })),
      indeterminate,
      visibility,
    };
  };

  const union = (rects: DOMRect[]): DOMRect => {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of rects) {
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    return new DOMRect(left, top, right - left, bottom - top);
  };

  /**
   * Whether a box has been clipped away: shrunk to under a pixel by an
   * ancestor's overflow, or hidden by the `clip: rect(0 0 0 0)` /
   * `clip-path: inset(50%)` visually-hidden idioms.
   */
  const clippedAway = (box: DOMRect, from: Element): boolean => {
    let { left, top, right, bottom } = box;
    for (let e: Element | null = from; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/^rect\(0px(?:,? 0px){3}\)$/.test(cs.clip) || /inset\(\s*(?:50|100)%/.test(cs.clipPath)) return true;
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const b = e.getBoundingClientRect();
        left = Math.max(left, b.left);
        top = Math.max(top, b.top);
        right = Math.min(right, b.right);
        bottom = Math.min(bottom, b.bottom);
        if (right - left < 1 || bottom - top < 1) return true;
      }
    }
    return false;
  };

  const findings = new Map<string, Finding>();
  let runs = 0;
  let hidden = 0;
  let indeterminate = 0;

  // The fixture's blocks, so a graded run can be credited to the one it sits
  // in. Labelled by the block's own heading; a heading that repeats, or is
  // missing, gets the block's ordinal so no two blocks share a key.
  const blocks = Array.from(scope.querySelectorAll<HTMLElement>("section.harness-block"));
  const runsByBlock: Record<string, number> = {};
  const labelOf = new Map<Element, string>();
  blocks.forEach((block, i) => {
    const heading = block.querySelector(".harness-label")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    let label = heading || `block ${i + 1}`;
    if (label in runsByBlock) label = `${label} (${i + 1})`;
    runsByBlock[label] = 0;
    labelOf.set(block, label);
  });
  const credit = (el: Element): void => {
    const block = el.closest("section.harness-block");
    const label = block ? labelOf.get(block) : undefined;
    if (label !== undefined) runsByBlock[label]!++;
  };

  const grade = (
    fill: Rgba,
    styles: CSSStyleDeclaration[],
    el: Element,
    text: string,
    path: string,
    fontSize: number,
    fontWeight: number,
  ): void => {
    const r = composite(fill, styles, el);
    if (r.visibility < 0.02) {
      hidden++;
      return;
    }
    if (r.indeterminate) {
      indeterminate++;
      return;
    }
    runs++;
    credit(el);
    let worst = Infinity;
    let worstPair = r.pairs[0]!;
    for (const p of r.pairs) {
      const c = contrast(p.fg, p.bg);
      if (c < worst) {
        worst = c;
        worstPair = p;
      }
    }
    // WCAG's "large": 18pt, or 14pt bold, in CSS pixels.
    const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    const level: Finding["level"] | null =
      worst < opts.failBelow ? "fail" : !large && worst < opts.warnBelow ? "warn" : null;
    if (!level) return;
    const key = `${level}|${path}|${hex(worstPair.fg)}|${hex(worstPair.bg)}`;
    const seen = findings.get(key);
    if (seen) {
      seen.count++;
      seen.ratio = Math.min(seen.ratio, worst);
    } else {
      findings.set(key, {
        level,
        ratio: worst,
        fg: hex(worstPair.fg),
        bg: hex(worstPair.bg),
        text: text.replace(/\s+/g, " ").trim().slice(0, 40),
        path,
        count: 1,
      });
    }
  };

  const isExempt = (el: Element): boolean => el.closest(":disabled, [aria-disabled='true']") !== null;
  // SVG text is icon glyphs and <title> tooltips here, neither of which is read
  // off the page; script/style/template children are never rendered.
  const skipTag = (el: Element): boolean =>
    /^(script|style|template|noscript|title)$/i.test(el.tagName) || el.closest("svg") !== null;
  const weightOf = (cs: CSSStyleDeclaration): number => parseInt(cs.fontWeight, 10) || 400;

  // ── Text nodes ──
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    if (!text.trim()) continue;
    const el = node.parentElement;
    if (!el || skipTag(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== "visible") {
      hidden++;
      continue;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) continue; // display: none above it, or font-size 0
    const box = union(rects);
    if (box.right <= 0 || box.bottom <= 0 || clippedAway(box, el) || isExempt(el)) {
      hidden++;
      continue;
    }
    const fill = parseColor(cs.webkitTextFillColor || cs.color) ?? parseColor(cs.color);
    if (!fill) continue; // recorded in `unparsed`
    if (fill[3] === 0) {
      hidden++; // transparent ink: invisible by design, or gradient text with no one colour
      continue;
    }
    grade(fill, [], el, text, describe(el), parseFloat(cs.fontSize), weightOf(cs));
  }

  // ── ::before / ::after with textual content ──
  // `content` computes to quoted strings, or to counter()/attr() forms that
  // resolve to text at paint time. `content: ""` is an icon box, not text.
  for (const el of scope.querySelectorAll("*")) {
    if (skipTag(el)) continue;
    for (const pseudo of ["::before", "::after"] as const) {
      const cs = getComputedStyle(el, pseudo);
      const content = cs.content;
      if (content === "none" || content === "normal" || cs.display === "none") continue;
      const quoted =
        content
          .match(/"(?:[^"\\]|\\.)*"/g)
          ?.map((s) => s.slice(1, -1))
          .join("") ?? "";
      const text = quoted.trim() ? quoted : /\b(?:attr|counters?)\(/.test(content) ? content : "";
      if (!text.trim()) continue;
      if (cs.visibility !== "visible" || parseFloat(cs.fontSize) <= 0) continue;
      const rects = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (rects.length === 0) continue;
      if (clippedAway(union(rects), el) || isExempt(el)) {
        hidden++;
        continue;
      }
      const fill = parseColor(cs.webkitTextFillColor || cs.color) ?? parseColor(cs.color);
      if (!fill) continue;
      if (fill[3] === 0) {
        hidden++;
        continue;
      }
      grade(fill, [cs], el, text, describe(el) + pseudo, parseFloat(cs.fontSize), weightOf(cs));
    }
  }

  // ── Form controls: the value or placeholder is text with no text node ──
  for (const el of scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input, textarea, select",
  )) {
    if (el instanceof HTMLInputElement && /^(hidden|checkbox|radio|range|color|file|image)$/.test(el.type)) {
      continue;
    }
    const cs = getComputedStyle(el);
    if (cs.visibility !== "visible") continue;
    const rects = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) continue;
    if (clippedAway(union(rects), el) || isExempt(el)) {
      hidden++;
      continue;
    }
    let text: string;
    let fill: Rgba | null;
    if (el instanceof HTMLSelectElement) {
      text = el.selectedOptions[0]?.label ?? "";
      fill = parseColor(cs.color);
    } else if (el.value) {
      text = el.value;
      fill = parseColor(cs.color);
    } else if (el.placeholder) {
      text = el.placeholder;
      fill = parseColor(getComputedStyle(el, "::placeholder").color);
    } else {
      continue;
    }
    if (!text.trim() || !fill || fill[3] === 0) continue;
    grade(fill, [], el, text, describe(el), parseFloat(cs.fontSize), weightOf(cs));
  }

  // ── Horizontal overflow ──
  // Measured on the whole document, toolbar included: a scrollbar is a
  // scrollbar whichever part of the page earned it. The culprits named are the
  // outermost boxes past the edge that no scrolling ancestor contains.
  const de = document.documentElement;
  const clientWidth = de.clientWidth;
  const scrollWidth = Math.max(de.scrollWidth, document.body.scrollWidth);
  let overflow: Report["overflow"] = null;
  if (scrollWidth > clientWidth) {
    const edge = clientWidth + 0.5;
    const contained = (el: Element): boolean => {
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        if (getComputedStyle(e).overflowX !== "visible" && e.getBoundingClientRect().right <= edge) return true;
      }
      return false;
    };
    const spilling = new Set<Element>();
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > edge && !contained(el)) spilling.add(el);
    }
    const culprits = [...spilling]
      .filter((el) => !(el.parentElement && spilling.has(el.parentElement)))
      .slice(0, 6)
      .map((el) => `${describe(el)} (right edge at ${Math.round(el.getBoundingClientRect().right)}px)`);
    overflow = { scrollWidth, clientWidth, culprits };
  }

  return {
    runs,
    runsByBlock,
    hidden,
    indeterminate,
    unparsed: [...unparsed],
    findings: [...findings.values()],
    overflow,
  };
}

// ── In-page geometry ────────────────────────────────────────────────────────

interface GeometryOptions {
  tokenNames: readonly RadiusToken[];
  anchors: RadiusAnchor[];
  /**
   * `corners` from the default-radius render of the same theme, density,
   * width and flags, or null when this is that render. The DOM is the same
   * document throughout — the toolbar only sets attributes on <html> — so
   * boxes line up by index.
   */
  baseline: string[] | null;
}

interface GeometryReport {
  /** The token lengths read off <html>, e.g. `6px`, keyed by token. */
  tokens: Record<RadiusToken, string>;
  /**
   * One entry per box under the fixture (elements, then any ::before/::after
   * with content), the four corners classified: a token name where the corner
   * equals that token's length, else the raw computed value.
   */
  corners: string[];
  /** Anchor corners compared, on rendered matches only. */
  anchored: number;
  /** Boxes compared against the baseline; 0 on a default-radius render. */
  compared: number;
  problems: string[];
}

function geometry(opts: GeometryOptions): GeometryReport {
  const g = globalThis as unknown as { __dfpPage?: PageTools };
  if (!g.__dfpPage) throw new Error("the page tools were not installed in the page");
  const scope = document.querySelector<HTMLElement>(".page") ?? document.body;
  const describe = (el: Element): string => g.__dfpPage!.describe(el, scope);

  const rootStyle = getComputedStyle(document.documentElement);
  const tokens = {} as Record<RadiusToken, string>;
  for (const t of opts.tokenNames) tokens[t] = rootStyle.getPropertyValue(`--dfp-r-${t}`).trim();
  const classify = (raw: string): string => opts.tokenNames.find((t) => tokens[t] === raw) ?? raw;

  const corners: Corner[] = ["top-left", "top-right", "bottom-right", "bottom-left"];
  const radiusOf = (cs: CSSStyleDeclaration, corner: Corner): string => cs.getPropertyValue(`border-${corner}-radius`);
  const problems: string[] = [];

  // ── Anchors: what must be rounded, with which token ──
  // Only matches with a box are graded: getComputedStyle reports a radius on
  // a display: none element too, so an anchor hidden by a rule (or a hidden
  // fixture) would otherwise pass. One match may legitimately have no box —
  // the flags render folds a quiet post's <article> — so the failure is an
  // anchor NONE of whose matches is rendered, the same failure as matching
  // nothing.
  let anchored = 0;
  for (const a of opts.anchors) {
    const matched = scope.querySelectorAll(a.selector);
    if (matched.length === 0) {
      problems.push(`nothing under the fixture matches "${a.selector}"; RADIUS_ANCHORS in scripts/check-harness.ts is stale`);
      continue;
    }
    const els = Array.from(matched).filter((el) => el.getClientRects().length > 0);
    if (els.length === 0) {
      problems.push(
        `"${a.selector}" matches ${matched.length} element(s) under the fixture but none is rendered; ` +
          `an anchor with no box cannot be checked for its radius`,
      );
      continue;
    }
    for (const el of els) {
      const cs = getComputedStyle(el);
      for (const corner of a.corners ?? corners) {
        anchored++;
        const got = radiusOf(cs, corner);
        if (got !== tokens[a.token]) {
          problems.push(
            `${describe(el)}: ${corner} radius is ${got}, expected the ${a.token} token (${tokens[a.token] || "unset"}) — "${a.selector}"`,
          );
        }
      }
    }
  }

  // ── Every box, classified, and compared with the default-radius render ──
  const boxes: { el: Element; pseudo: "" | "::before" | "::after"; raw: string[] }[] = [];
  for (const el of scope.querySelectorAll("*")) {
    if (/^(script|style|template|noscript|title)$/i.test(el.tagName) || el.closest("svg") !== null) continue;
    boxes.push({ el, pseudo: "", raw: corners.map((c) => radiusOf(getComputedStyle(el), c)) });
    for (const pseudo of ["::before", "::after"] as const) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content === "none" || cs.content === "normal") continue;
      boxes.push({ el, pseudo, raw: corners.map((c) => radiusOf(cs, c)) });
    }
  }
  const classified = boxes.map((b) => b.raw.map(classify).join(" "));

  let compared = 0;
  if (opts.baseline) {
    if (opts.baseline.length !== classified.length) {
      problems.push(
        `the fixture has ${classified.length} boxes on this render and had ${opts.baseline.length} on the ` +
          `default-radius render of the same layout, so the two cannot be compared corner by corner`,
      );
    } else {
      for (let i = 0; i < classified.length; i++) {
        const was = opts.baseline[i]!.split(" ");
        const now = classified[i]!.split(" ");
        let counted = false;
        for (let k = 0; k < corners.length; k++) {
          const token = was[k] as RadiusToken;
          // Not a token's length at the default radius: a literal, a
          // percentage, a calc() — nothing the variant is expected to move.
          if (!opts.tokenNames.includes(token)) continue;
          if (!counted) {
            compared++;
            counted = true;
          }
          if (now[k] !== token) {
            const { el, pseudo, raw } = boxes[i]!;
            problems.push(
              `${describe(el)}${pseudo}: ${corners[k]} radius is ${raw[k]} here but was the ${token} token at the ` +
                `default radius; here ${token} is ${tokens[token]}. A hard-coded length where the token should be?`,
            );
          }
        }
      }
    }
  }

  return { tokens, corners: classified, anchored, compared, problems };
}

// ── Driver ──────────────────────────────────────────────────────────────────

interface Combo {
  label: string;
  theme: string;
  density: string;
  /** The toolbar's data-dfp-radius value; the harness default except on the radius renders. */
  radius: string;
  width: number;
  /** Emulated prefers-color-scheme; only `off` follows it. */
  colorScheme: "light" | "dark";
  /** Root flags to turn on; every other toolbar flag is turned off. */
  flags: string[];
  file: string;
}

/** Everything but the radius: the renders a radius render is compared against. */
const layoutOf = (c: Combo): string => [c.theme, c.density, c.width, c.colorScheme, c.flags.join("+")].join("|");

const firstLine = (e: unknown): string => String(e instanceof Error ? e.message : e).split("\n")[0] ?? "";

async function launch(): Promise<{ browser: Browser; via: string }> {
  const explicit = process.env["DFP_BROWSER"];
  if (explicit) {
    return { browser: await chromium.launch({ executablePath: explicit, headless: true }), via: explicit };
  }
  const tried: string[] = [];
  for (const channel of CHANNELS) {
    try {
      return { browser: await chromium.launch({ channel, headless: true }), via: `channel "${channel}"` };
    } catch (e) {
      tried.push(`${channel}: ${firstLine(e)}`);
    }
  }
  throw new Error(
    `no Chromium to render with.\n         ${tried.join("\n         ")}\n` +
      `         Install Chrome or Edge, or set DFP_BROWSER=<path to a Chromium binary>.`,
  );
}

/** Drives the toolbar exactly as a person would, and checks it did what it says. */
async function select(page: Page, attr: string, val: string): Promise<void> {
  await page.click(`.toolbar button[data-attr="${attr}"][data-val="${val}"]`);
  const applied = await page.evaluate(
    ([a, v]) => document.documentElement.getAttribute(a) === v,
    [attr, val] as const,
  );
  if (!applied) {
    throw new Error(
      `clicking the toolbar button for ${attr}="${val}" did not set it on <html>; ` +
        `the toolbar contract in scripts/build-harness.ts changed.`,
    );
  }
}

async function setFlag(page: Page, attr: string, on: boolean): Promise<void> {
  const has = await page.evaluate((a) => document.documentElement.hasAttribute(a), attr);
  if (has === on) return;
  await page.click(`.toolbar button[data-flag="${attr}"]`);
  const now = await page.evaluate((a) => document.documentElement.hasAttribute(a), attr);
  if (now !== on) {
    throw new Error(
      `clicking the toolbar flag ${attr} did not toggle it on <html>; ` +
        `the toolbar contract in scripts/build-harness.ts changed.`,
    );
  }
}

/**
 * Renders the whole page once so every post's style is current, waits out the
 * transitions the switch started, and puts the viewport back.
 *
 * The viewport grows because of perf.css: `content-visibility: auto` on the
 * post stream, and Chromium does not carry a changed inherited custom property
 * into a skipped subtree on demand. After a theme switch, getComputedStyle on
 * a name link three posts down kept returning the PREVIOUS theme's text colour
 * — rgb(33,35,39), light's, on dim's background — through a forced style pass
 * over every element, a forced layout and a wait; the first combination after
 * each switch failed on those posts and the rest of the theme did not. Two
 * alternatives were measured against this one: resolving every element's
 * style by hand refreshed the first switch only, and scrolling the page past
 * the viewport started each post's transitions and then froze them mid-flight
 * the moment the post was skipped again (rgb(78,80,84), between the two
 * themes). A viewport as tall as the document renders every post for real, so
 * the transitions start, run and finish; the height goes back before anything
 * is graded, so `vh` and the screenshot see the real window.
 *
 * The height is read twice. Before the grow, scrollHeight includes the
 * skipped posts at perf.css's `contain-intrinsic-size` estimate (180 px), not
 * at their real height; once they render, the document can be taller than the
 * viewport that was sized for it, and the tail would stay skipped on the old
 * theme — the exact flake this exists for. It did not reproduce (4999 and
 * 5175 px measured, and Chromium's relevance margin around the viewport
 * covered the difference), so the second read is insurance: grow once more
 * if the rendered document turned out taller, still under the cap.
 *
 * The wait looks at playState rather than at whether a transition is still
 * listed: a finished transition leaves document.getAnimations() at the next
 * style recalc, which a skipped post never gets, and on the first attempt the
 * wait timed out on transitions sitting `finished` at currentTime 4016 ms of a
 * 120 ms duration. Finished is settled; the computed value is the target's.
 *
 * Keyframe animations are jumped to their end rather than waited out. The
 * fixture carries transient states by hand — the `.dfp-dep--flash` wash on a
 * mark a chip just scrolled to runs 1.4 s from load with fill-mode `both` —
 * and the first combination is graded within that window while every later
 * one, a toolbar click on the same page, sees the finished frame. Measured:
 * dark-comfortable-1280 alone read the flashed mark at 2.35:1 (#cb7878 on the
 * mid-wash #605050) and the other 41 combinations read it on the bare code
 * background. What is graded here is the resting page, the one the
 * `animations: "disabled"` screenshots show, so a finite animation is
 * finished before the read; an infinite one cannot be (finish() throws) and
 * is left alone, as it was.
 */
async function settle(page: Page, width: number): Promise<void> {
  const twoFrames = () =>
    page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const docHeight = () => page.evaluate(() => document.documentElement.scrollHeight);
  const estimated = Math.min(await docHeight(), MAX_SETTLE_HEIGHT);
  await page.setViewportSize({ width, height: estimated });
  await twoFrames();
  const rendered = Math.min(await docHeight(), MAX_SETTLE_HEIGHT);
  if (rendered > estimated) {
    await page.setViewportSize({ width, height: rendered });
    await twoFrames();
  }
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (!(a instanceof CSSAnimation)) continue;
      try {
        a.finish();
      } catch {
        // Infinite iterations: no end to jump to.
      }
    }
  });
  await page.waitForFunction(
    () => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== "running"),
    undefined,
    { timeout: SETTLE_TIMEOUT_MS },
  );
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await twoFrames();
}

async function main(): Promise<void> {
  const started = Date.now();
  if (!existsSync(harnessPath)) {
    console.error(`  FAIL ${relative(root, harnessPath)} not found.\n         Run: npm run harness`);
    process.exit(1);
  }

  // The directory is exactly this run's output, so a combination that
  // disappears does not leave a stale screenshot for the artifact to upload.
  mkdirSync(shotsDir, { recursive: true });
  for (const f of readdirSync(shotsDir)) if (f.endsWith(".png")) unlinkSync(resolve(shotsDir, f));

  const { browser, via } = await launch();
  const errors: string[] = [];
  try {
    const context = await browser.newContext({
      viewport: { width: WIDTHS[0], height: VIEWPORT_HEIGHT },
      deviceScaleFactor: 1,
    });
    await context.addInitScript("globalThis.__name ??= (fn) => fn;");
    await context.addInitScript(`globalThis.__dfpColor = (${colorTools.toString()})();`);
    await context.addInitScript(`globalThis.__dfpPage = (${pageTools.toString()})();`);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`the harness page threw: ${firstLine(e)}`));

    await page.goto(pathToFileURL(harnessPath).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    const toolbar = await page.evaluate(() => {
      const values = (attr: string) =>
        Array.from(document.querySelectorAll<HTMLElement>(`.toolbar button[data-attr="${attr}"]`)).map(
          (b) => b.dataset["val"] ?? "",
        );
      const root = document.documentElement;
      return {
        themes: values("data-dfp-theme"),
        densities: values("data-dfp-density"),
        radii: values("data-dfp-radius"),
        flags: Array.from(document.querySelectorAll<HTMLElement>(".toolbar button[data-flag]")).map(
          (b) => b.dataset["flag"] ?? "",
        ),
        defaultTheme: root.getAttribute("data-dfp-theme") ?? "",
        defaultDensity: root.getAttribute("data-dfp-density") ?? "",
        defaultRadius: root.getAttribute("data-dfp-radius") ?? "",
      };
    });
    if (toolbar.themes.length === 0 || toolbar.densities.length === 0 || toolbar.radii.length === 0) {
      throw new Error(
        "the harness toolbar has no theme, density or radius buttons; " +
          "the data-attr/data-val contract in scripts/build-harness.ts changed.",
      );
    }
    if (!toolbar.radii.includes(toolbar.defaultRadius)) {
      throw new Error(
        `<html> starts at data-dfp-radius="${toolbar.defaultRadius}", which is not a toolbar button ` +
          `(${toolbar.radii.join(", ")}); the radius renders would have nothing to compare against.`,
      );
    }

    const combos: Combo[] = [];
    const base = { radius: toolbar.defaultRadius, colorScheme: "light" as const, flags: [] as string[] };
    const add = (c: Omit<Combo, "file">) => combos.push({ ...c, file: `${c.label.replace(/[^a-z0-9-]+/gi, "-")}.png` });
    for (const theme of toolbar.themes) {
      for (const density of toolbar.densities) {
        for (const width of WIDTHS) add({ ...base, label: `${theme}-${density}-${width}`, theme, density, width });
      }
    }
    if (toolbar.themes.includes("off")) {
      for (const density of toolbar.densities) {
        for (const width of WIDTHS) {
          add({ ...base, label: `off-osdark-${density}-${width}`, theme: "off", density, width, colorScheme: "dark" });
        }
      }
    }
    if (toolbar.flags.length > 0) {
      for (const width of WIDTHS) {
        add({
          ...base,
          label: `${toolbar.defaultTheme}-${toolbar.defaultDensity}-${width}-flags`,
          theme: toolbar.defaultTheme,
          density: toolbar.defaultDensity,
          width,
          flags: toolbar.flags,
        });
      }
    }
    // After the default-radius renders, whose `corners` these are compared with.
    for (const radius of toolbar.radii) {
      if (radius === toolbar.defaultRadius) continue;
      for (const width of WIDTHS) {
        add({
          ...base,
          label: `${toolbar.defaultTheme}-${toolbar.defaultDensity}-${width}-${radius}`,
          theme: toolbar.defaultTheme,
          density: toolbar.defaultDensity,
          width,
          radius,
        });
      }
    }

    console.log(`check:harness: rendering ${combos.length} combinations with ${via}`);

    // Aggregated across combinations: the same run fails the same way in every
    // density, and 30 copies of one line hide the second finding.
    const fails = new Map<string, { f: Finding; combos: string[]; file: string }>();
    const warns = new Map<string, { f: Finding; combos: string[] }>();
    /** `corners` from each default-radius render, by layout. */
    const baselines = new Map<string, string[]>();
    /** The xs/sm/md/lg lengths each radius resolved to, to prove the variants differ. */
    const tokensByRadius = new Map<string, string>();

    for (const combo of combos) {
      await page.setViewportSize({ width: combo.width, height: VIEWPORT_HEIGHT });
      await page.emulateMedia({ colorScheme: combo.colorScheme });
      await select(page, "data-dfp-theme", combo.theme);
      await select(page, "data-dfp-density", combo.density);
      await select(page, "data-dfp-radius", combo.radius);
      for (const flag of toolbar.flags) await setFlag(page, flag, combo.flags.includes(flag));
      await settle(page, combo.width);

      const report = await page.evaluate(audit, { failBelow: FAIL_BELOW, warnBelow: WARN_BELOW });

      const isDefaultRadius = combo.radius === toolbar.defaultRadius;
      const geo = await page.evaluate(geometry, {
        tokenNames: RADIUS_TOKENS,
        anchors: RADIUS_ANCHORS,
        baseline: isDefaultRadius ? null : (baselines.get(layoutOf(combo)) ?? null),
      });
      if (isDefaultRadius) baselines.set(layoutOf(combo), geo.corners);
      else if (!baselines.has(layoutOf(combo))) {
        errors.push(`${combo.label}: no default-radius render of the same layout came before it to compare with`);
      }

      const shot = resolve(shotsDir, combo.file);
      await page.screenshot({ path: shot, fullPage: true, animations: "disabled" });
      if (!existsSync(shot)) errors.push(`${combo.label}: no screenshot was written to ${relative(root, shot)}`);

      // The variant's four lengths: distinct px values, and the same whatever
      // the theme or density — radius is not theirs to change.
      const quartet = RADIUS_TOKENS.filter((t) => t !== "full").map((t) => geo.tokens[t]);
      if (quartet.some((v) => !/^\d+(?:\.\d+)?px$/.test(v)) || new Set(quartet).size !== quartet.length) {
        errors.push(
          `${combo.label}: the radius tokens on <html> are ${quartet.map((v) => v || "unset").join(", ")}; ` +
            `tokens.css declares four distinct px lengths for "${combo.radius}".`,
        );
      }
      const known = tokensByRadius.get(combo.radius);
      if (known === undefined) tokensByRadius.set(combo.radius, quartet.join(" "));
      else if (known !== quartet.join(" ")) {
        errors.push(
          `${combo.label}: radius "${combo.radius}" resolved to ${quartet.join(" ")} here and ${known} in an ` +
            `earlier render; a theme or density rule is redefining the radius tokens.`,
        );
      }
      for (const p of geo.problems.slice(0, MAX_GEOMETRY_LINES)) errors.push(`${combo.label}: ${p}`);
      if (geo.problems.length > MAX_GEOMETRY_LINES) {
        errors.push(`${combo.label}: … +${geo.problems.length - MAX_GEOMETRY_LINES} more radius problems`);
      }

      let nFail = 0;
      let nWarn = 0;
      for (const f of report.findings) {
        const key = `${f.path}|${f.fg}|${f.bg}`;
        if (f.level === "fail") {
          nFail++;
          const seen = fails.get(key);
          if (seen) {
            seen.combos.push(combo.label);
            seen.f.ratio = Math.min(seen.f.ratio, f.ratio);
          } else fails.set(key, { f, combos: [combo.label], file: combo.file });
        } else {
          nWarn++;
          const seen = warns.get(key);
          if (seen) {
            seen.combos.push(combo.label);
            seen.f.ratio = Math.min(seen.f.ratio, f.ratio);
          } else warns.set(key, { f, combos: [combo.label] });
        }
      }
      for (const raw of report.unparsed) {
        errors.push(
          `${combo.label}: a computed colour the audit cannot read, "${raw}" — ` +
            `extend parseColor in scripts/harness-color.ts, or the runs using it go ungraded.`,
        );
      }

      // ── Presence: the grading has to have happened ──
      // A render that graded nothing, or a fixture block that graded nothing,
      // is a hidden fixture, not a clean one. One line per render when the
      // whole page is gone (the per-block lines would say the same five
      // times), one per block otherwise.
      const blockLabels = Object.keys(report.runsByBlock);
      const emptyBlocks = blockLabels.filter((label) => report.runsByBlock[label] === 0);
      const presence: string[] = [];
      if (blockLabels.length === 0) {
        presence.push(
          `no section.harness-block under the fixture; the per-block presence floor has nothing to stand on ` +
            `(tests/visual/fixture.html wraps each block in one)`,
        );
      }
      if (report.runs === 0) {
        presence.push(
          `the audit graded no text at all (${report.hidden} runs counted as hidden, the rest left no box to ` +
            `count); the fixture did not render, so nothing on this row was checked`,
        );
      } else {
        for (const label of emptyBlocks) {
          presence.push(`the "${label}" block graded no text; a rule is hiding the whole block`);
        }
      }
      for (const p of presence) errors.push(`${combo.label}: ${p}\n         See ${relative(root, shot)}.`);
      if (report.overflow) {
        errors.push(
          `${combo.label}: the document scrolls horizontally, ${report.overflow.scrollWidth}px of content ` +
            `in a ${report.overflow.clientWidth}px viewport.\n` +
            report.overflow.culprits.map((c) => `           ${c}`).join("\n") +
            `\n         See ${relative(root, shot)}.`,
        );
      }

      const status = nFail > 0 || report.overflow || geo.problems.length > 0 || presence.length > 0 ? "FAIL" : " ok ";
      const extra = [
        // How much was skipped as invisible is part of the answer: a rule that
        // hides half the fixture would otherwise show up as a cleaner pass.
        report.hidden > 0 ? `${report.hidden} hidden` : "",
        emptyBlocks.length > 0 ? `${emptyBlocks.length}/${blockLabels.length} blocks empty` : "",
        report.indeterminate > 0 ? `${report.indeterminate} over bitmaps` : "",
        report.overflow ? `overflows ${report.overflow.scrollWidth}/${report.overflow.clientWidth}px` : "",
        geo.problems.length > 0 ? `${geo.problems.length} radius` : "",
        geo.compared > 0 ? `${geo.compared} boxes moved with ${combo.radius}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      console.log(
        `  ${status} ${combo.label.padEnd(34)} ${String(report.runs).padStart(4)} runs ` +
          `${String(nFail).padStart(3)} <${FAIL_BELOW}:1 ${String(nWarn).padStart(3)} <${WARN_BELOW}:1` +
          (extra ? `   ${extra}` : ""),
      );
    }

    const where = (list: string[]) => (list.length > 1 ? `${list[0]} +${list.length - 1} more` : list[0] ?? "");

    // A radius variant that resolves the tokens to another variant's lengths
    // is a button that does nothing, and its screenshots would show `soft`.
    const byLengths = new Map<string, string>();
    for (const [radius, lengths] of tokensByRadius) {
      const other = byLengths.get(lengths);
      if (other !== undefined) {
        errors.push(
          `radius "${radius}" resolves the tokens to the same lengths as "${other}" (${lengths}); ` +
            `either the toolbar button or the tokens.css variant is not taking effect.`,
        );
      }
      byLengths.set(lengths, radius);
    }

    // ── The 4.5:1 ratchet ──
    const fired = [...warns.keys()].sort();
    const ratchetRel = relative(root, ratchetPath);
    let listed: Set<string> | null = null;
    if (existsSync(ratchetPath)) {
      listed = new Set(JSON.parse(readFileSync(ratchetPath, "utf8")) as string[]);
    } else if (process.env["CI"]) {
      // Bootstrapping on the runner would accept whatever fires today as the
      // baseline, on every run, and the ratchet would enforce nothing while
      // ci.yml says it does. The file is born locally and committed.
      errors.push(
        `${ratchetRel} is not in the checkout, so the ${WARN_BELOW}:1 ratchet has no baseline. ` +
          `Run \`npm run harness && npm run check:harness\` locally, review the keys it writes, and commit the file.`,
      );
    } else {
      writeFileSync(ratchetPath, JSON.stringify(fired, null, 2) + "\n", "utf8");
      console.log(
        `\ncheck:harness: wrote ${ratchetRel} with ${fired.length} pre-existing run(s) under ${WARN_BELOW}:1. ` +
          `Shrink it, do not grow it.`,
      );
    }
    const regressions = listed ? fired.filter((k) => !listed.has(k)) : [];
    const paid = listed ? [...listed].filter((k) => !warns.has(k)).sort() : [];

    if (warns.size > 0) {
      const sorted = [...warns.entries()].sort((a, b) => a[1].f.ratio - b[1].f.ratio);
      console.log(
        `\n  ${warns.size} run(s) under ${WARN_BELOW}:1 (${FAIL_BELOW}:1 is the floor; ` +
          `${regressions.length} not in ${ratchetRel}):`,
      );
      for (const [key, { f, combos: c }] of sorted.slice(0, 30)) {
        const mark = listed === null ? "warn " : listed.has(key) ? "known" : "NEW  ";
        console.log(
          `  ${mark} ${f.ratio.toFixed(2).padStart(5)}:1  ${f.fg} on ${f.bg}  "${f.text}"  ${f.path}  [${where(c)}]`,
        );
      }
      if (sorted.length > 30) console.log(`  … +${sorted.length - 30} more`);
    }
    if (regressions.length > 0) {
      errors.push(
        `${regressions.length} run(s) of body text under ${WARN_BELOW}:1 that ${ratchetRel} does not list ` +
          `(marked NEW above). Fix the colour, or accept it by adding the key with a reason in the commit:\n` +
          regressions.map((k) => `           ${JSON.stringify(k)}`).join("\n"),
      );
    }
    if (paid.length > 0) {
      // Not an error, as in check-styles.ts — but the file must shrink when
      // the debt is paid, or it stops meaning anything.
      console.log(
        `\n  ${paid.length} listed run(s) no longer fire and can be removed from ${ratchetRel}:\n` +
          paid.map((k) => `  ${k}`).join("\n"),
      );
    }

    for (const { f, combos: c, file } of [...fails.values()].sort((a, b) => a.f.ratio - b.f.ratio)) {
      errors.push(
        `${f.ratio.toFixed(2)}:1  ${f.fg} on ${f.bg}  "${f.text}"\n` +
          `         ${f.path}\n` +
          `         in ${where(c)}${f.count > 1 ? `, ${f.count} runs` : ""}; see .output/harness-shots/${file}`,
      );
    }
  } finally {
    await browser.close();
  }

  if (errors.length > 0) {
    console.log("");
    for (const e of errors) console.error(`  FAIL ${e}`);
    process.exit(1);
  }

  console.log(
    `check:harness: ok — every fixture block rendered on every combination, every run of text at or above ` +
      `${FAIL_BELOW}:1, no run under ${WARN_BELOW}:1 outside the ratchet, no horizontal overflow, every corner ` +
      `on its radius token, screenshots in ${relative(root, shotsDir)} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}

main().catch((e: unknown) => {
  console.error(`  FAIL ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
