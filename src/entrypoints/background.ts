import {
  DEFAULT_SETTINGS,
  TRIM_RULESETS,
  normalizeSettings,
  type DfpSettings,
} from "../core/settings-schema";

/**
 * Service worker.
 *
 * Deliberately near-empty for M0/M1. Its only current jobs are seeding default
 * settings and opening up `chrome.storage.session` so content scripts can write
 * diagnostics to it — session storage defaults to trusted contexts only, so
 * without this the bridge's `diag:push` would fail silently.
 */
/**
 * Network trimming is enabled per-ruleset from settings and never by default.
 *
 * The baseline measurement is the honest context here: first load on this forum
 * is server-bound — 2427ms of the 2716ms to first paint is TTFB — so removing a
 * decorative script saves real bytes but very little wall-clock. It is offered
 * because some people want it, not because it is the win.
 */
async function syncTrimRulesets(settings: DfpSettings): Promise<void> {
  try {
    const enable: string[] = [];
    const disable: string[] = [];
    for (const id of TRIM_RULESETS) {
      (settings.trimNetwork[id] === true ? enable : disable).push(id);
    }
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enable,
      disableRulesetIds: disable,
    });
  } catch {
    // Older Chromium, or the ruleset failed to parse. Trimming simply stays
    // off; nothing else depends on it.
  }
}

export default defineBackground(() => {
  // Must be called on every worker start, not just on install: access level is
  // per-session, and the worker is torn down and restarted constantly.
  chrome.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch(() => {
      // Older Chromium, or already set. Diagnostics degrade to unavailable.
    });

  // Rulesets are session-independent but settings can change from any surface,
  // so reconcile on start and on every write.
  void chrome.storage.sync.get("settings").then((stored) =>
    syncTrimRulesets(normalizeSettings(stored["settings"])),
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes["settings"]) return;
    void syncTrimRulesets(normalizeSettings(changes["settings"].newValue));
  });

  /* `chrome.runtime.openOptionsPage` exists only in an extension context, so
   * the onboarding card in the content script asks for it by message rather
   * than the content script needing any extra capability. The message shape is
   * checked because content scripts share an origin with the page. */
  chrome.runtime.onMessage.addListener((msg: unknown) => {
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { t?: unknown }).t === "dfp:open-options"
    ) {
      void chrome.runtime.openOptionsPage().catch(() => {});
    }
    // No async response; returning false keeps the channel from being held open.
    return false;
  });

  chrome.runtime.onInstalled.addListener(async (details) => {
    const stored = await chrome.storage.sync.get("settings");
    if (stored["settings"] === undefined) {
      await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    } else {
      // Re-normalize on update so a schema change can never leave a user
      // stranded on an unreadable settings object.
      await chrome.storage.sync.set({
        settings: normalizeSettings(stored["settings"]),
      });
    }

    if (details.reason === "install") {
      // Strike counters are meaningless across a fresh install.
      await chrome.storage.local.remove("moduleStrikes");
    }
  });
});
