import { measure } from "./perf";
import type { ModuleId } from "./settings-schema";

export type ModuleStatus =
  | "installed"
  | "disabled-by-user"
  | "auto-disabled"
  | "failed"
  | "unavailable";

export interface ModuleRecord {
  id: ModuleId;
  status: ModuleStatus;
  /**
   * Wall-clock cost of install(), in ms. ~0 for every module by design (see
   * `budgetMs` below), so nothing grades on it any more; it stays in the record
   * because the number is real and the shape is shared with the popup.
   */
  installMs: number;
  /**
   * Main-thread ms charged to the module during the current route. This is the
   * number the popup and overlay used to print `installMs` in place of — which
   * read "0.0 ms" beside every module, however slow it was. Filled by
   * `snapshot()` from the accounting below, never stored.
   */
  workMs: number;
  /** The module's `budgetMs`, so a reader can grade `workMs` without the module in hand. */
  budgetMs: number;
  /**
   * Consecutive struck routes, mirroring the persisted counter: bumped when the
   * module strikes, zeroed when a route ends without one. For a module that did
   * not install it is the count read at boot.
   */
  strikes: number;
  error?: string;
}

export interface DfpModule {
  id: ModuleId;
  /**
   * Main-thread budget for one route, in ms. Exceeding it three routes running
   * auto-disables the module.
   *
   * This used to be the budget for `install()` alone, which measured nothing:
   * every module's install is a registration that returns in ~0ms, and the
   * actual work happens later in decorator sweeps and DOM watchers. So no
   * module could ever strike, on any page, however slow it was — the whole
   * self-disabling safety net was decorative. decorate.ts had even documented
   * the consequence, deferring its first sweep specifically to stay outside the
   * measured window.
   *
   * Now it is everything the module does after boot: decorator callbacks
   * (decorate.ts) and DOM watchers (dom-watch.ts) are timed and charged here.
   * The meter resets at every route boundary (`resetRouteWork()`), because a
   * per-document budget on a single-page app is a budget for the whole session
   * — an hour of reading would eventually strike any module at all.
   *
   * The numbers are ALARMS, not tuning knobs. They sit well above measured cost
   * — a strike costs the user a feature, so a budget that is merely tight is
   * worse than one that is loose. Tighten them once real numbers exist, and
   * never on a hunch.
   */
  budgetMs: number;
  /**
   * Returns true if this module can run in the current environment (right
   * Discourse version, required API present, …). A false return is a normal
   * outcome, not an error — the module reports `unavailable` and we move on.
   */
  isAvailable?: () => boolean;
  install: () => void;
}

export interface RegistryOptions {
  /** Persisted strike counts, supplied by the isolated world at boot. */
  strikes: Partial<Record<ModuleId, number>>;
  /** True if the user has explicitly switched the module off. */
  isEnabled: (id: ModuleId) => boolean;
  /** Fired when a module goes over budget, so the strike can be persisted. */
  onStrike: (id: ModuleId, workMs: number) => void;
  /**
   * Called from `resetRouteWork()` for a module that had strikes on record and
   * finished the route that just ended without one, so strikes stay
   * consecutive. Never called from `install()` — see the note there.
   */
  onClearStrike?: (id: ModuleId) => void;
  /**
   * Fired on any status change. A consumer that wants the live picture — work
   * charged, strikes bumped or cleared — reads `snapshot()` instead, which is
   * what main-world.content.ts pushes to the popup.
   */
  onRecord?: (record: ModuleRecord) => void;
}

const STRIKES_TO_DISABLE = 3;

// ── Work accounting ─────────────────────────────────────────────────────────
//
// Module-level rather than instance state because the helpers that charge time
// — decorate.ts, dom-watch.ts — are plain functions with no registry in hand,
// and there is exactly one registry per page.

/** Set only while a module's `install()` is on the stack. */
let installing: ModuleId | null = null;

/** ms of main-thread time charged to each module during the current route. */
const spent = new Map<ModuleId, number>();
const budgets = new Map<ModuleId, number>();
/** One strike per route: a module over budget stays over budget until the route ends. */
const struck = new Set<ModuleId>();
/* Both bound by the registry instance: `report` turns going over into a
 * strike, `routeEnd` settles the strike counters when a route closes. */
let report: ((id: ModuleId, ms: number) => void) | null = null;
let routeEnd: (() => void) | null = null;

/**
 * Which module is installing right now.
 *
 * Helpers call this at REGISTRATION time to capture an owner, then charge that
 * owner whenever the callback they registered actually runs. Reading it later
 * would always answer `null`, since install has long returned by then.
 */
export function installingModule(): ModuleId | null {
  return installing;
}

/** Charge `ms` to a module, striking once if that takes it over budget. */
export function charge(id: string | null, ms: number): void {
  if (id === null) return;
  const key = id as ModuleId;
  const total = (spent.get(key) ?? 0) + ms;
  spent.set(key, total);

  const budget = budgets.get(key);
  if (budget === undefined || struck.has(key) || total <= budget) return;
  struck.add(key);
  report?.(key, total);
}

/** What each module has actually cost this route. Exported for diagnostics. */
export function moduleWork(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, ms] of spent) out[id] = Math.round(ms * 10) / 10;
  return out;
}

