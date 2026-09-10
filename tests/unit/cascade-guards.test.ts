import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Cascade guards for the list and post stylesheets, checked against the
 * Discourse selectors they have to beat.
 *
 * The bug this exists for: the j/k cursor rule for list rows was written at
 * (0,3,2), which is exactly the weight of Discourse's own
 * `.topic-list tr.selected td:first-of-type` bar. DFP's sheet is injected
 * through the manifest and Blink orders injected sheets before the document's
 * own, so at a tie the page wins — the stock 3px bar kept painting on top of
 * the new outline, and nothing said so because a specificity tie is invisible
 * to every check that reads only our own CSS. These assertions read our
 * selectors AND the Discourse ones (quoted from 3.5.0.beta3, the build the
 * fixture was transcribed from) through one specificity calculator, so "ours
 * outranks theirs" is a number rather than a belief.
 *
 * The same file guards the two other shapes found in that review: the list
 * chrome band, which has to land on Discourse's flex ITEMS rather than stack
 * under their container, and the excerpt clamp box, which must never be wider
 * than its cell.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");

// ── Specificity ─────────────────────────────────────────────────────────────
// (ids, classes, elements), per Selectors Level 4: attributes and pseudo-classes
// count as classes, pseudo-elements as elements, `:is()`/`:not()`/`:has()` take
// their heaviest argument and `:where()` takes nothing.

type Spec = [number, number, number];

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function specificity(selector: string): Spec {
  const spec: Spec = [0, 0, 0];
  const s = selector.trim();
  let i = 0;
  const ident = () => {
    const m = /^-?[A-Za-z_][\w-]*/.exec(s.slice(i));
    if (m) i += m[0].length;
    return m?.[0] ?? "";
  };
  const balanced = () => {
    // i sits on "("; returns the text inside and moves past ")".
    let depth = 0;
    const start = i + 1;
    for (; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) break;
    }
    const inner = s.slice(start, i);
    i++;
    return inner;
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "#") {
      i++;
      ident();
      spec[0]++;
    } else if (ch === ".") {
      i++;
      ident();
      spec[1]++;
    } else if (ch === "[") {
      i = s.indexOf("]", i) + 1;
      spec[1]++;
    } else if (ch === ":") {
      const pseudoElement = s[i + 1] === ":";
      i += pseudoElement ? 2 : 1;
      const name = ident().toLowerCase();
      if (s[i] === "(") {
        const inner = balanced();
        if (["is", "not", "has", "matches"].includes(name)) {
          const best = splitTop(inner, ",")
            .map(specificity)
            .sort(compare)
            .at(-1) ?? [0, 0, 0];
          spec[0] += best[0];
          spec[1] += best[1];
          spec[2] += best[2];
        } else if (name !== "where") {
          spec[1]++;
        }
      } else if (pseudoElement) spec[2]++;
      else spec[1]++;
    } else if (/[A-Za-z]/.test(ch)) {
      ident();
      spec[2]++;
    } else {
      i++; // combinators, whitespace, `*`
    }
  }
  return spec;
}

function compare(a: Spec, b: Spec): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
const show = (s: Spec) => `(${s.join(",")})`;
const beats = (ours: string, theirs: string, label: string) => {
  const a = specificity(ours);
  const b = specificity(theirs);
  check(compare(a, b) > 0, `${label}: ${show(a)} beats Discourse's ${show(b)}  ← ${theirs}`);
};

console.log("── calculator self-check ────────────────────────────────────────");
const eqSpec = (sel: string, want: Spec) =>
  check(compare(specificity(sel), want) === 0, `${sel}  →  ${show(specificity(sel))}`);
eqSpec("html[data-dfp] .topic-list-item.selected > td", [0, 3, 2]);
eqSpec(".topic-list tr.selected td:first-of-type", [0, 3, 2]);
eqSpec("html[data-dfp] .topic-post:has(.names .staff) > article.boxed", [0, 5, 2]);
eqSpec("html[data-dfp] .topic-list-item.dfp-stale:where(:not(.dfp-solved)) > td", [0, 3, 2]);
eqSpec("html[data-dfp] :is(.cooked, .d-editor-preview) table th", [0, 2, 3]);
eqSpec("#navigation-bar", [1, 0, 0]);

// ── Rule lookup ─────────────────────────────────────────────────────────────

interface Rule {
  selectors: string[];
  body: string;
  at: number;
}

function rules(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({
      selectors: splitTop(m[1]!, ",").map((x) => x.replace(/\s+/g, " ")),
      body: m[2]!,
      at: m.index!,
    });
  }
  return out;
}

const find = (all: Rule[], selector: string) =>
  all.find((r) => r.selectors.includes(selector.replace(/\s+/g, " ")));
const declares = (rule: Rule | undefined, prop: string, value: string) =>
  !!rule && new RegExp(`(^|;)\\s*${prop}\\s*:\\s*${value.replace(/[()]/g, "\\$&")}\\s*(;|$)`).test(rule.body.trim());

// ── Topic list: the j/k cursor ─────────────────────────────────────────────

console.log("── topic-list.css: keyboard cursor ──────────────────────────────");
const list = rules(read("src/styles/components/topic-list.css"));

const cursor = find(list, "html[data-dfp] .topic-list-item.selected > td");
check(!!cursor, "row cursor rule exists");
check(declares(cursor, "background", "var(--dfp-surface-2)"), "row cursor lifts to surface-2");
check(declares(cursor, "border-color", "var(--dfp-accent)"), "row cursor turns the card border accent");

