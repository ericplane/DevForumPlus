import {
  ModuleRegistry,
  charge,
  installingModule,
  moduleWork,
  resetRouteWork,
} from "../../src/core/registry";
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

const build = (persisted: Partial<Record<ModuleId, number>> = {}) => {
  const strikes: { id: ModuleId; ms: number }[] = [];
  const cleared: ModuleId[] = [];
  const registry = new ModuleRegistry({
    strikes: persisted,
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

console.log("\n── the counter can reach 3: install no longer clears it ────────────────");

/* Two sessions, with the persisted store played by `store`, exactly as the
 * isolated side keeps it: bump adds one, clear deletes the key. The old
 * install() cleared the key before a single ms had been charged, so this
 * sequence went 0 → 1 → (clear) → 1 forever and STRIKES_TO_DISABLE was
 * unreachable. */
{
  resetRouteWork();
  const store: Partial<Record<ModuleId, number>> = {};
  const session = () => {
    const cleared: ModuleId[] = [];
    const order: string[] = [];
    const registry = new ModuleRegistry({
      strikes: { ...store },
      isEnabled: () => true,
      onStrike: (id) => {
        store[id] = (store[id] ?? 0) + 1;
        order.push(`bump:${id}`);
      },
      onClearStrike: (id) => {
        delete store[id];
        cleared.push(id);
        order.push(`clear:${id}`);
      },
    });
    registry.install({ id: "code-intel", budgetMs: 50, install: () => {} });
    return { registry, cleared, order };
  };
  const strikesOf = (registry: ModuleRegistry) =>
    registry.snapshot().find((r) => r.id === "code-intel")?.strikes;

  // Session 1: nothing on record; the module goes over budget once.
  const s1 = session();
  charge("code-intel", 60);
  check(store["code-intel"] === 1, "session 1: the strike is persisted");
  check(strikesOf(s1.registry) === 1, "the record mirrors the bump before diagnostics are re-pushed");
  resetRouteWork();
  check(s1.cleared.length === 0, "a route the module struck in does not clear its strike");
  check(store["code-intel"] === 1, "…so the count survives to the next session");

  // Session 2: boots with one strike on record.
  const s2 = session();
  check(s2.cleared.length === 0, "session 2: install does not clear the carried strike");
  check(strikesOf(s2.registry) === 1, "the record carries the persisted count in, not 0");
  charge("code-intel", 60);
  check(store["code-intel"] === 2, "session 2: the count reaches 2");
  check(
    s2.order[0] === "bump:code-intel" && !s2.order.includes("clear:code-intel"),
    "the bump fired and no clear preceded it",
  );
  check(strikesOf(s2.registry) === 2, "the record reads 2");

  // A clean route in the same session earns the clear.
  resetRouteWork();
  check(store["code-intel"] === 2, "still 2 after the struck route ends");
  charge("code-intel", 10);
  resetRouteWork();
  check(s2.cleared.length === 1 && store["code-intel"] === undefined, "a route under budget clears the record");
  check(strikesOf(s2.registry) === 0, "the record reads 0 after the clear");
  check((moduleWork()["code-intel"] ?? 0) === 0, "the meter starts the next route at zero");
  check(
    s2.registry.snapshot().find((r) => r.id === "code-intel")?.workMs === 0,
    "snapshot() reports workMs from the meter, not from install",
  );

  // The `rec.strikes === 0` guard in endRoute(): a clean route with nothing on
  // record must not send a clear the isolated side would only have to ignore.
  charge("code-intel", 10);
  resetRouteWork();
  check(s2.cleared.length === 1, "a module with no strike on record never sends a needless clear");

  // Strikes are per route: a module cleared last route can strike again this one.
  charge("code-intel", 60);
  check(store["code-intel"] === 1, "the same module can strike again in a later route");
  resetRouteWork();
  check(s2.cleared.length === 1 && store["code-intel"] === 1, "a struck route keeps the strike");

  // Session 3: three consecutive struck routes on record.
  store["code-intel"] = 3;
  const s3 = session();
  check(
    s3.registry.snapshot().find((r) => r.id === "code-intel")?.status === "auto-disabled",
    "three strikes on record auto-disables at boot",
  );
  resetRouteWork();
  check(
    s3.cleared.length === 0 && store["code-intel"] === 3,
    "a route cannot clear a module that never ran — it would re-enable itself unmeasured",
  );
}

console.log("\n── the route-close callback sees the closed route, not an empty meter ──");

/* main-world.content.ts pushes diagnostics from this callback. It used to push
 * after resetRouteWork() returned, and a probe over the real registry showed
 * every route-end push at workMs 0 — the meter had already been cleared — so
 * the popup read "0 / N ms" for any route that ended without a strike. */
{
  resetRouteWork();
  const { registry, strikes, cleared } = build({ facepile: 1 });
  registry.install({ id: "facepile", budgetMs: 100, install: () => {} });
  charge("facepile", 37.5);

  let seen: { workMs: number; strikes: number } | undefined;
  resetRouteWork(() => {
    const rec = registry.snapshot().find((r) => r.id === "facepile");
    if (rec) seen = { workMs: rec.workMs, strikes: rec.strikes };
  });
  check(seen?.workMs === 37.5, "a snapshot taken from the callback carries the charged total");
  check(seen?.strikes === 0 && cleared.length === 1, "…with the strike counters already settled");
  check((moduleWork()["facepile"] ?? 0) === 0, "…and the meter is clear once it returns");

  // A callback that throws must not leave last route's spend running into this one.
  charge("facepile", 80);
  try {
    resetRouteWork(() => {
      throw new Error("push failed");
    });
  } catch {
    // The throw is the caller's to handle; the reset is not.
  }
  check((moduleWork()["facepile"] ?? 0) === 0, "the meter clears even when the callback throws");
  charge("facepile", 30);
  check(strikes.length === 0, "…so 80ms last route plus 30ms this one does not strike a 100ms budget");
}

console.log("\n── snapshot() carries the budget and the live work ────────────────────");

{
  resetRouteWork();
  const { registry } = build();
  registry.install({ id: "facepile", budgetMs: 30, install: () => {} });
  charge("facepile", 12.34);
  const rec = registry.snapshot().find((r) => r.id === "facepile");
  check(rec?.budgetMs === 30, "the record carries budgetMs, so a reader can grade workMs");
  check(rec?.workMs === 12.3, "workMs is the charged total, to a tenth of a ms");
  check(rec?.installMs !== undefined && rec.installMs < 5, "installMs stays ~0 — a registration, not the work");
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILING"} (${pass}/${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
