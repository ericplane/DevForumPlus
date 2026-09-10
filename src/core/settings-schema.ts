/**
 * The single source of truth for DFP settings.
 *
 * Anything added here must also be safe to serialize into the boot snapshot
 * (see boot-snapshot.ts) if it affects first paint — otherwise the forum will
 * flash unstyled before chrome.storage resolves.
 */

export const THEMES = ["auto", "dark", "dim", "black", "light", "off"] as const;
export type Theme = (typeof THEMES)[number];

export const DENSITIES = ["comfortable", "compact", "spacious"] as const;
export type Density = (typeof DENSITIES)[number];

export const MOTIONS = ["full", "reduced", "off"] as const;
export type Motion = (typeof MOTIONS)[number];

export const RADII = ["sharp", "soft", "round"] as const;
export type Radius = (typeof RADII)[number];

export const WIDTHS = ["narrow", "default", "wide", "full"] as const;
export type Width = (typeof WIDTHS)[number];

/**
 * What each width means, for a control's tooltip. The pixel values are the
 * --dfp-content-base each one sets in tokens.css; `full` gets the caveat from
 * reading.css instead — with no page margin there is nothing for the pinned
 * post's column to borrow, so it comes out of the replies. Beside WIDTHS so the
 * popup and the options page read one set of four strings.
 */
export const WIDTH_NOTE: Record<Width, string> = {
  narrow: "860px",
  default: "1100px",
  wide: "1400px",
  full: "Edge to edge. Pin post has no margin to borrow at this width.",
};

/**
 * The four sizes the Text control offers, as multipliers on the type scale.
 *
 * `fontScale` has been a first-class setting from the start — normalizeSettings
 * clamps it, root-attrs.ts stamps it as --dfp-font-scale, every --dfp-fs-*
 * token in tokens.css multiplies by it — and for a long time nothing rendered
 * a control for it, so the only way to change it was to hand-edit
 * chrome.storage.
 *
 * Four named steps rather than a slider: every other knob in the popup is
 * segmented, a slider at 340px is fiddly to land on 1.0, and the ends of the
 * clamp are the ends of anyone's range. The clamp below reads its bounds from
 * this ramp, so the control and the schema are literally one pair of numbers;
 * font-scale.test.ts holds them to it. FONT_SCALE_LABELS and fontScaleLabel
 * live here with it as one unit — the three moved together out of Popup.tsx,
 * where reaching them from a test meant stubbing `chrome` first.
 */
export const FONT_SCALES = { S: 0.9, M: 1, L: 1.1, XL: 1.25 } as const;
export type FontScaleLabel = keyof typeof FONT_SCALES;
/** Display order. Object key order would do, but this is the contract, spelled out. */
export const FONT_SCALE_LABELS = ["S", "M", "L", "XL"] as const satisfies readonly FontScaleLabel[];

/**
 * The step a stored scale reads as.
 *
 * Nearest rather than exact, because the setting is a number the schema only
 * clamps: 1.05, written by hand or by a build with a different ramp, is legal
 * and must still light one button — a row with nothing pressed looks broken,
 * and pressing "M" from that state would appear to do nothing. The earlier
 * step wins an exact tie. `NaN` cannot arrive (normalizeSettings refuses it)
 * and reads as M if it somehow did.
 */
export function fontScaleLabel(scale: number): FontScaleLabel {
  let best: FontScaleLabel = "M";
  let gap = Infinity;
  for (const label of FONT_SCALE_LABELS) {
    const d = Math.abs(FONT_SCALES[label] - scale);
    if (d < gap) {
      gap = d;
      best = label;
    }
  }
  return best;
}

/**
 * Module ids. Every JS feature registers under one of these so it can be
 * independently disabled — by the user, or by the registry when it misbehaves.
 */