const firstCell = find(list, "html[data-dfp] .topic-list-item.selected > td:first-child");
check(!!firstCell, "first-cell rule exists");
check(declares(firstCell, "box-shadow", "none"), "first-cell rule removes the stock inset bar");
if (firstCell) {
  const ours = firstCell.selectors[0]!;
  beats(ours, ".topic-list tr.selected td:first-of-type", "first-cell vs keyboard_shortcuts.scss bar");
  beats(ours, ".topic-list-item.selected td:first-of-type", "first-cell vs its glimmer twin");
}

// The cursor must win the rest tint on a solved or pinned row by ORDER, since
// it cannot by weight — all three are (0,3,2).
for (const tinted of [
  "html[data-dfp] .topic-list-item.dfp-solved > td",
  "html[data-dfp] .topic-list-item.pinned > td",
]) {
  const tint = find(list, tinted);
  check(!!tint, `tint rule present: ${tinted}`);
  if (tint && cursor) {
    check(
      compare(specificity(cursor.selectors[0]!), specificity(tinted)) >= 0 && cursor.at > tint.at,
      `cursor outranks by order the ${show(specificity(tinted))} tint  ← ${tinted}`,
    );
  }
}

const result = find(list, "html[data-dfp] .search-container .fps-result.selected");
check(!!result, "search-result cursor rule exists");
if (result) beats(result.selectors[0]!, ".search-results .fps-result.selected", "search cursor");

// ── Topic list: the excerpt clamp box ──────────────────────────────────────

console.log("── topic-list.css: excerpt ──────────────────────────────────────");
const excerpt = find(list, "html[data-dfp] .topic-list-item .topic-excerpt");
check(!!excerpt, "excerpt rule exists");
check(declares(excerpt, "max-inline-size", "100%"), "excerpt clamp box can never exceed its cell");
check(declares(excerpt, "-webkit-line-clamp", "2"), "excerpt clamps to two lines");

// ── Topic list: the chrome band ────────────────────────────────────────────

console.log("── topic-list.css / tokens.css: list chrome band ─────────────────");
const band = list.find((r) => /margin-block-end:\s*var\(--dfp-list-nav-y\)/.test(r.body));
check(!!band, "a rule sets margin-block-end from --dfp-list-nav-y");
if (band) {
  // The three flex items that carry Discourse's `--nav-space`; a margin on
  // their container stacks under the band instead of replacing it.
  const pairs: [string, string][] = [
    ["html[data-dfp] .navigation-container #navigation-bar", "#navigation-bar"],
    ["html[data-dfp] .navigation-container .navigation-controls", ".navigation-controls"],
    ["html[data-dfp] .navigation-container .category-breadcrumb", ".category-breadcrumb"],
  ];
  for (const [ours, theirs] of pairs) {
    check(band.selectors.includes(ours), `band lands on the flex item  ← ${ours}`);
    beats(ours, theirs, "band item");
  }
}
const stacked = list.filter(
  (r) =>
    r.selectors.some((s) => /(^|\s)\.(list-controls|navigation-container)$/.test(s)) &&
    /margin(-block-end|-bottom|-block)?\s*:/.test(r.body),
);
check(stacked.length === 0, "no margin on .list-controls or .navigation-container themselves (would stack under the band)");

const tokens = read("src/styles/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
for (const token of ["--dfp-list-chrome-y", "--dfp-list-nav-y"]) {
  const n = tokens.match(new RegExp(`${token}\\s*:`, "g"))?.length ?? 0;
  check(n === 3, `${token} is set at rest, compact and spacious  →  ${n}`);
}
check(
  /--dfp-list-nav-y:\s*var\(--dfp-s-3\)/.test(tokens),
  "comfortable --dfp-list-nav-y is 12px, the grid step nearest Discourse's 0.75em --nav-space",
);
check(
  /--dfp-list-chrome-y:\s*var\(--dfp-s-2\)/.test(tokens),
  "comfortable --dfp-list-chrome-y is the 8px the header padding always was",
);

// ── Post stream: the j/k cursor ────────────────────────────────────────────

console.log("── post.css: keyboard cursor ────────────────────────────────────");
const post = rules(read("src/styles/components/post.css"));

const wrapper = find(post, "html[data-dfp] .topic-post.selected");
check(!!wrapper, "post cursor wrapper rule exists");
check(declares(wrapper, "box-shadow", "none"), "post cursor removes the stock -3px bar");
if (wrapper) beats(wrapper.selectors[0]!, ".topic-post.selected", "post wrapper");

const card = find(post, "html[data-dfp] .topic-post.selected > article.boxed");
check(!!card, "post cursor card rule exists");
check(!!card && /outline\s*:/.test(card.body), "post cursor is drawn as an outline");
check(!!card && !/border-color\s*:/.test(card.body), "post cursor does not touch border-color");
if (card) {
  // Why it is an outline: the tints own border-color at a weight the cursor
  // cannot reach without an id or a stacked class.
  const staff = post.find((r) =>
    r.selectors.includes("html[data-dfp] .topic-post:has(.names .staff) > article.boxed"),
  );
  check(!!staff && /border-color\s*:/.test(staff.body), "staff tint sets border-color via :has()");
  if (staff) {
    const heaviest = staff.selectors.map(specificity).sort(compare).at(-1)!;
    check(
      compare(heaviest, specificity(card.selectors[0]!)) > 0,
      `tint ${show(heaviest)} outweighs the cursor ${show(specificity(card.selectors[0]!))}, so border-color would lose there`,
    );
  }
}

console.log("");
if (fail > 0) {
  console.log(`FAILED: ${fail} of ${pass + fail} checks`);
  process.exit(1);
}
console.log(`ALL PASS (${pass}/${pass} checks)`);
