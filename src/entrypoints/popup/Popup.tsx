import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { getSettings, resetSettings, setSettings } from "../../core/settings";
import {
  DENSITIES,
  FONT_SCALE_LABELS,
  FONT_SCALES,
  MOTIONS,
  RADII,
  THEMES,
  WIDTH_NOTE,
  WIDTHS,
  fontScaleLabel,
  type DfpSettings,
} from "../../core/settings-schema";
import { clearStrikes, readDiagnostics } from "../../core/bridge/isolated";
import type { BootRung, Diagnostics } from "../../core/bridge/protocol";
import { Segmented } from "../shared/Segmented";

/** Boot rung → how it should read to a user who does not know the internals. */
const RUNG_INFO: Record<BootRung, { label: string; tone: string; note: string }> = {
  "pre-boot": {
    label: "Full",
    tone: "good",
    note: "Hooked in before the forum rendered. Everything is active from the first frame.",
  },
  "post-boot": {
    label: "Recovered",
    tone: "warn",
    note: "The early hook did not fire, so DFP attached after the page loaded. Features work from the first navigation; the very first list you saw was unmodified.",
  },
  "css-only": {
    label: "Styles only",
    tone: "bad",
    note: "Could not reach Discourse's plugin API — likely a forum update. The redesign still works; interactive features are off.",
  },
};

/**
 * The origin both content scripts run on. Already in host_permissions, so
 * asking for it again declares nothing new — it only matters on a browser that
 * treats host permissions as opt-in (Firefox by default, Chromium when the
 * user has set site access to "on click").
 */
const FORUM_ORIGINS = ["https://devforum.roblox.com/*"];

/**
 * Whether the browser will run DFP on the forum at all.
 *
 * `"unknown"` covers a permissions API that is missing or throws; the popup
 * then behaves as before rather than accusing the browser of withholding
 * access it may well have granted.
 */
type HostAccess = "granted" | "missing" | "unknown";

async function hostAccess(): Promise<HostAccess> {
  try {
    return (await chrome.permissions.contains({ origins: FORUM_ORIGINS })) ? "granted" : "missing";
  } catch {
    return "unknown";
  }
}

/**
 * The trim switch drives a declarativeNetRequest ruleset, and the Firefox
 * manifest deliberately declares neither the permission nor the ruleset
 * (wxt.config.ts). The namespace is only present when the permission is, so
 * this is the honest test — without it the switch rendered on Firefox, saved a
 * setting, and changed nothing.
 */
const canTrimNetwork = typeof chrome.declarativeNetRequest !== "undefined";

/* The Text-size ramp (FONT_SCALES, FONT_SCALE_LABELS, fontScaleLabel) and the
 * width glosses (WIDTH_NOTE) used to be defined here, the only settings
 * constants that lived in an entrypoint. They sit in settings-schema.ts beside
 * WIDTHS now, so the control's ends and normalizeSettings' clamp are one pair
 * of numbers and the options page renders the same rows from the same table. */

