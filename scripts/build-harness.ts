/**
 * Builds a standalone visual-regression harness from the *built* content
 * stylesheet plus a fixture of real DevForum markup.
 *
 * Testing against the shipped CSS rather than the source matters: minification,
 * @import inlining and autoprefixing all happen in the build, and a harness
 * that skips them can pass while the extension is broken.
 *
 * Run: npm run harness   →   .output/harness.html
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const cssPath = resolve(root, ".output/chrome-mv3/content-scripts/isolated.css");
const fixturePath = resolve(root, "tests/visual/fixture.html");
const outPath = resolve(root, ".output/harness.html");

if (!existsSync(cssPath)) {
  console.error(`harness: ${cssPath} not found — run \`npm run build\` first.`);
  process.exit(1);
}

const css = readFileSync(cssPath, "utf8");
const fixture = readFileSync(fixturePath, "utf8");

const THEMES = ["dark", "dim", "black", "light", "off"];
const DENSITIES = ["comfortable", "compact", "spacious"];
const RADII = ["sharp", "soft", "round"];

/* Attributes a JS module stamps at runtime. The harness has no modules, so
 * anything gated on one of these is otherwise unreachable here. */
const FLAGS = [
  { attr: "data-dfp-threaded", label: "thread view" },
  { attr: "data-dfp-op-pin", label: "pinned OP" },
  { attr: "data-dfp-quiet", label: "quiet replies" },
  /* Stamped by topic-excerpts.ts once its transformer is accepted; perf.css
   * keys the taller row placeholder on it. The fixture's rows already carry
   * `.topic-excerpt`, so the flag only changes the placeholder, not the paint. */
  { attr: "data-dfp-excerpts", label: "row excerpts" },
];

/* Column widths, written as an inline `inline-size` on `.page`.
 *
 * The harness always rendered `.page` at `--dfp-content-max`, so nothing
 * narrower than 1100px was ever looked at: the topic list's columns, the post
 * card, the toggle cluster and every inline `code` span were reviewed at one
 * width only, and the fixture's own comments say the mobile layout has never
 * been captured. 390 is a phone, 720 the product's one narrow breakpoint
 * (reading.css, touch.css), 1024 a half-screen beside Studio, 1280 the pinned
 * panel's floor; `full` clears the override.
 *
 * What the column CANNOT do is fire a media query. `@media (max-width: 720px)`
 * and `(min-width: 1280px)` measure the window, not `.page`, so narrowing the
 * column shows overflow and wrapping at that width but leaves those blocks
 * as they are. The pop-out button beside the group opens this same file in a
 * window of the selected width, where they do apply — the one way to review
 * them without resizing by hand. */
const VIEWPORTS = [
  { label: "390", size: "390px" },
  { label: "720", size: "720px" },
  { label: "1024", size: "1024px" },
  { label: "1280", size: "1280px" },
  { label: "full", size: "" },
];

