/**
 * Generated assets the extension needs at runtime, checked before a build ships.
 *
 * This exists because of a specific failure that lasted a long time and was
 * invisible from every angle:
 *
 *   - `build-docs-index.ts` writes the Creator Docs shards to `public/docs/`.
 *   - `.gitignore` ends with a bare `docs/`, which matches `public/docs/` at any
 *     depth, so the shards are never committed.
 *   - `npm run build` never ran the generator.
 *   - On Windows the generator ALSO crashed, because GNU tar reads an absolute
 *     `C:\…` path as a remote host.
 *
 * Result: `loadShard` fetched a 404 for every lookup, `resolve` returned null,
 * and every Creator Docs hover card rendered nothing — for API names in code
 * blocks and for docs links in prose alike. Twenty-one kilobytes of card code
 * whose data had never once existed, and a build that reported success the
 * whole time.
 *
 * The generator is deliberately NOT part of `npm run build`: it downloads a
 * 4.6 MB tarball of Roblox's docs repo, which is not something every build
 * should do. So the build's job is to REFUSE to ship without it, loudly, with
 * the command that fixes it.
 *
 * Run: npm run check:assets
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

interface Asset {
  dir: string;
  /** Below this, treat it as a failed or half-finished generation. */
  min: number;
  fix: string;
  why: string;
}

const ASSETS: Asset[] = [
  {
    dir: "public/docs",
    /* ~1230 shards ship today. A floor of 200 catches "empty" and "the
     * generator bailed a third of the way through" without failing every time
     * Roblox adds or removes a class. */
    min: 200,
    fix: "npm run docs-index",
    why: "Creator Docs hover cards render nothing without these shards.",
  },
  {
    dir: "public/rules",
    min: 1,
    fix: "npm run rules",
    why: "declarativeNetRequest rulesets named in the manifest must exist.",
  },
];

const errors: string[] = [];

for (const asset of ASSETS) {
  const full = resolve(root, asset.dir);
  if (!existsSync(full)) {
    errors.push(`${asset.dir} is missing. ${asset.why}\n         Run: ${asset.fix}`);
    continue;
  }
  const count = countJson(full);
  if (count < asset.min) {
    errors.push(
      `${asset.dir} has ${count} files, expected at least ${asset.min}. ` +
        `${asset.why}\n         Run: ${asset.fix}`,
    );
  }
}

function countJson(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countJson(resolve(dir, entry.name));
    else if (entry.name.endsWith(".json")) n++;
  }
  return n;
}

if (errors.length > 0) {
  for (const e of errors) console.error(`  FAIL ${e}`);
  process.exit(1);
}

console.log(`check:assets: ok — ${ASSETS.map((a) => a.dir).join(", ")} present`);
