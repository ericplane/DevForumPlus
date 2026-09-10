/**
 * Byte budgets for the content scripts, enforced after the build instead of
 * asserted in a comment.
 *
 * src/core/perf-overlay.ts used to declare `cssGzipKB: 40` and
 * `contentScriptKB: 30`, say they were "enforced rather than asserted", and
 * grade them against resource-timing entries whose name starts with
 * `chrome-extension://`. Content scripts are injected by the browser, not
 * fetched by the document, so they never appear there, and that row read
 * 0 KB — a pass — on every load for the life of the project. Nothing else
 * enforced the numbers either:
 *
 *   - wxt.config.ts's `chunkSizeWarningLimit: 300` is a warning, on raw bytes,
 *     at a threshold nothing here approaches.
 *   - ci.yml had no size step; the build was green at any size.
 *
 * Both budgets and that readout are removed from the overlay in the same change
 * as this file: bytes are a build-time question, and the overlay measures the
 * running page. The numbers live here now, next to the files they describe.
 *
 * Meanwhile main-world.js — the script that runs at document_start on every
 * forum page — measured 157,957 B raw / 47,122 B gzipped on 2026-09-04: half
 * again the 30 KB the overlay used to claim. code-intel.ts already turns down a
 * 28 KB dependency on exactly this reasoning, and that judgement has been made
 * by hand, with no number to check it against, every time.
 *
 * So the budgets below start from where the code actually is, and the guard
 * only ratchets down. Lowering a number here is a decision; raising one is a
 * regression that needs its reason in the same diff.
 *
 * This cannot live in `prebuild` beside the other check:* scripts, because it
 * needs the built files and prebuild runs before wxt has produced anything.
 * It is the last step of `npm run build` and `npm run zip` instead — build is
 * what ci.yml gates every push on, zip is what release.yml ships from.
 *
 * Run: npm run check:bundle   (after a build)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, ".output");

const KB = 1024;

/**
 * Gzipped bytes allowed per file under `content-scripts/`, for each target.
 * KB is 1024 bytes throughout. Which base is arbitrary, but it has to be fixed
 * and stated: a budget quoted in one and measured in the other is off by 2.4%,
 * which at these sizes is about 1 KB — half the headroom on main-world.js.
 *
 * Gzip rather than raw because the package the stores ship is a deflated zip,
 * so the gzipped size is close to what the download actually costs, and
 * because it does not move when the minifier renames identifiers. Raw size is
 * what parse actually costs, so it is printed alongside — but the ratchet is
 * on the number that stays comparable between builds. The exact count also
 * shifts by a few bytes between zlib versions (Node 22 locally, 24 in CI per
 * .nvmrc), which is part of why each budget sits 2–3 KB above its measurement
 * instead of on it.
 *
 * One budget per file serves both targets: a fresh build of chrome and firefox
 * on 2026-09-04 produced byte-identical content scripts (the manifests differ;
 * the scripts do not). The firefox copy is still checked, because that
 * identity is a property of today's wxt.config.ts, not a rule.
 */
const BUDGETS: Record<string, number> = {
  /* The overlay's old contentScriptKB: 30 was aspirational — set before most
   * of the modules existed and never enforced by anything — and the shipped
   * file passed it a long time ago. Measured 47,122 B (46.0 KB) gzipped, so
   * the guard started just above the measurement: 48 KB, 2 KB of headroom.
   *
   * Raised to 52 KB by the 2026-09-04 integration wave, which added three
   * MAIN modules (topic-excerpts, timeline-marks, post-numbers), the entity
   * cards and touch-first-tap in asset-preview/topic-preview, the finding
   * chips and preview observer in code-intel, and the site-data category
   * table: measured 51,589 B (50.4 KB), rounded up to the next 4 KB.
   * Anything that brings the file down can bring this number down with it. */
  "main-world.js": 52 * KB,

  /* Measured 22,056 B / 21.5 KB gzipped. The old 30 KB figure would have let
   * this file grow by 8 KB without a word, which is not a budget; 24 KB was
   * the measurement plus headroom.
   *
   * Raised to 32 KB by the same 2026-09-04 wave: the command palette grew its
   * recents recorder, filter chips and command matching, the composer its
   * submit-lifecycle state machine and Luau fencing, and the docs card its
   * hover-target and focus gates — measured 28,853 B (28.2 KB), rounded up to
   * the next 4 KB. */
  "isolated.js": 32 * KB,

  /* The overlay's old cssGzipKB: 40 guarded nothing at the measured 19,640 B /
   * 19.2 KB gzipped — it would have passed a stylesheet twice this size. 22 KB
   * is the measurement plus headroom. */
  "isolated.css": 22 * KB,
};

/* wxt's output directory per target (wxt.config.ts: targetBrowsers chrome and
 * firefox, manifestVersion 3). A target that has not been built is skipped, so
 * this also runs sensibly after `build:chrome` alone; it fails only when NO
 * target has been built, because then there is nothing to measure. */
const TARGETS = ["chrome-mv3", "firefox-mv3"];

const kb = (bytes: number) => `${(bytes / KB).toFixed(1)} KB`;

const errors: string[] = [];
const lines: string[] = [];
let checked = 0;

for (const target of TARGETS) {
  const dir = resolve(outDir, target, "content-scripts");
  if (!existsSync(dir)) continue;

  for (const [file, budget] of Object.entries(BUDGETS)) {
    const rel = `${target}/content-scripts/${file}`;
    const full = resolve(dir, file);

    if (!existsSync(full)) {
      // The target built but this file did not: either the build is broken or
      // an entrypoint was renamed and this map still names the old file. Both
      // are worth stopping for; a guard that silently checks nothing is the
      // failure this script exists to end.
      errors.push(
        `${rel} is missing. Renamed the entrypoint? Update BUDGETS in scripts/check-bundle.ts.`,
      );
      continue;
    }

    const raw = readFileSync(full);
    const gz = gzipSync(raw).length;
    const pct = Math.round((gz / budget) * 100);
    checked++;

    lines.push(
      `  ${gz > budget ? "OVER" : " ok "} ${rel.padEnd(42)} ${kb(gz).padStart(8)} gzip of ${kb(budget)} ` +
        `(${pct}%, ${kb(raw.length)} raw)`,
    );

    if (gz > budget) {
      errors.push(
        `${rel}: ${kb(gz)} gzipped exceeds its ${kb(budget)} budget by ${kb(gz - budget)}.\n` +
          `         Shed the bytes, or raise the budget in scripts/check-bundle.ts in the same ` +
          `diff with the reason. This number only ratchets down.`,
      );
    }
  }
}

if (checked === 0 && errors.length === 0) {
  errors.push(
    `nothing built under .output/{${TARGETS.join(",")}}/content-scripts.\n         Run: npm run build`,
  );
}

for (const l of lines) console.log(l);

if (errors.length > 0) {
  for (const e of errors) console.error(`  FAIL ${e}`);
  process.exit(1);
}

console.log(`check:bundle: ok — ${checked} content-script file(s) within their gzip budgets`);
