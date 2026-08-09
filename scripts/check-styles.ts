/**
 * Style guardrails, enforced rather than documented.
 *
 * Two rules, both of which exist because they are the ways a browser-extension
 * stylesheet normally rots:
 *
 *   1. `!important` stays quarantined in overrides/hard.css and stays under a
 *      hard cap. Once specificity fights are cheap to win, every future fix
 *      becomes one, and the stylesheet stops being reasonable about.
 *
 *   2. DFP styles must never sit inside an @layer. Discourse's CSS is
 *      unlayered, and unlayered rules beat layered ones regardless of
 *      specificity — so a cascade layer here would silently disable the entire
 *      design system. This is subtle enough to be worth a machine check.
 *
 * Run: npm run check:styles
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const stylesDir = resolve(root, "src/styles");
const quarantine = resolve(stylesDir, "overrides/hard.css");

const MAX_IMPORTANT = 20;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? walk(full)
      : full.endsWith(".css")
        ? [full]
        : [];
  });
}

/** Strip comments so prose mentioning `!important` is not counted as code. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const errors: string[] = [];
let quarantineCount = 0;

for (const file of walk(stylesDir)) {
  const rel = relative(root, file);
  const code = stripComments(readFileSync(file, "utf8"));

  const importants = code.match(/!\s*important/g)?.length ?? 0;

  if (file === quarantine) {
    quarantineCount = importants;
  } else if (importants > 0) {
    errors.push(
      `${rel}: ${importants} !important outside the quarantine. ` +
        `Move them to src/styles/overrides/hard.css with a comment naming what they fight.`,
    );
  }

  // Our own files must not declare or use cascade layers.
  if (/@layer\b/.test(code)) {
    errors.push(
      `${rel}: uses @layer. DFP styles must stay unlayered — Discourse's CSS is ` +
        `unlayered, and unlayered rules always beat layered ones.`,
    );
  }
}

if (quarantineCount > MAX_IMPORTANT) {
  errors.push(
    `overrides/hard.css: ${quarantineCount} !important declarations exceeds the cap of ${MAX_IMPORTANT}.`,
  );
}

if (errors.length > 0) {
  for (const e of errors) console.error(`  FAIL ${e}`);
  process.exit(1);
}

console.log(
  `check:styles: ok — ${quarantineCount}/${MAX_IMPORTANT} quarantined !important, no cascade layers`,
);
