import { IsolatedBridge } from "../core/bridge/isolated";
import { readBootSnapshot, writeBootSnapshot } from "../core/boot-snapshot";
import { attrsFor, stampFontScale, stampRoot } from "../core/root-attrs";
import { getSettings, onSettingsChanged } from "../core/settings";
import type { DfpSettings } from "../core/settings-schema";
import type { Diagnostics } from "../core/bridge/protocol";
import { mark } from "../core/perf";
import { mountPerfOverlay, startVitals } from "../core/perf-overlay";
import { mountDocsCards } from "../isolated/docs-card";
import { mountCommandPalette } from "../isolated/command-palette";
import { mountComposer } from "../isolated/composer";
import { mountOnboarding } from "../isolated/onboarding";

// Injected into the manifest's content_scripts[].css, which means the browser
// applies it before this script runs — no flash, no runtime <style> insertion,
// and it keeps working if every line of JS below fails.
import "../styles/index.css";

/**
 * ISOLATED-world content script.
 *
 * Owns three things: stamping the root element before first paint, the
 * chrome.* side of the bridge, and (later) all DFP-rendered UI.
 */
export default defineContentScript({
  matches: ["https://devforum.roblox.com/*"],
  runAt: "document_start",
  cssInjectionMode: "manifest",
  allFrames: false,

  main() {
    mark("isolated:start");

    // Observers must be registered before the events they watch, so vitals
    // collection starts unconditionally even when the overlay is not shown.
    startVitals();

    // 1. Synchronous, before paint. The snapshot is a cache of the paint-
    //    affecting settings; being one page load stale is harmless, being
    //    async is not.
    const snapshot = readBootSnapshot();
    apply(snapshot);

    // 2. Bridge up immediately so the main world is never left waiting.
    let latestDiagnostics: Diagnostics | null = null;
    new IsolatedBridge({ onDiagnostics: (d) => (latestDiagnostics = d) });

    /* Each mount is isolated, so one throwing cannot take the others with it.
     *
     * They used to be bare calls in sequence. A single unbound
     * `requestIdleCallback` inside the docs-card mount — legal in Chrome, a
     * TypeError in Firefox — therefore killed the ⌘K palette, the composer
     * helpers and the onboarding card, none of which touch idle callbacks. The
     * symptom was "the palette does not work on Firefox", four steps from the
     * cause, with nothing in the page console.
     *
     * The MAIN world has had this guarantee since the start: ModuleRegistry
     * wraps every install so a broken feature disables itself and nothing else.
     * This is the same rule, finally applied on this side of the bridge. */
    const step = (name: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        // Never rethrow into the page, and never stop the remaining mounts.
        console.warn(`[DFP] ${name} failed to mount`, err);
      }
    };

    // 3. `?dfp-perf=1` — budgets from PLAN.md §4.1, measured live rather than
    //    asserted in a README.
    step("perf-overlay", () => mountPerfOverlay(() => latestDiagnostics));

    // 4. Creator Docs hover cards. Delegated listeners only, so this costs
    //    nothing until someone actually hovers an API name that MAIN resolved.
    step("docs-cards", mountDocsCards);

    // 5. ⌘K. One keydown listener until it is actually opened.
    step("command-palette", mountCommandPalette);

    // 6. Composer: duplicate detection, draft vault, Luau block button.
    step("composer", mountComposer);

    // 7. First-run card. One storage read, then nothing.
    step("onboarding", mountOnboarding);

    // 8. Reconcile with the real settings once storage resolves.
    void getSettings().then((settings) => {
      apply(settings);
      writeBootSnapshot(settings);
    });

    onSettingsChanged((settings) => {
      apply(settings);
      writeBootSnapshot(settings);
    });

    // 9. `theme: "auto"` has to track the OS, not just the last stamp.
    matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      void getSettings().then(apply);
    });
  },
});

function apply(settings: DfpSettings): void {
  stampRoot(attrsFor(settings));
  stampFontScale(settings.fontScale);
}