/**
 * Close the current route and open the next one.
 *
 * main-world.content.ts calls this from `api.onPageChange` and on `pagehide`;
 * the registry has no plugin API of its own. Discourse fires the hook AFTER the
 * incoming page has rendered, not before: category-gate.ts queries
 * `.navigation-container` / `.topic-list` synchronously inside its handler and
 * inserts after them, which only works because the new DOM is already there.
 * So the first screen's decorator work for route N — the `decorateCookedElement`
 * calls Ember makes while painting it — is charged to window N−1, and window N
 * starts with what the hook and the watchers do after that. That is an
 * attribution lag of one boundary, not a fairness problem: strikes settle per
 * window either way, a window holding N's first screen on top of N−1's tail
 * still counts as one route for the consecutive rule, and the next window
 * opens clean. A watcher's trailing timer from the previous page
 * (search-signals.ts:99 waits 150ms) lands the same way, and is noise well
 * under any budget.
 *
 * Settling the persisted counters happens here and nowhere else. A module that
 * was not struck during the route that just ended has earned its clear; one
 * that was keeps the strike the bump already persisted. Either way the meter
 * starts the next route at zero.
 *
 * `onClosed` runs between the two: after the counters settle and before the
 * meter clears, so a `snapshot()` taken from it carries the closed route's
 * totals with the settled strike counts. main-world.content.ts pushes
 * diagnostics from there. It used to push after this returned, and every
 * route-end and pagehide push then read `workMs: 0` for every module — a
 * probe over the real registry showed the only push ever carrying a number was
 * the one from `onStrike` — so the popup and overlay read "0 / N ms" whenever
 * a route ended clean, which is the common case. The meter clears even if the
 * callback throws: a route's spend leaking into the next would strike it for
 * work it never did.
 */
export function resetRouteWork(onClosed?: () => void): void {
  routeEnd?.();
  try {
    onClosed?.();
  } finally {
    spent.clear();
    struck.clear();
  }
}

/**
 * Module lifecycle with a hard rule: a broken or slow feature disables itself
 * rather than degrading the forum.
 *
 * This exists because DevForum runs a `-dev` Discourse build that updates
 * frequently. Any given integration point can vanish between one page load and
 * the next, and when it does the correct behaviour is for that one feature to
 * go quiet — not for an exception to escape into Discourse's own render loop.
 */
export class ModuleRegistry {
  private readonly records = new Map<ModuleId, ModuleRecord>();

  constructor(private readonly opts: RegistryOptions) {
    /* The accounting above is module-level (see the note there), so the
     * instance hands it two closures rather than the helpers needing a registry
     * in hand: `report` turns going over budget into a strike whenever that
     * happens — usually long after install() has returned — and `routeEnd`
     * settles the counters when main-world.content.ts closes a route. */
    report = (id, ms) => this.strike(id, ms);
    routeEnd = () => this.endRoute();
  }

  install(mod: DfpModule): void {
    const strikes = this.opts.strikes[mod.id] ?? 0;
    const base = { id: mod.id, installMs: 0, workMs: 0, budgetMs: mod.budgetMs, strikes };

    if (!this.opts.isEnabled(mod.id)) {
      this.record({ ...base, status: "disabled-by-user" });
      return;
    }

    if (strikes >= STRIKES_TO_DISABLE) {
      this.record({ ...base, status: "auto-disabled" });
      return;
    }

    try {
      if (mod.isAvailable && !mod.isAvailable()) {
        this.record({ ...base, status: "unavailable" });
        return;
      }
    } catch (err) {
      this.record({ ...base, status: "unavailable", error: describe(err) });
      return;
    }

    try {
      /* The budget covers everything this module goes on to do, not the
       * registration that returns immediately. `installing` is what lets
       * decorate.ts and dom-watch.ts attribute their callbacks to whoever
       * registered them. */
      budgets.set(mod.id, mod.budgetMs);

      installing = mod.id;
      const { ms } = measure(`install:${mod.id}`, mod.install);
      installing = null;

      /* The persisted strike is NOT cleared here, and `strikes` is carried into
       * the record as read.
       *
       * It used to be cleared right here, "optimistically", on the theory that
       * a later strike would simply re-persist. But the only path that strikes
       * is charge(), which decorate.ts and dom-watch.ts reach long after this
       * returns — so every session went 0 → at most 1, STRIKES_TO_DISABLE was
       * unreachable, and the Options page showed "1/3 slow" for a chronically
       * slow module for as long as it stayed slow. The clear now happens in
       * endRoute(), once the route the module ran in has actually ended clean. */
      this.record({ ...base, status: "installed", installMs: ms });
    } catch (err) {
      installing = null;
      // A module that throws during install is dead for this page load, but
      // the exception stops here. It never reaches Discourse.
      this.record({ ...base, status: "failed", error: describe(err) });
    }
  }

  private strike(id: ModuleId, ms: number): void {
    /* Mirror the bump before reporting it, so a snapshot taken from inside
     * onStrike already carries the new count. */
    const rec = this.records.get(id);
    if (rec) rec.strikes += 1;
    this.opts.onStrike(id, ms);
  }

  private endRoute(): void {
    for (const rec of this.records.values()) {
      /* Only a module that ran can have earned a clear: one auto-disabled at
       * boot never did any work, and clearing it after the first route would
       * re-enable it on the next load without it ever having been measured. */
      if (rec.status !== "installed" || rec.strikes === 0 || struck.has(rec.id)) continue;
      rec.strikes = 0;
      this.opts.onClearStrike?.(rec.id);
    }
  }

  private record(record: ModuleRecord): void {
    this.records.set(record.id, record);
    this.opts.onRecord?.(record);
  }

  /** The live picture: status and strikes as recorded, work as charged so far this route. */
  snapshot(): ModuleRecord[] {
    return [...this.records.values()].map((rec) => ({
      ...rec,
      workMs: Math.round((spent.get(rec.id) ?? 0) * 10) / 10,
    }));
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err).slice(0, 300);
}
