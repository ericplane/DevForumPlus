import { ModuleRegistry, charge, installingModule, moduleWork } from "../../src/core/registry";
import type { ModuleId } from "../../src/core/settings-schema";

/**
 * The work accounting, which is the whole reason `budgetMs` means anything.
 *
 * It used to mean nothing at all: the registry timed `install()`, every module's
 * install is a registration that returns in ~0ms, and so no module could ever
 * strike however slow it actually was. The self-disabling safety net — the thing
 * that justifies running fifteen features against a `-dev` Discourse — was
 * decorative for the life of the project.
 *
 * These assertions are the tripwire for that regression, because it is invisible
 * from the outside: everything looks fine when nothing ever strikes.
 */

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
};

const build = () => {
  const strikes: { id: ModuleId; ms: number }[] = [];
  const cleared: ModuleId[] = [];
  const registry = new ModuleRegistry({
    strikes: {},
    isEnabled: () => true,
    onStrike: (id, ms) => strikes.push({ id, ms }),
    onClearStrike: (id) => cleared.push(id),
    onRecord: () => {},
  });
  return { registry, strikes, cleared };
};

console.log("── work is charged after install, not during ───────────────────────");

{
  const { registry, strikes } = build();
  let seen: string | null | undefined;
  registry.install({
    id: "code-intel",
    budgetMs: 50,
    // A real module registers here and does its work later; this captures the
    // owner exactly as decorate.ts and dom-watch.ts do.
    install: () => {
      seen = installingModule();
    },
  });

  check(seen === "code-intel", "installingModule() names the module during install()");
  check(installingModule() === null, "installingModule() is null once install() returns");
  check(strikes.length === 0, "registering costs nothing and does not strike");

  charge("code-intel", 20);
  check(strikes.length === 0, "work under budget does not strike");

  charge("code-intel", 20);
  check(strikes.length === 0, "still under budget at 40 of 50");

  charge("code-intel", 20);
  check(strikes.length === 1, "crossing the budget strikes");
  check(strikes[0]?.id === "code-intel", "the strike names the right module");
  check((strikes[0]?.ms ?? 0) >= 60, "the strike reports total work, not the last slice");

  charge("code-intel", 500);
  check(strikes.length === 1, "a module over budget strikes once per page, not per call");

  check((moduleWork()["code-intel"] ?? 0) >= 560, "moduleWork() reports the running total");
}

console.log("\n── attribution and isolation ──────────────────────────────────────");

{
  const { registry, strikes } = build();
  registry.install({ id: "facepile", budgetMs: 10, install: () => {} });

  // A helper that captured no owner must not be able to charge anybody.
  charge(null, 9999);
  check(strikes.length === 0, "unattributed work charges nobody");

  // A module with no budget registered cannot strike either.
  charge("warm-cache" as ModuleId, 9999);
  check(
    strikes.every((s) => s.id !== "warm-cache"),
    "a module the registry never installed is never struck",
  );

  charge("facepile", 11);
  check(
    strikes.length === 1 && strikes[0]?.id === "facepile",
    "each module is charged against its own budget",
  );
}

console.log("\n── a module that throws is still recorded, and stops installing ───");

{
  const { registry } = build();
  const records: string[] = [];
  const reg2 = new ModuleRegistry({
    strikes: {},
    isEnabled: () => true,
    onStrike: () => {},
    onRecord: (r) => records.push(r.status),
  });
  reg2.install({
    id: "chart-theme",
    budgetMs: 10,
    install: () => {
      throw new Error("boom");
    },
  });
  check(records.includes("failed"), "an install that throws records as failed");
  check(
    installingModule() === null,
    "installingModule() is cleared even when install() throws — otherwise the next "
      + "module's helpers would charge their work to this one",
  );
  void registry;
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
