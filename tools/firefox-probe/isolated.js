/**
 * Isolated-world half of the probe.
 *
 * Renders the verdict as a banner so the answer is readable without opening
 * devtools, and logs the raw object for copying into a bug report or a commit
 * message. Also runs the other half of the world-separation check: if it can
 * see the marker the main-world script planted, the two are NOT isolated.
 *
 * If no result arrives within 20 seconds it says so explicitly — "the banner
 * never appeared" is ambiguous, and a silent failure is the one outcome that
 * would waste the most time.
 */

(() => {
  const CHANNEL = "dfp-probe";
  let answered = false;

  const banner = (title, lines, ok) => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0 0 auto 0;z-index:2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    const colour = ok === true ? "#0f7b3f" : ok === false ? "#8c1d18" : "#5a4a00";
    shadow.innerHTML = `
      <div style="
        font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
        background:${colour};color:#fff;padding:12px 16px;
        box-shadow:0 2px 12px rgb(0 0 0 / .4)">
        <strong style="font-size:14px">${title}</strong>
        <div style="margin-top:6px;white-space:pre-wrap">${lines.join("\n")}</div>
        <div style="margin-top:8px;opacity:.85">Full object logged to the console as “DFP probe”.</div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
  };

  const render = (r) => {
    if (answered) return;
    answered = true;

    /* The main world planted `__dfpProbeMainWorldMarker`. Under Chrome's model
     * an isolated script cannot see it. If we can, the worlds are shared. */
    const leaked = typeof window.__dfpProbeMainWorldMarker !== "undefined";

    const verdict =
      r.pluginApiReached === true
        ? true
        : r.mainWorldRan && r.requireReached === false
          ? false
          : null;

    const lines = [
      `world:MAIN script ran ......... ${r.mainWorldRan ? "yes" : "NO"}  (at ${r.ranAt})`,
      `saw page globals .............. ${fmt(r.sawPageGlobals)}`,
      `require() reachable ........... ${fmt(r.requireReached)}${r.msToLoader ? `  (${r.msToLoader}ms)` : ""}`,
      `plugin API reachable .......... ${fmt(r.pluginApiReached)}`,
      `PLUGIN_API_VERSION ............ ${r.pluginApiVersion ?? "—"}`,
      `<script> element blocked ...... ${fmt(r.scriptElementBlocked)}`,
      `worlds isolated ............... ${leaked ? "NO — marker leaked" : "yes"}`,
      "",
      verdict === true
        ? "VERDICT: Firefox can run the full extension. Port it."
        : verdict === false
          ? "VERDICT: no loader access — Firefox build would be CSS-only."
          : "VERDICT: inconclusive — read the notes.",
    ];

    if (r.notes?.length) lines.push("", ...r.notes.map((n) => `note: ${n}`));

    banner("DevForum Plus — Firefox MAIN-world probe", lines, verdict);
    // eslint-disable-next-line no-console
    console.log("DFP probe", { ...r, worldsIsolated: !leaked, verdict });
  };

  const fmt = (v) => (v === true ? "yes" : v === false ? "NO" : "—");

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data[CHANNEL] !== true) return;
    render(e.data.result);
  });

  setTimeout(() => {
    if (answered) return;
    render({
      mainWorldRan: false,
      ranAt: "—",
      sawPageGlobals: null,
      requireReached: null,
      pluginApiReached: null,
      pluginApiVersion: null,
      scriptElementBlocked: null,
      notes: [
        "No message from the main world in 20s.",
        "Either Firefox ignored `world: \"MAIN\"` in the manifest, or the script was",
        "blocked before it ran. Check about:debugging for a manifest warning — that",
        "is the single most likely cause and it is reported there, not in the page.",
      ],
    });
  }, 20000);
})();
