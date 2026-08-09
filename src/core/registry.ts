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
  /** Install budget in ms. Exceeding it three loads running auto-disables. */
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
      const { ms } = measure(`install:${mod.id}`, mod.install);
      if (ms > mod.budgetMs) {
        this.opts.onStrike(mod.id, ms);
        this.record({ id: mod.id, status: "installed", installMs: ms, strikes: strikes + 1 });
      } else {
        // `strikes: 0` here only ever reached the in-memory diagnostic record;
        // the persisted counter was write-only-upward. Clear it for real.
        if (strikes > 0) this.opts.onClearStrike?.(mod.id);
        this.record({ id: mod.id, status: "installed", installMs: ms, strikes: 0 });
      }
    } catch (err) {
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
