import type { BootRung } from "../core/bridge/protocol";
import type {
  AmdDefine,
  AmdRequire,
  EmberInitializer,
  PluginApi,
  PluginApiModule,
} from "./types";

const PLUGIN_API_MODULE = "discourse/lib/plugin-api";
const REQUIRED_API_VERSION = "2.1.1";

/** Both names are registered; whichever Ember reaches first wins. */
const INITIALIZER_MODULES = [
  "discourse/pre-initializers/dfp-boot",
  "discourse/initializers/dfp-boot",
] as const;

export interface BootOutcome {
  rung: BootRung;
  api: PluginApi | null;
  pluginApiVersion: string | null;
  bootMs: number;
  notes: string[];
}

export interface BootOptions {
  /** Called exactly once, as soon as a usable plugin API exists. */
  onReady: (outcome: BootOutcome) => void;
  /** How long to keep trying before declaring CSS-only mode. */
  timeoutMs?: number;
}

/**
 * Get DFP into Discourse's client app.
 *
 * Why a ladder rather than one approach:
 *
 *   Rung 1 — pre-boot. We register an Ember initializer in the AMD module
 *     registry before the app boots, exactly the way a theme component does.
 *     This is the only rung that catches the *first* render, so it is the only
 *     one where the initial topic list already carries our classes.
 *
 *   Rung 2 — post-boot. Verified empirically against the live forum: calling
 *     `withPluginApi` after boot registers transformers successfully; they
 *     simply do not apply retroactively to already-rendered components. So the
 *     cost of falling back here is one unstyled first paint of a list, and
 *     everything is correct from the first SPA navigation onward. That makes
 *     rung 2 a genuinely acceptable outcome, not a disaster.
 *
 *   Rung 3 — CSS-only. No plugin API at all. The entire visual layer still
 *     works, because it is pure CSS keyed off attributes stamped by the
 *     isolated world. We report it so the popup can say so honestly.
 *
 * A watchdog verifies rung 1 actually ran rather than assuming it did — if
 * Discourse ever stops scanning the loader registry for initializers, rung 2
 * takes over on its own with no code change here.
 */
export function bootstrap(opts: BootOptions): void {
  const t0 = performance.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const notes: string[] = [];

  let settled = false;
  const settle = (rung: BootRung, api: PluginApi | null, version: string | null) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    clearTimeout(giveUp);
    opts.onReady({
      rung,
      api,
      pluginApiVersion: version,
      bootMs: performance.now() - t0,
      notes,
    });
  };

  const enter = (rung: Exclude<BootRung, "css-only">): boolean => {
    const mod = readPluginApiModule();
    if (!mod) return false;
    let entered = false;
    try {
      mod.withPluginApi(REQUIRED_API_VERSION, (api) => {
        entered = true;
        settle(rung, api, mod.PLUGIN_API_VERSION ?? null);
      });
    } catch (err) {
      notes.push(`withPluginApi threw on ${rung}: ${describe(err)}`);
      return false;
    }
    if (!entered) notes.push(`withPluginApi callback never fired on ${rung}`);
    return entered;
  };

  // ── Rung 1 ────────────────────────────────────────────────────────────────
  trapDefine((define) => {
    const initializer: EmberInitializer = {
      name: "dfp-boot",
      // Runs after Discourse has wired up its own objects but before the
      // application renders, which is the window we need.
      after: "inject-objects",
      initialize() {
        if (!enter("pre-boot")) {
          notes.push("pre-boot initializer ran but the plugin API was not ready");
        }
      },
    };

    for (const name of INITIALIZER_MODULES) {
      try {
        define(name, [], () => ({ default: initializer }));
      } catch (err) {
        notes.push(`define(${name}) failed: ${describe(err)}`);
      }
    }
  }, notes);

  // ── Rung 2 ────────────────────────────────────────────────────────────────
  // Polls rather than trusting rung 1, so a silent failure self-heals.
  const poll = setInterval(() => {
    if (settled) return;
    if (enter("post-boot")) {
      notes.push("pre-boot hook did not fire; recovered post-boot");
    }
  }, 150);

  // ── Rung 3 ────────────────────────────────────────────────────────────────
  const giveUp = setTimeout(() => {
    notes.push(`no plugin API after ${timeoutMs}ms`);
    settle("css-only", null, null);
  }, timeoutMs);
}

function readPluginApiModule(): PluginApiModule | null {
  const req = window.require as AmdRequire | undefined;
  if (typeof req !== "function") return null;
  try {
    const mod = req(PLUGIN_API_MODULE) as PluginApiModule | undefined;
    return mod && typeof mod.withPluginApi === "function" ? mod : null;
  } catch {
    // Module not registered yet. Normal during early boot.
    return null;
  }
}

/**
 * Run `fn` with Discourse's AMD `define` as soon as it exists.
 *
 * At document_start the loader has usually not been evaluated yet, so we
 * intercept the assignment. The trap removes itself immediately after firing —
 * leaving an accessor on `window.define` for the lifetime of the page would be
 * a needless way to break someone else's code.
 */
function trapDefine(fn: (define: AmdDefine) => void, notes: string[]): void {
  const existing = window.define;
  if (typeof existing === "function") {
    fn(existing);
    return;
  }

  try {
    let stored: AmdDefine | undefined;
    Object.defineProperty(window, "define", {
      configurable: true,
      enumerable: true,
      get: () => stored,
      set(value: AmdDefine) {
        stored = value;
        // Restore a plain data property before doing anything else, so we are
        // out of the way even if `fn` throws.
        Object.defineProperty(window, "define", {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        if (typeof value === "function") {
          try {
            fn(value);
          } catch (err) {
            notes.push(`define trap callback failed: ${describe(err)}`);
          }
        }
      },
    });
  } catch (err) {
    // Some other extension may have already made `define` non-configurable.
    notes.push(`could not trap window.define: ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err).slice(0, 200);
}