export function Popup(): JSX.Element {
  const [settings, setLocal] = useState<DfpSettings | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [host, setHost] = useState<HostAccess>("unknown");
  const version = chrome.runtime.getManifest().version;

  useEffect(() => {
    void getSettings().then(setLocal);
    void readDiagnostics().then(setDiag);
    void hostAccess().then(setHost);
  }, []);

  const grantAccess = async () => {
    /* Must run from the click itself: `permissions.request` needs a user
     * gesture, and an await before it would spend that gesture. */
    try {
      await chrome.permissions.request({ origins: FORUM_ORIGINS });
    } catch {
      // Declined, or the prompt could not be shown. The re-check below says which.
    }
    setHost(await hostAccess());
  };

  const update = async (patch: Partial<DfpSettings>) => {
    // Optimistic: the popup is the only writer while it is open, and waiting
    // on a storage round trip makes the segmented controls feel broken.
    setLocal((s) => (s ? { ...s, ...patch } : s));
    setLocal(await setSettings(patch));
  };

  if (!settings) return <div class="app" />;

  const rung = diag ? RUNG_INFO[diag.rung] : null;

  return (
    <div class="app">
      <header class="head">
        <span class="title">DevForum Plus</span>
        <span class="version">v{version}</span>
      </header>

      <div class="master">
        <label for="dfp-enabled">Enabled</label>
        <input
          id="dfp-enabled"
          class="switch"
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void update({ enabled: e.currentTarget.checked })}
        />
      </div>

      <Segmented
        label="Theme"
        options={THEMES}
        value={settings.theme}
        onPick={(theme) => void update({ theme })}
      />
      <Segmented
        label="Density"
        options={DENSITIES}
        value={settings.density}
        onPick={(density) => void update({ density })}
      />
      <Segmented
        label="Corners"
        options={RADII}
        value={settings.radius}
        onPick={(radius) => void update({ radius })}
      />
      <Segmented
        label="Width"
        options={WIDTHS}
        value={settings.width}
        onPick={(width) => void update({ width })}
        describe={(width) => WIDTH_NOTE[width]}
      />
      <Segmented
        label="Motion"
        options={MOTIONS}
        value={settings.motion}
        onPick={(motion) => void update({ motion })}
      />
      {/* Applies live, like the rows above: isolated.content.ts re-stamps
          --dfp-font-scale from onSettingsChanged, so the forum tab behind the
          popup resizes as the button is pressed. */}
      <Segmented
        label="Text size"
        options={FONT_SCALE_LABELS}
        value={fontScaleLabel(settings.fontScale)}
        onPick={(label) => void update({ fontScale: FONT_SCALES[label] })}
        describe={(label) => `${Math.round(FONT_SCALES[label] * 100)}%`}
      />

      {canTrimNetwork && (
        <div class="master">
          <label for="dfp-trim-footer">
            Trim Roblox footer script
            <span class="hint">Blocks a decorative bundle. Never touches consent or age checks.</span>
          </label>
          <input
            id="dfp-trim-footer"
            class="switch"
            type="checkbox"
            checked={settings.trimNetwork["lite-footer"] === true}
            onChange={(e) =>
              void update({
                trimNetwork: {
                  ...settings.trimNetwork,
                  "lite-footer": e.currentTarget.checked,
                },
              })
            }
          />
        </div>
      )}

      <section class="diag">
        <div class="diag-row">
          <span class="label">Integration</span>
          <span class={`pill ${rung ? rung.tone : host === "missing" ? "bad" : "idle"}`}>
            {rung ? rung.label : host === "missing" ? "Not allowed" : "No data"}
          </span>
        </div>

        {rung ? (
          <p class="note">{rung.note}</p>
        ) : host === "missing" ? (
          /* Distinct from the idle note below on purpose. On Firefox the host
           * permission is opt-in and until it is granted neither content
           * script runs — and the only text the popup had for that state was
           * the same "open a tab" line it shows when everything is fine. */
          <>
            <p class="note">
              This browser has not let DFP run on devforum.roblox.com yet, so
              nothing loads there. Grant access, then reload any open forum tab.
            </p>
            <button class="btn" onClick={() => void grantAccess()}>
              Grant access
            </button>
          </>
        ) : (
          <p class="note">
            Open a devforum.roblox.com tab and reopen this popup to see how DFP
            attached.
          </p>
        )}

        {diag && (
          <>
            <dl class="diag-row">
              <dt>Plugin API</dt>
              <dd class="mono">{diag.pluginApiVersion ?? "unavailable"}</dd>
            </dl>
            <dl class="diag-row">
              <dt>Boot time</dt>
              <dd>{diag.bootMs.toFixed(0)} ms</dd>
            </dl>

            {diag.modules.length > 0 && (
              <ul class="modules">
                {/* Work charged against the module's budget — the number the
                    registry actually strikes on. Between routes it is the LAST
                    route's total, pushed from the route-close callback
                    (main-world.content.ts); a strike re-pushes mid-route with
                    the current one's so far. This printed `installMs` before,
                    which is ~0 for every module by design (registry.ts), so
                    the list read "0.0 ms" all the way down however slow a
                    module was. */}
                {diag.modules.map((m) => (
                  <li key={m.id}>
                    <span class="mono">{m.id}</span>
                    <span
                      class={`pill ${
                        m.status === "installed"
                          ? m.workMs > m.budgetMs
                            ? "bad"
                            : m.strikes > 0
                              ? "warn"
                              : "good"
                          : m.status === "failed" || m.status === "auto-disabled"
                            ? "bad"
                            : "idle"
                      }`}
                      title={
                        m.status === "installed" && m.strikes > 0
                          ? `${m.strikes}/3 slow routes running; disables itself at 3`
                          : undefined
                      }
                    >
                      {m.status === "installed"
                        ? `${m.workMs.toFixed(0)} / ${m.budgetMs} ms`
                        : m.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* Surfaced rather than swallowed: when a Discourse update breaks a
                hook, this is the line that explains why something stopped. */}
            {diag.notes.length > 0 && (
              <p class="note mono">{diag.notes.join(" · ")}</p>
            )}
          </>
        )}
      </section>

      <footer class="foot">
        {/* A direct call: the popup is an extension page. The `dfp:open-options`
            message background.ts answers exists for the onboarding card, which
            runs as a content script and cannot make this call — and that card
            is shown once, ever, so once it was dismissed the only in-product
            route to the feature list was the toolbar icon's context menu. */}
        <button
          class="btn btn--row"
          onClick={() => {
            void chrome.runtime.openOptionsPage().catch(() => {});
          }}
        >
          All settings
        </button>
        <button
          class="btn"
          onClick={() => {
            void clearStrikes().then(() => setDiag(null));
          }}
        >
          Re-enable modules
        </button>
        <button
          class="btn"
          onClick={() => {
            void resetSettings().then(setLocal);
          }}
        >
          Reset
        </button>
      </footer>
    </div>
  );
}
