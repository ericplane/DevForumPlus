import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type DfpSettings,
} from "./settings-schema";

const AREA = "sync";
const KEY = "settings";

/**
 * Settings live in chrome.storage.sync so they roam with the user's profile.
 * The sync quota is small (~100KB total, 8KB per item); the schema is
 * deliberately kept to scalars and a flat module map so we never approach it.
 */
export async function getSettings(): Promise<DfpSettings> {
  try {
    const stored = await chrome.storage[AREA].get(KEY);
    return normalizeSettings(stored[KEY]);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function setSettings(patch: Partial<DfpSettings>): Promise<DfpSettings> {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage[AREA].set({ [KEY]: next });
  return next;
}

export async function resetSettings(): Promise<DfpSettings> {
  await chrome.storage[AREA].set({ [KEY]: DEFAULT_SETTINGS });
  return DEFAULT_SETTINGS;
}

/**
 * Subscribe to changes from any surface — popup, options page, another tab, or
 * a sync push from a different device. Returns an unsubscribe function.
 */
export function onSettingsChanged(fn: (settings: DfpSettings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== AREA) return;
    const change = changes[KEY];
    if (!change) return;
    fn(normalizeSettings(change.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
