import { MainBridge } from "../core/bridge/main";
import type { Diagnostics } from "../core/bridge/protocol";
import { ModuleRegistry, type ModuleRecord } from "../core/registry";
import { isModuleEnabled, type DfpSettings, type ModuleId } from "../core/settings-schema";
import { bootstrap } from "../discourse/boot";
import { topicListSignals } from "../discourse/modules/topic-list-signals";
import { chartTheme } from "../discourse/modules/chart-theme";
import { profileInfo } from "../discourse/modules/profile-info";
import { prefetch } from "../discourse/modules/prefetch";
import { warmCache } from "../discourse/modules/warm-cache";
import { codeIntel } from "../discourse/modules/code-intel";
import { codeChrome } from "../discourse/modules/code-chrome";
import { staleAnswer } from "../discourse/modules/stale-answer";
import { categoryGate } from "../discourse/modules/category-gate";
import { threadView } from "../discourse/modules/thread-view";
import { cardGroups } from "../discourse/modules/card-groups";
import { facepile } from "../discourse/modules/facepile";
import { searchSignals } from "../discourse/modules/search-signals";
import { postGroups } from "../discourse/modules/post-groups";
import { profileGroups } from "../discourse/modules/profile-groups";
import { mark } from "../core/perf";

/**
 * MAIN-world content script.
 *
 * Runs in the page's JS world, which is the only place Discourse's module
 * loader and plugin API are reachable. It has no chrome.* access whatsoever —
 * anything needing extension APIs goes over the bridge to the isolated world.
 *
 * This file is on the critical path of every page load. Keep it small, keep it
 * synchronous where it matters, and never let it throw into the page.
 */
export default defineContentScript({
  matches: ["https://devforum.roblox.com/*"],
  runAt: "document_start",
  world: "MAIN",
  allFrames: false,

  main() {
    // Guard against double injection (extension reload, SPA edge cases).
    if (window.__dfpInstalled) return;
    window.__dfpInstalled = true;

    mark("main-world:start");

    const bridge = new MainBridge();

    bootstrap({
      onReady(outcome) {
        mark(`main-world:boot:${outcome.rung}`);

        if (outcome.rung === "css-only" || !outcome.api) {
          bridge.pushDiagnostics({
            rung: "css-only",
            pluginApiVersion: outcome.pluginApiVersion,
            bootMs: outcome.bootMs,
            modules: [],
            notes: outcome.notes,
          });
          return;
        }

        void installModules(bridge, outcome.api, outcome).catch(() => {
          // Nothing above this point may reach Discourse as an exception.
        });
      },
    });
  },
});

async function installModules(
  bridge: MainBridge,
  api: NonNullable<Parameters<typeof topicListSignals>[0]>,
  outcome: { rung: Diagnostics["rung"]; pluginApiVersion: string | null; bootMs: number; notes: string[] },
): Promise<void> {
  // Settings and strike counts both live behind the bridge. Fetching them in
  // parallel keeps the gap between boot and install as short as possible.
  const [settings, strikes] = await Promise.all([bridge.getSettings(), bridge.getStrikes()]);

  if (!settings.enabled) {
    bridge.pushDiagnostics({
      rung: outcome.rung,
      pluginApiVersion: outcome.pluginApiVersion,
      bootMs: outcome.bootMs,
      modules: [],
      notes: [...outcome.notes, "disabled by user"],
    });
    return;
  }

  const records: ModuleRecord[] = [];
  const registry = new ModuleRegistry({
    strikes,
    isEnabled: (id: ModuleId) => isModuleEnabled(settings as DfpSettings, id),
    onStrike: (id, ms) => bridge.bumpStrike(id, ms),
    onClearStrike: (id) => bridge.clearStrike(id),
    onRecord: (record) => records.push(record),
  });

  registry.install(topicListSignals(api));
  // Not a plugin-API module — it wraps the page's own Chart.js global, which is
  // only reachable from the main world. See discourse/modules/chart-theme.ts.
  registry.install(chartTheme());
  registry.install(profileInfo(api));
  // Transport-level, not plugin-API — see discourse/modules/prefetch.ts for why
  // wrapping `discourse/lib/ajax` is impossible.
  registry.install(warmCache());
  registry.install(prefetch());
  registry.install(codeIntel(api));
  registry.install(codeChrome(api));
  registry.install(staleAnswer(api));
  registry.install(categoryGate(api));
  registry.install(threadView(api));
  registry.install(profileGroups(api));
  registry.install(cardGroups(api));
  registry.install(postGroups(api));
  registry.install(facepile(api));
  registry.install(searchSignals(api));

  bridge.pushDiagnostics({
    rung: outcome.rung,
    pluginApiVersion: outcome.pluginApiVersion,
    bootMs: outcome.bootMs,
    modules: records,
    notes: outcome.notes,
  });
}
