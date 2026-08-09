/**
 * MAIN-world probe.
 *
 * Load this in Firefox via about:debugging → This Firefox → Load Temporary
 * Add-on → pick tools/firefox-probe/manifest.json, then open
 * https://devforum.roblox.com and read the banner at the top of the page.
 *
 * It answers, in order, the four questions that decide whether DevForum Plus
 * can ship a Firefox build with its JS features intact:
 *
 *   1. Does Firefox honour `world: "MAIN"` in a manifest content script at all?
 *      If this file never runs, the banner says so and nothing else matters.
 *
 *   2. Does it run in the PAGE's world rather than an isolated one? Checked by
 *      looking for globals only the page has (`require`, `define`, `Discourse`)
 *      and by planting one for the isolated script to fail to see.
 *
 *   3. Can it actually reach Discourse's AMD loader and the plugin API? This is
 *      the real target — everything DFP does in the main world goes through
 *      `require("discourse/lib/plugin-api")`.
 *
 *   4. Is the CSP exemption real? A browser-injected MAIN-world script is
 *      supposed to bypass the page's `script-src`, while a <script> element the
 *      page appends is not. The probe appends one deliberately: if BOTH work,
 *      the site's CSP is not doing what we think and the whole two-world
 *      architecture may be unnecessary here. If the element is blocked and this
 *      file still ran, the exemption is confirmed.
 *
 * Nothing here writes to the page, follows a link, or touches the network.
 */

(() => {
  const CHANNEL = "dfp-probe";
  const started = Date.now();

  const result = {
    mainWorldRan: true,
    ranAt: document.readyState,
    // Filled in below.
    sawPageGlobals: null,
    requireReached: null,
    pluginApiReached: null,
    pluginApiVersion: null,
    scriptElementBlocked: null,
    msToLoader: null,
    notes: [],
  };

  const send = () => {
    window.postMessage({ [CHANNEL]: true, result }, window.location.origin);
  };

  /* A global the isolated script must NOT be able to see. If it can, the two
   * scripts are sharing a world and the isolation guarantee is different from
   * Chrome's — worth knowing before porting the bridge. */
  try {
    window.__dfpProbeMainWorldMarker = "main";
  } catch (err) {
    result.notes.push(`could not set a page global: ${String(err)}`);
  }

  /* ── 4. The CSP control ──────────────────────────────────────────────────
   * Appending a <script> is what an isolated content script would have to do,
   * and what the site's CSP is expected to refuse. Done first so the result is
   * known regardless of how long the loader takes. */
  try {
    const el = document.createElement("script");
    el.textContent = "window.__dfpProbeInlineRan = true;";
    (document.head || document.documentElement).appendChild(el);
    el.remove();
    result.scriptElementBlocked = window.__dfpProbeInlineRan !== true;
  } catch (err) {
    result.scriptElementBlocked = true;
    result.notes.push(`script element threw: ${String(err)}`);
  }

  /* ── 1–3. The loader ─────────────────────────────────────────────────────
   * At document_start Discourse has not booted, so poll. Fifteen seconds is
   * far longer than the real app takes and keeps a slow connection from
   * reporting a false negative. */
  const deadline = started + 15000;

  const check = () => {
    const hasRequire = typeof window.require === "function";
    const hasDefine = typeof window.define === "function";
    result.sawPageGlobals = hasRequire || hasDefine || typeof window.Discourse !== "undefined";

    if (!hasRequire) {
      if (Date.now() < deadline) {
        setTimeout(check, 150);
        return;
      }
      result.requireReached = false;
      result.notes.push(
        result.sawPageGlobals
          ? "saw page globals but `require` never appeared — check whether this is a Discourse page"
          : "no page globals in 15s — this script is probably NOT in the page world",
      );
      send();
      return;
    }

    result.requireReached = true;
    result.msToLoader = Date.now() - started;

    try {
      const api = window.require("discourse/lib/plugin-api");
      result.pluginApiReached = typeof api?.withPluginApi === "function";
      // The version constant lives on the module in current Discourse builds.
      result.pluginApiVersion = api?.PLUGIN_API_VERSION ?? null;
      if (!result.pluginApiReached) {
        result.notes.push(`module resolved but withPluginApi missing: ${Object.keys(api ?? {})}`);
      }
    } catch (err) {
      result.pluginApiReached = false;
      result.notes.push(`require("discourse/lib/plugin-api") threw: ${String(err)}`);
    }

    send();
  };

  check();
})();
