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
 * Module ids. Every JS feature registers under one of these so it can be
 * independently disabled — by the user, or by the registry when it misbehaves.
 */
export const MODULE_IDS = [
  "topic-list-signals",
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
  "asset-preview",
  "topic-preview",
  "docs-links",
  "profile-groups",
  "card-groups",
  "post-groups",
  "facepile",
  "search-signals",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export interface DfpSettings {
  schemaVersion: number;
  /** Master switch. When false, DFP stamps nothing and installs nothing. */
  enabled: boolean;
  theme: Theme;
  density: Density;
  motion: Motion;
  radius: Radius;
  width: Width;
  /** Multiplier on the base type scale. Clamped to [0.9, 1.25]. */
  fontScale: number;
  /** Per-module enable flags. Missing key means enabled. */
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
        ? clamp(r["fontScale"], 0.9, 1.25)
        : DEFAULT_SETTINGS.fontScale,
    modules,
    trimNetwork,
  };
}

export function isModuleEnabled(settings: DfpSettings, id: ModuleId): boolean {
  return settings.modules[id] !== false;
}
