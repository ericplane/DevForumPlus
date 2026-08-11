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
  /** Wall-clock cost of install(), in ms. */
  installMs: number;
  /** Consecutive budget violations carried over from previous page loads. */
  strikes: number;
  error?: string;
}

export interface DfpModule {
  id: ModuleId;
  /**
   * Main-thread budget for one page load, in ms. Exceeding it three loads
   * running auto-disables the module.
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
  onStrike: (id: ModuleId, installMs: number) => void;
  /** Called when a module installs within budget, so strikes stay consecutive. */
  onClearStrike?: (id: ModuleId) => void;
  /** Fired on any status change, so the popup can show the truth. */
  onRecord: (record: ModuleRecord) => void;
}

const STRIKES_TO_DISABLE = 3;

// ── Work accounting ─────────────────────────────────────────────────────────
//
// Module-level rather than instance state because the helpers that charge time
// — decorate.ts, dom-watch.ts — are plain functions with no registry in hand,
// and there is exactly one registry per page.

/** Set only while a module's `install()` is on the stack. */
let installing: ModuleId | null = null;

/** ms of main-thread time charged to each module since boot. */
const spent = new Map<ModuleId, number>();
const budgets = new Map<ModuleId, number>();
/** One strike per page load: a module over budget stays over budget. */
const struck = new Set<ModuleId>();
let report: ((id: ModuleId, ms: number) => void) | null = null;

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

/** What each module has actually cost this page. Exported for diagnostics. */
export function moduleWork(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, ms] of spent) out[id] = Math.round(ms * 10) / 10;
  return out;
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

  constructor(private readonly opts: RegistryOptions) {}

  install(mod: DfpModule): void {
    const strikes = this.opts.strikes[mod.id] ?? 0;

    if (!this.opts.isEnabled(mod.id)) {
      this.record({ id: mod.id, status: "disabled-by-user", installMs: 0, strikes });
      return;
    }

    if (strikes >= STRIKES_TO_DISABLE) {
      this.record({ id: mod.id, status: "auto-disabled", installMs: 0, strikes });
      return;
    }

    try {
      if (mod.isAvailable && !mod.isAvailable()) {
        this.record({ id: mod.id, status: "unavailable", installMs: 0, strikes });
        return;
      }
    } catch (err) {
      this.record({
        id: mod.id,
        status: "unavailable",
        installMs: 0,
        strikes,
        error: describe(err),
      });
      return;
    }

    try {
      /* The budget covers everything this module goes on to do, not the
       * registration that returns immediately. `installing` is what lets
       * decorate.ts and dom-watch.ts attribute their callbacks to whoever
       * registered them; `report` turns going over into a strike whenever that
       * happens — usually long after this function has returned. */
      budgets.set(mod.id, mod.budgetMs);
      report = (id, ms) => this.opts.onStrike(id, ms);

      installing = mod.id;
      const { ms } = measure(`install:${mod.id}`, mod.install);
      installing = null;

      /* Cleared optimistically. A module that goes over budget later in the
       * page strikes then, and a strike is persisted immediately — so the
       * counter cannot be cleared and re-earned in the wrong order. */
      if (strikes > 0) this.opts.onClearStrike?.(mod.id);
      this.record({ id: mod.id, status: "installed", installMs: ms, strikes: 0 });
    } catch (err) {
      installing = null;
      // A module that throws during install is dead for this page load, but
      // the exception stops here. It never reaches Discourse.
      this.record({
        id: mod.id,
        status: "failed",
        installMs: 0,
        strikes,
        error: describe(err),
      });
    }
  }

  private record(record: ModuleRecord): void {
    this.records.set(record.id, record);
    this.opts.onRecord(record);
  }

  snapshot(): ModuleRecord[] {
    return [...this.records.values()];
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err).slice(0, 300);
}
