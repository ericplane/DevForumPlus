import { MainBridge } from "../core/bridge/main";
import type { Diagnostics } from "../core/bridge/protocol";
import { ModuleRegistry, resetRouteWork } from "../core/registry";
import { isModuleEnabled, type DfpSettings, type ModuleId } from "../core/settings-schema";
import { bootstrap } from "../discourse/boot";
import { topicListSignals } from "../discourse/modules/topic-list-signals";
import { topicExcerpts } from "../discourse/modules/topic-excerpts";
import { chartTheme } from "../discourse/modules/chart-theme";
import { profileInfo } from "../discourse/modules/profile-info";
import { prefetch } from "../discourse/modules/prefetch";
import { warmCache } from "../discourse/modules/warm-cache";
import { codeIntel } from "../discourse/modules/code-intel";
import { codeChrome } from "../discourse/modules/code-chrome";
import { staleAnswer } from "../discourse/modules/stale-answer";
import { categoryGate } from "../discourse/modules/category-gate";
import { threadView } from "../discourse/modules/thread-view";
import { opPin } from "../discourse/modules/op-pin";
import { quietReplies } from "../discourse/modules/quiet-replies";
import { timelineMarks } from "../discourse/modules/timeline-marks";
import { postNumbers } from "../discourse/modules/post-numbers";
import { assetPreview } from "../discourse/modules/asset-preview";
import { topicPreview } from "../discourse/modules/topic-preview";
import { docsLinks } from "../discourse/modules/docs-links";
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

  /* Diagnostics are a snapshot of the registry, taken whenever the picture
   * changes, rather than a list of records collected once at install.
   *
   * The install-time list was pushed exactly once, and install is the one
   * moment nothing has happened yet: every module's install() returns in ~0ms
   * and its real cost — decorator sweeps, DOM watchers — is charged later, as
   * is any strike. So the popup showed "0.0 ms" and a green pill for a module
   * that had struck minutes ago. `snapshot()` carries the work charged this
   * route and the live strike count; it is re-pushed from the three places
   * that change it, below. */
  const pushDiagnostics = () =>
    bridge.pushDiagnostics({
      rung: outcome.rung,
      pluginApiVersion: outcome.pluginApiVersion,
      bootMs: outcome.bootMs,
      modules: registry.snapshot(),
      notes: outcome.notes,
    });

  const registry = new ModuleRegistry({
    strikes,
    isEnabled: (id: ModuleId) => isModuleEnabled(settings as DfpSettings, id),
    onStrike: (id, ms) => {
      bridge.bumpStrike(id, ms);
      pushDiagnostics();
    },
    onClearStrike: (id) => bridge.clearStrike(id),
  });

  registry.install(topicListSignals(api));
  // Same registry, same value-transformer mechanism as topic-list-signals: one
  // registration that asks Discourse to render the excerpt it already sent.
  // An unknown-transformer throw is deliberately left to the registry, which
  // records `failed` where the popup can show it.
  registry.install(topicExcerpts(api));
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
  registry.install(opPin(api));
  registry.install(quietReplies(api));
  // Topic-page modules on onPageChange / onDomChange / decorateCooked; no
  // bridge messages, no chrome.*.
  registry.install(timelineMarks(api));
  registry.install(postNumbers(api));
  registry.install(assetPreview(api));
  registry.install(topicPreview(api));
  registry.install(docsLinks(api));
  registry.install(profileGroups(api));
  registry.install(cardGroups(api));
  registry.install(postGroups(api));
  registry.install(facepile(api));
  registry.install(searchSignals(api));

  pushDiagnostics();

  /* Route boundaries. The registry budgets per route and settles the persisted
   * strike counters when one ends, but it has no plugin API of its own — the
   * api is in hand here, so this is where the boundary is wired. `onPageChange`
   * does not fire for the load that brought us here (category-gate.ts), which
   * is right: the initial load is the first route, and the first transition
   * closes it.
   *
   * The push goes through `resetRouteWork`'s callback, which runs after the
   * strike counters settle and before the meter clears, so it carries the
   * closed route's totals. Calling pushDiagnostics() after resetRouteWork()
   * returned — the previous shape — pushed a snapshot of an empty meter: a
   * probe over the real registry showed the install push and every route-end
   * push at workMs 0, so the popup and overlay read "0 / N ms" unless a module
   * had struck since. What they show between routes is therefore the LAST
   * route's work; a strike re-pushes mid-route with this one's so far.
   *
   * `pagehide` closes the last route. A hard navigation away does not promise
   * to deliver a MessagePort task queued during unload, so the clear and the
   * push this sends are best-effort; losing them leaves a strike on record one
   * route longer than earned, which is the safe direction. */
  const endRoute = () => resetRouteWork(pushDiagnostics);
  api.onPageChange(endRoute);
  window.addEventListener("pagehide", endRoute);
}
