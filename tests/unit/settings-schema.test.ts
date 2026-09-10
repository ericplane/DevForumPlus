import {
  DEFAULT_OFF,
  DEFAULT_SETTINGS,
  MODULE_IDS,
  isModuleEnabled,
  normalizeSettings,
} from "../../src/core/settings-schema";

/**
 * The module-flag reading every surface shares.
 *
 * `settings.modules` records exceptions only, and for twenty modules "missing
 * key means on" was the whole rule. DEFAULT_OFF makes the absent key mean
 * "off" for a listed id — the only way a module can ship off for someone whose
 * settings were saved by a build that did not know it — so what is worth
 * pinning is that an absent key, a stored `true` and a stored `false` read the
 * same through isModuleEnabled whether or not the id is listed, and that the
 * list only names ids the schema has. The registry (main-world.content.ts),
 * the isolated mounts and the options page all read through this one function;
 * when the options page tested `!== false` itself it rendered a DEFAULT_OFF
 * module as on while the registry left it uninstalled.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};
const eq = (got: unknown, want: unknown, label: string) =>
  check(got === want, `${label}  →  ${JSON.stringify(got)}`);

console.log("── DEFAULT_OFF names real ids ────────────────────────────────────");
check(DEFAULT_OFF.size > 0, "at least one module ships off (topic-excerpts)");
check(
  [...DEFAULT_OFF].every((id) => (MODULE_IDS as readonly string[]).includes(id)),
  "every DEFAULT_OFF id is in MODULE_IDS",
);
check(DEFAULT_OFF.has("topic-excerpts"), "topic-excerpts is off by default");
check(!DEFAULT_OFF.has("command-palette"), "command-palette is on by default");

console.log("── an absent key ─────────────────────────────────────────────────");
const fresh = normalizeSettings({});
eq(Object.keys(fresh.modules).length, 0, "normalizeSettings({}) records no exceptions");
eq(isModuleEnabled(fresh, "topic-excerpts"), false, "absent + DEFAULT_OFF → off");
eq(isModuleEnabled(fresh, "topic-list-signals"), true, "absent + not listed → on");
eq(isModuleEnabled(DEFAULT_SETTINGS, "topic-excerpts"), false, "DEFAULT_SETTINGS agrees");

console.log("── a stored value wins either way ────────────────────────────────");
const onExplicit = normalizeSettings({ modules: { "topic-excerpts": true } });
eq(isModuleEnabled(onExplicit, "topic-excerpts"), true, "stored true overrides DEFAULT_OFF");
const offExplicit = normalizeSettings({ modules: { "topic-list-signals": false } });
eq(isModuleEnabled(offExplicit, "topic-list-signals"), false, "stored false switches a default-on off");
const junk = normalizeSettings({ modules: { "topic-excerpts": "yes" } });
eq(isModuleEnabled(junk, "topic-excerpts"), false, "a non-boolean is dropped, so the default applies");

console.log("── this wave's ids are in the schema ─────────────────────────────");
for (const id of [
  "topic-excerpts",
  "timeline-marks",
  "post-numbers",
  "composer",
  "command-palette",
  "recent-topics",
]) {
  check((MODULE_IDS as readonly string[]).includes(id), `MODULE_IDS has "${id}"`);
}
eq(new Set(MODULE_IDS).size, MODULE_IDS.length, "no duplicate id");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
