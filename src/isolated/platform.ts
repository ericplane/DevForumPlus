/**
 * Which modifier key the reader actually has.
 *
 * The palette hotkey handler has always accepted `metaKey || ctrlKey`, and the
 * README writes "⌘K / Ctrl+K" — but the two surfaces that teach the key, the
 * onboarding card and the palette's footer legend, rendered the literal `⌘`
 * to everyone. Roblox development is overwhelmingly on Windows (the
 * maintainer's own machine included), so the one hint most readers ever see
 * for the headline feature named a key they do not have.
 *
 * `userAgentData.platform` first ("Windows", "macOS", "Linux", "Android",
 * "Chrome OS"), because `navigator.platform` is deprecated and frozen; then
 * `navigator.platform` for Firefox and WebKit, which never shipped the former
 * ("Win32", "MacIntel", "Linux x86_64", "iPhone", "iPad"). An iPad reports
 * "MacIntel" in desktop mode and "iPad" otherwise, and both resolve to ⌘,
 * which is the key an iPad keyboard has. Read once: the platform does not
 * change under a running page.
 */

export type Modifier = "⌘" | "Ctrl";

/** Pure, so the mapping can be checked without a browser. */
export function modifierFor(platform: string): Modifier {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

/**
 * `⌘K` on a Mac and `Ctrl+K` elsewhere — the joiner follows each platform's
 * own convention, and "CtrlK" run together reads as a typo.
 */
export function chordFor(mod: Modifier, key: string): string {
  return mod === "⌘" ? `⌘${key}` : `Ctrl+${key}`;
}

function currentPlatform(): string {
  if (typeof navigator === "undefined") return "";
  // `userAgentData` is Chromium-only and not in lib.dom, hence the cast.
  const ua = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return ua?.platform ?? navigator.platform;
}

export const MOD: Modifier = modifierFor(currentPlatform());

export function chord(key: string): string {
  return chordFor(MOD, key);
}
