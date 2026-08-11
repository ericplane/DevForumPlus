/**
 * Style guardrails, enforced rather than documented.
 *
 * Three rules, all of which exist because they are the ways a browser-extension
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
 *   3. Every `.dfp-*` class must appear in the visual fixture. The harness is
 *      the only place these rules are ever LOOKED at, and it reports success
 *      whether or not it rendered anything — so a component whose markup is
 *      missing from the fixture ships unreviewed while the build stays green.
 *      Found the hard way: the pinned-OP column keyed on `.post-stream`, which
 *      the fixture did not contain at all.
 *
 *      This is a ratchet, not a wall. `tests/visual/uncovered.json` records what
 *      is already missing; the check fails only when something NEW goes
 *      uncovered. Shrinking that file is how the debt gets paid down.
 *
 * Run: npm run check:styles
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

// ── Fixture coverage ────────────────────────────────────────────────────────

const fixturePath = resolve(root, "tests/visual/fixture.html");
const baselinePath = resolve(root, "tests/visual/uncovered.json");

/** Every `.dfp-…` class the stylesheet actually styles. */
const styled = new Set<string>();
for (const file of walk(stylesDir)) {
  const code = stripComments(readFileSync(file, "utf8"));
  for (const m of code.matchAll(/\.(dfp-[a-z0-9_-]+)/gi)) styled.add(m[1]!);
}

/** Every class the fixture can actually render. */
const rendered = new Set<string>();
const fixture = readFileSync(fixturePath, "utf8");
for (const m of fixture.matchAll(/class="([^"]*)"/g)) {
  for (const cls of m[1]!.trim().split(/\s+/)) if (cls) rendered.add(cls);
}

const uncovered = [...styled].filter((c) => !rendered.has(c)).sort();

if (!existsSync(baselinePath)) {
  // Self-bootstrapping: the first run records the debt rather than failing a
  // build for a rule that did not exist a moment ago.
  writeFileSync(baselinePath, JSON.stringify(uncovered, null, 2) + "\n", "utf8");
  console.log(
    `check:styles: wrote ${relative(root, baselinePath)} with ${uncovered.length} ` +
      `pre-existing uncovered classes. Shrink it, do not grow it.`,
  );
} else {
  const baseline = new Set<string>(JSON.parse(readFileSync(baselinePath, "utf8")) as string[]);
  const regressions = uncovered.filter((c) => !baseline.has(c));
  const fixed = [...baseline].filter((c) => !uncovered.includes(c)).sort();

  if (regressions.length > 0) {
    errors.push(
      `fixture coverage: ${regressions.length} newly-styled class(es) have no markup in ` +
        `tests/visual/fixture.html, so nothing renders them in the harness:\n` +
        regressions.map((c) => `           .${c}`).join("\n") +
        `\n         Add markup that uses them, or append them to ${relative(root, baselinePath)} ` +
        `with a reason.`,
    );
  }
  if (fixed.length > 0) {
    // Not an error — but the baseline must shrink when debt is paid, or it
    // stops meaning anything.
    console.log(
      `check:styles: ${fixed.length} class(es) are now covered and can be removed from ` +
        `${relative(root, baselinePath)}: ${fixed.slice(0, 8).join(", ")}` +
        (fixed.length > 8 ? ` (+${fixed.length - 8} more)` : ""),
    );
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`  FAIL ${e}`);
  process.exit(1);
}

console.log(
  `check:styles: ok — ${quarantineCount}/${MAX_IMPORTANT} quarantined !important, no cascade layers`,
);
