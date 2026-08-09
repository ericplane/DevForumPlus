import type { DfpSettings } from "./settings-schema";

/**
 * Every visual knob is expressed as an attribute on <html>. CSS reads only
 * these — no class-name juggling, no inline styles, and nothing that requires
 * JS to have run for a *specific* feature.
 *
 * The contract this buys us: if the extension is disabled, uninstalled, or
 * crashes before stamping, no `[data-dfp]` attribute exists and every DFP
 * selector no-ops. The forum renders exactly as it would without us.
 */
export interface RootAttrs {
  "data-dfp": string;
  "data-dfp-theme": string;
  "data-dfp-density": string;
  "data-dfp-motion": string;
  "data-dfp-radius": string;
  "data-dfp-width": string;
}

export function attrsFor(settings: DfpSettings): RootAttrs | null {
  if (!settings.enabled || settings.theme === "off") {
    // "off" still counts as enabled for non-visual features, but the visual
    // layer stands down entirely. Callers treat null as "remove all attrs".
    if (!settings.enabled) return null;
  }
  return {
    "data-dfp": "1",
    "data-dfp-theme": resolveTheme(settings.theme),
    "data-dfp-density": settings.density,
    "data-dfp-motion": settings.motion,
    "data-dfp-radius": settings.radius,
    "data-dfp-width": settings.width,
  };
}

/** `auto` follows the OS. Everything else is explicit. */
export function resolveTheme(theme: DfpSettings["theme"]): string {
  if (theme !== "auto") return theme;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const ATTR_KEYS: (keyof RootAttrs)[] = [
  "data-dfp",
  "data-dfp-theme",
  "data-dfp-density",
  "data-dfp-motion",
  "data-dfp-radius",
  "data-dfp-width",
];

/**
 * Stamp the root element.
 *
 * At `document_start` Chrome has parsed <html> but not much else. In practice
 * `document.documentElement` is available; the observer path is a cheap
 * insurance policy for the case where it is not, since getting this wrong
 * means a visible flash of the un-themed forum.
 */
export function stampRoot(attrs: RootAttrs | null): void {
  const apply = (el: HTMLElement) => {
    if (attrs === null) {
      for (const k of ATTR_KEYS) el.removeAttribute(k);
      return;
    }
    for (const k of ATTR_KEYS) {
      const next = attrs[k];
      if (el.getAttribute(k) !== next) el.setAttribute(k, next);
    }
  };

  const root = document.documentElement;
  if (root) {
    apply(root);
    return;
  }

  const observer = new MutationObserver(() => {
    if (document.documentElement) {
      observer.disconnect();
      apply(document.documentElement);
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

/** The font scale is the one knob that genuinely needs a custom property. */
export function stampFontScale(scale: number): void {
  const root = document.documentElement;
  if (!root) return;
  if (scale === 1) root.style.removeProperty("--dfp-font-scale");
  else root.style.setProperty("--dfp-font-scale", String(scale));
}