export const MODULE_IDS = [
  "topic-list-signals",
  "topic-excerpts",
  "chart-theme",
  "profile-info",
  "prefetch",
  "warm-cache",
  "code-intel",
  "code-chrome",
  "stale-answer",
  "category-gate",
  "thread-view",
  "op-pin",
  "quiet-replies",
  "timeline-marks",
  "post-numbers",
  "asset-preview",
  "topic-preview",
  "docs-links",
  "profile-groups",
  "card-groups",
  "post-groups",
  "facepile",
  "search-signals",
  "composer",
  "command-palette",
  "recent-topics",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/**
 * Modules that ship switched off.
 *
 * `settings.modules` records exceptions only: normalizeSettings copies the
 * boolean keys it finds and never consults a default table, and a missing key
 * has always read as "on". A DEFAULT_SETTINGS entry could not express "off
 * unless asked", because anyone whose settings were saved by an earlier build
 * has no key for a module that did not exist yet — so off-by-default is a
 * property of the id, consulted only when the key is absent. An explicit
 * `true` from the options page wins as usual.
 *
 * topic-excerpts is here because it costs two lines per row in every list.
 */
export const DEFAULT_OFF: ReadonlySet<ModuleId> = new Set<ModuleId>(["topic-excerpts"]);

export interface DfpSettings {
  schemaVersion: number;
  /** Master switch. When false, DFP stamps nothing and installs nothing. */
  enabled: boolean;
  theme: Theme;
  density: Density;
  motion: Motion;
  radius: Radius;
  width: Width;
  /** Multiplier on the base type scale. Clamped to [FONT_SCALES.S, FONT_SCALES.XL]. */
  fontScale: number;
  /** Per-module enable flags. Missing key means enabled, unless the id is in DEFAULT_OFF. */
  modules: Partial<Record<ModuleId, boolean>>;
  /**
   * Opt-in network trimming (PLAN.md §4.4). Off by default and deliberately
   * narrow: consent and age-verification scripts are never blockable, at any
   * setting. See public/rules/ for what each ruleset actually matches.
   */
  trimNetwork: Partial<Record<TrimRuleset, boolean>>;
}

/** Ruleset ids must match the `id` fields in the manifest's rule_resources. */
export const TRIM_RULESETS = ["lite-footer"] as const;
export type TrimRuleset = (typeof TRIM_RULESETS)[number];

export const SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: DfpSettings = {
  schemaVersion: SCHEMA_VERSION,
  enabled: true,
  theme: "dark",
  density: "comfortable",
  motion: "full",
  radius: "soft",
  width: "default",
  fontScale: 1,
  modules: {},
  trimNetwork: {},
};

const oneOf = <T extends readonly string[]>(
  allowed: T,
  value: unknown,
  fallback: T[number],
): T[number] => (allowed.includes(value as string) ? (value as T[number]) : fallback);

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Coerce arbitrary stored data into a valid settings object.
 *
 * Storage is shared with future versions of this extension and, in principle,
 * with a corrupted profile — so nothing read from it is trusted. Unknown values
 * fall back to defaults rather than throwing, because a settings parse failure
 * must never be able to take the forum down.
 */
export function normalizeSettings(raw: unknown): DfpSettings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawModules =
    typeof r["modules"] === "object" && r["modules"] !== null
      ? (r["modules"] as Record<string, unknown>)
      : {};

  const modules: Partial<Record<ModuleId, boolean>> = {};
  for (const id of MODULE_IDS) {
    const v = rawModules[id];
    if (typeof v === "boolean") modules[id] = v;
  }

  const rawTrim =
    typeof r["trimNetwork"] === "object" && r["trimNetwork"] !== null
      ? (r["trimNetwork"] as Record<string, unknown>)
      : {};
  const trimNetwork: Partial<Record<TrimRuleset, boolean>> = {};
  for (const id of TRIM_RULESETS) {
    const v = rawTrim[id];
    if (typeof v === "boolean") trimNetwork[id] = v;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: typeof r["enabled"] === "boolean" ? r["enabled"] : DEFAULT_SETTINGS.enabled,
    theme: oneOf(THEMES, r["theme"], DEFAULT_SETTINGS.theme),
    density: oneOf(DENSITIES, r["density"], DEFAULT_SETTINGS.density),
    motion: oneOf(MOTIONS, r["motion"], DEFAULT_SETTINGS.motion),
    radius: oneOf(RADII, r["radius"], DEFAULT_SETTINGS.radius),
    width: oneOf(WIDTHS, r["width"], DEFAULT_SETTINGS.width),
    fontScale:
      typeof r["fontScale"] === "number" && Number.isFinite(r["fontScale"])
        ? clamp(r["fontScale"], FONT_SCALES.S, FONT_SCALES.XL)
        : DEFAULT_SETTINGS.fontScale,
    modules,
    trimNetwork,
  };
}

/**
 * The one reading of a module flag. Every surface that decides "is this on" —
 * the MAIN registry's isEnabled, the isolated mounts, the options checkbox —
 * goes through here, so a module in DEFAULT_OFF reads the same everywhere.
 */
export function isModuleEnabled(settings: DfpSettings, id: ModuleId): boolean {
  const v = settings.modules[id];
  return v === undefined ? !DEFAULT_OFF.has(id) : v;
}
