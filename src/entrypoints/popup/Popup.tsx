import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { getSettings, resetSettings, setSettings } from "../../core/settings";
import {
  DENSITIES,
  MOTIONS,
  RADII,
  THEMES,
  type DfpSettings,
} from "../../core/settings-schema";
import { clearStrikes, readDiagnostics } from "../../core/bridge/isolated";
import type { BootRung, Diagnostics } from "../../core/bridge/protocol";

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

export function Popup(): JSX.Element {
  const [settings, setLocal] = useState<DfpSettings | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const version = chrome.runtime.getManifest().version;

  useEffect(() => {
    void getSettings().then(setLocal);
    void readDiagnostics().then(setDiag);
  }, []);

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
        label="Motion"
        options={MOTIONS}
        value={settings.motion}
        onPick={(motion) => void update({ motion })}
      />

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

      <section class="diag">
        <div class="diag-row">
          <span class="label">Integration</span>
          <span class={`pill ${rung ? rung.tone : "idle"}`}>
            {rung ? rung.label : "No data"}
          </span>
        </div>

        {rung ? (
          <p class="note">{rung.note}</p>
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
                {diag.modules.map((m) => (
                  <li key={m.id}>
                    <span class="mono">{m.id}</span>
                    <span
                      class={`pill ${
                        m.status === "installed"
                          ? "good"
                          : m.status === "failed" || m.status === "auto-disabled"
                            ? "bad"
                            : "idle"
                      }`}
                    >
                      {m.status === "installed"
                        ? `${m.installMs.toFixed(1)} ms`
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

function Segmented<T extends string>(props: {
  label: string;
  options: readonly T[];
  value: T;
  onPick: (value: T) => void;
}): JSX.Element {
  return (
    <div class="field">
      <span class="label" id={`lbl-${props.label}`}>
        {props.label}
      </span>
      <div class="seg" role="group" aria-labelledby={`lbl-${props.label}`}>
        {props.options.map((opt) => (
          <button
            key={opt}
            type="button"
            aria-pressed={opt === props.value}
            onClick={() => props.onPick(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}
