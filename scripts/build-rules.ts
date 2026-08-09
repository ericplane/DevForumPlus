/**
 * Strip documentation comments out of declarativeNetRequest rulesets.
 *
 * Chrome validates rule objects strictly and rejects unknown keys, so `_comment`
 * cannot ship. But a bare urlFilter with no explanation is exactly the kind of
 * rule that gets copied wrong later — this one already shipped once matching the
 * wrong host — so the source keeps its reasoning and the build removes it.
 *
 * Run: npm run rules (invoked by `npm run build`)
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../rules-src");
const out = resolve(here, "../public/rules");

mkdirSync(out, { recursive: true });

let count = 0;
for (const file of readdirSync(src).filter((f) => f.endsWith(".json"))) {
  const rules = JSON.parse(readFileSync(join(src, file), "utf8")) as Record<string, unknown>[];
  const cleaned = rules.map(({ _comment, ...rule }) => rule);
  writeFileSync(join(out, file), JSON.stringify(cleaned, null, 2) + "\n", "utf8");
  count += cleaned.length;
  console.log(`  rules: ${file} — ${cleaned.length} rule(s)`);
}
console.log(`rules: wrote ${count} rule(s) to public/rules/`);