const page = `<!doctype html>
<html lang="en" data-dfp="1" data-dfp-theme="dark" data-dfp-density="comfortable" data-dfp-motion="full" data-dfp-radius="soft" data-dfp-width="default">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DevForum Plus — visual harness</title>
<style>
/* Harness chrome only. Everything below the toolbar is styled exclusively by
   the shipped extension stylesheet, so anything that looks right here is
   genuinely the product and not the harness flattering it. */
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: BuilderSans, "Helvetica Neue", Helvetica, Arial, sans-serif;
  background: var(--dfp-bg, #111);
  color: var(--dfp-text, #eee);
}
.toolbar {
  position: sticky; top: 0; z-index: 100;
  display: flex; flex-wrap: wrap; gap: 16px; align-items: center;
  padding: 10px 16px;
  background: var(--dfp-surface-2, #222);
  border-bottom: 1px solid var(--dfp-border, #333);
  font-size: 12px;
}
.toolbar .grp { display: flex; align-items: center; gap: 6px; }
.toolbar b { font-weight: 600; color: var(--dfp-text-3, #888); text-transform: uppercase; letter-spacing: .05em; font-size: 10px; }
.toolbar button {
  appearance: none; border: 1px solid var(--dfp-border, #333);
  background: var(--dfp-surface-1, #1a1a1a); color: var(--dfp-text-2, #bbb);
  border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; font-size: 12px;
}
.toolbar button[aria-pressed="true"] { background: var(--dfp-accent, #37b3ff); color: #06121a; font-weight: 600; border-color: transparent; }
.page { max-width: var(--dfp-content-max, 1100px); margin: 0 auto; padding: 24px 16px 80px; }
.harness-block { margin-bottom: 48px; }
.harness-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--dfp-text-3, #888); font-weight: 600; margin: 0 0 12px;
  padding-bottom: 6px; border-bottom: 1px solid var(--dfp-border, #333);
}
.harness-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
.topic-list { width: 100%; }
.topic-list td, .topic-list th { text-align: left; vertical-align: top; }
.topic-list .num, .topic-list .posters { text-align: center; white-space: nowrap; }
.topic-body { flex: 1; min-width: 0; }
.row { display: flex; gap: 14px; }
/* Discourse's button base the fixture markup relies on: without it the UA's
 * ButtonFace (#6b6b6b under color-scheme: dark, measured) sits under every
 * .btn-link / .btn-transparent and fails contrast at 2.62-2.74:1 in every
 * dark-scheme combination of check-harness.ts. */
.btn-link, .btn-transparent { background: transparent; border: 0; }
</style>

<!-- ── shipped extension stylesheet, verbatim ───────────────────────────── -->
<style>
${css}
</style>
</head>
<body>
<div class="toolbar">
  <div class="grp"><b>Theme</b>${THEMES.map((t) => `<button data-attr="data-dfp-theme" data-val="${t}">${t}</button>`).join("")}</div>
  <div class="grp"><b>Density</b>${DENSITIES.map((d) => `<button data-attr="data-dfp-density" data-val="${d}">${d}</button>`).join("")}</div>
  <div class="grp"><b>Corners</b>${RADII.map((r) => `<button data-attr="data-dfp-radius" data-val="${r}">${r}</button>`).join("")}</div>
  <!-- Boolean root flags a module would normally stamp. Without these the
       harness renders the default state only, and a feature gated on an
       attribute is reviewed by nobody. -->
  <div class="grp"><b>Flags</b>${FLAGS.map((f) => `<button data-flag="${f.attr}">${f.label}</button>`).join("")}</div>
  <!-- Column width. Media queries follow the window, not the column — see
       VIEWPORTS above — so the last button pops the harness out at that width. -->
  <div class="grp"><b>Viewport</b>${VIEWPORTS.map((v) => `<button data-viewport="${v.size}">${v.label}</button>`).join("")}<button data-popout title="Open at the selected width in its own window, where the width media queries apply">↗ window</button></div>
</div>

<div class="page">
${fixture}
</div>

<script>
const root = document.documentElement;
const page = document.querySelector(".page");
function sync() {
  for (const b of document.querySelectorAll(".toolbar button")) {
    if ("popout" in b.dataset) continue;
    b.setAttribute("aria-pressed", String(
      "viewport" in b.dataset
        ? page.style.inlineSize === b.dataset.viewport
        : b.dataset.flag
          ? root.hasAttribute(b.dataset.flag)
          : root.getAttribute(b.dataset.attr) === b.dataset.val,
    ));
  }
}
document.querySelector(".toolbar").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if ("popout" in b.dataset) {
    // The column width, or the window's own when "full" is selected. The
    // popup gets the width as its viewport, which is what the media queries
    // read; 900 tall is enough to see a post card whole.
    const width = parseInt(page.style.inlineSize, 10) || innerWidth;
    open(location.href, "_blank", "popup,width=" + width + ",height=900");
    return;
  }
  if ("viewport" in b.dataset) {
    page.style.inlineSize = b.dataset.viewport;
    // .page caps itself at --dfp-content-max; a 1280 column has to be let
    // past that cap or it silently renders at 1100. (No backticks in this
    // block: it lives inside the template literal that is the page.)
    page.style.maxWidth = b.dataset.viewport ? "none" : "";
  } else if (b.dataset.flag) {
    root.toggleAttribute(b.dataset.flag);
  } else {
    root.setAttribute(b.dataset.attr, b.dataset.val);
  }
  sync();
});
sync();
</script>
</body>
</html>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, page, "utf8");

console.log(
  `harness: wrote .output/harness.html (${(page.length / 1024).toFixed(1)} kB, ` +
    `${(css.length / 1024).toFixed(1)} kB of shipped CSS)`,
);
