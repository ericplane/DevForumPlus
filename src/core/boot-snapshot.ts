import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type DfpSettings,
} from "./settings-schema";

/**
 * The first-paint problem.
 *
 * `chrome.storage` is async. If we wait for it before stamping <html>, the user
 * sees the stock forum for a frame or two and then a jarring repaint. That is
 * the single most common way an extension like this feels cheap.
 *
 * Content scripts share the page's origin, so they share its `localStorage` —
 * which is synchronous. We mirror the handful of paint-affecting settings there
 * on every write and read them back at `document_start`, before the browser has
 * painted anything.
 *
 * The snapshot is a cache, never the source of truth. chrome.storage.sync wins
 * the moment it resolves, and a missing or corrupt snapshot just means we fall
 * back to defaults for one frame.
 */

const KEY = "dfp:boot";

/** Only the fields that change what the first frame looks like. */
type Snapshot = Pick<
  DfpSettings,
  "enabled" | "theme" | "density" | "motion" | "radius" | "width" | "fontScale"
>;

export function readBootSnapshot(): DfpSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    // Private mode, disabled storage, quota, malformed JSON — all non-fatal.
    return DEFAULT_SETTINGS;
  }
}

export function writeBootSnapshot(settings: DfpSettings): void {
  const snap: Snapshot = {
    enabled: settings.enabled,
    theme: settings.theme,
    density: settings.density,
    motion: settings.motion,
    radius: settings.radius,
    width: settings.width,
    fontScale: settings.fontScale,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    // Never let a storage failure break the page.
  }
}
