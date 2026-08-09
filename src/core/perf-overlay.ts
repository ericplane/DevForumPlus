import type { Diagnostics } from "./bridge/protocol";

/**
 * The `?dfp-perf=1` overlay.
 *
 * PLAN.md §4.1 sets budgets and §4.6 promises they are enforced rather than
 * asserted. This is the enforcement: a live readout of the numbers the
 * milestone claims, on the real forum, so nothing in the README has to be
 * taken on trust.
 *
 * It lives in the isolated world because that is where DFP-rendered UI belongs,
 * and it can afford to: `performance` is per-document, and content scripts
 * share the page's document, so every metric here is read first-hand. Only the
 * module records come over the bridge, because those are produced in the main
 * world.
 *
 * Everything renders into a shadow root with `all: initial`, so the overlay
 * cannot inherit forum styles and cannot leak into them.
 */

const BUDGETS = {
  /** PLAN.md §4.1 */
  cssGzipKB: 40,
  contentScriptKB: 30,
  memoryDeltaMB: 25,
  moduleInstallMs: 4,
} as const;

interface Vitals {
  ttfb: number | null;
  fcp: number | null;
  lcp: number | null;
  cls: number;
  longTasks: number;
}

const vitals: Vitals = { ttfb: null, fcp: null, lcp: null, cls: 0, longTasks: 0 };

/** Observers must start before the metrics they watch, so this runs at
 *  document_start regardless of whether the overlay is shown. */
export function startVitals(): void {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav) vitals.ttfb = Math.round(nav.responseStart);

    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === "first-contentful-paint") vitals.fcp = Math.round(e.startTime);
      }
    }).observe({ type: "paint", buffered: true });

    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) vitals.lcp = Math.round(last.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });

    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // Shifts the user caused by interacting are not layout instability.
        const shift = e as PerformanceEntry & { value: number; hadRecentInput: boolean };
        if (!shift.hadRecentInput) vitals.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });

    new PerformanceObserver((list) => {
      vitals.longTasks += list.getEntries().length;
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // An unsupported entry type must not stop the rest from being collected.
  }
}

function resourceSummary() {
  const res = performance.getEntriesByType("resource");
  let dfpBytes = 0;
  for (const e of res) {
    if (e.name.startsWith("chrome-extension://")) dfpBytes += (e as PerformanceResourceTiming).transferSize || 0;
  }
  return { count: res.length, dfpKB: Math.round(dfpBytes / 1024) };
}

function dfpMeasures() {
  return performance
    .getEntriesByType("measure")
    .filter((m) => m.name.startsWith("dfp:"))
    .map((m) => ({ name: m.name.replace(/^dfp:/, ""), ms: +m.duration.toFixed(2) }));
}

const row = (label: string, value: string, state?: "ok" | "warn" | "bad") =>
  `<div class="row"><span class="k">${label}</span><span class="v ${state ?? ""}">${value}</span></div>`;

function verdict(actual: number, budget: number): "ok" | "warn" | "bad" {
  if (actual <= budget) return "ok";
  return actual <= budget * 1.5 ? "warn" : "bad";
}

function render(root: ShadowRoot, diag: Diagnostics | null): void {
  const r = resourceSummary();
  const measures = dfpMeasures();
  const slowest = measures.reduce((a, b) => (b.ms > (a?.ms ?? 0) ? b : a), measures[0]);
  const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;

  const modules = (diag?.modules ?? [])
    .map((m) => {
      const state =
        m.status === "installed"
          ? verdict(m.installMs, BUDGETS.moduleInstallMs)
          : m.status === "failed" || m.status === "auto-disabled"
            ? "bad"
            : undefined;
      const value = m.status === "installed" ? `${m.installMs.toFixed(2)} ms` : m.status;
      return row(m.id, value, state);
    })
    .join("");

  root.querySelector(".body")!.innerHTML = `
    <div class="grp">
      <div class="h">Load — server-bound on this forum</div>
      ${row("TTFB", vitals.ttfb === null ? "—" : `${vitals.ttfb} ms`, vitals.ttfb !== null && vitals.ttfb > 1000 ? "bad" : "ok")}
      ${row("FCP", vitals.fcp === null ? "—" : `${vitals.fcp} ms`)}
      ${row("LCP", vitals.lcp === null ? "—" : `${vitals.lcp} ms`)}
      ${row("CLS", vitals.cls.toFixed(3), vitals.cls < 0.1 ? "ok" : vitals.cls < 0.25 ? "warn" : "bad")}
      ${row("Long tasks", String(vitals.longTasks))}
    </div>
    <div class="grp">
      <div class="h">DFP cost</div>
      ${row("Integration", diag ? diag.rung : "—", diag?.rung === "pre-boot" ? "ok" : diag ? "warn" : undefined)}
      ${row("Boot", diag ? `${diag.bootMs.toFixed(0)} ms` : "—")}
      ${row("Extension bytes", `${r.dfpKB} KB`, verdict(r.dfpKB, BUDGETS.cssGzipKB + BUDGETS.contentScriptKB))}
      ${row("Slowest module", slowest ? `${slowest.name} ${slowest.ms} ms` : "—")}
      ${modules}
    </div>
    <div class="grp">
      <div class="h">Page</div>
      ${row("Subresources", String(r.count))}
      ${row("DOM nodes", String(document.getElementsByTagName("*").length))}
      ${row("JS heap", mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : "n/a")}
    </div>
    <div class="note">Budgets from PLAN.md §4.1. Reload to re-measure load metrics.</div>
  `;
}

export function mountPerfOverlay(getDiagnostics: () => Diagnostics | null): void {
  if (!new URLSearchParams(location.search).has("dfp-perf")) return;

  const host = document.createElement("div");
  host.id = "dfp-perf-overlay";
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        position: fixed; inset-block-start: 12px; inset-inline-end: 12px; z-index: 2147483647;
        inline-size: 260px; max-block-size: 82vh; overflow: auto;
        font: 11px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
        background: #14171c; color: #eff4fc;
        border: 1px solid #40444a; border-radius: 10px;
        box-shadow: 0 8px 32px rgb(0 0 0 / .5);
      }
      .bar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 10px; border-bottom: 1px solid #2b2e34;
        position: sticky; inset-block-start: 0; background: #14171c;
      }
      .title { font-weight: 700; letter-spacing: .04em; }
      button {
        all: unset; cursor: pointer; color: #868a91; padding: 0 4px; border-radius: 4px;
      }
      button:hover { color: #eff4fc; background: #25282e; }
      .body { padding: 4px 10px 10px; }
      .grp { margin-block-start: 8px; }
      .h {
        color: #868a91; text-transform: uppercase; letter-spacing: .06em;
        font-size: 9px; margin-block-end: 3px;
      }
      .row { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
      .k { color: #b4b8c0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .v { font-variant-numeric: tabular-nums; flex: 0 0 auto; }
      .v.ok { color: #1ac972; }
      .v.warn { color: #e19900; }
      .v.bad { color: #ff7b72; }
      .note { color: #868a91; margin-block-start: 10px; font-size: 9px; line-height: 1.4; }
    </style>
    <div class="panel">
      <div class="bar"><span class="title">DFP PERF</span><button title="Close">✕</button></div>
      <div class="body"></div>
    </div>
  `;

  root.querySelector("button")!.addEventListener("click", () => host.remove());

  const attach = () => {
    document.body?.appendChild(host);
    render(root, getDiagnostics());
    // Cheap enough to keep live; the overlay is opt-in and dev-only.
    setInterval(() => render(root, getDiagnostics()), 1000);
  };

  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });
}
