import type { DfpModule } from "../../core/registry";

/**
 * Theme Discourse's charts.
 *
 * The topic view/like graphs are Chart.js drawn to a `<canvas>`, so the line,
 * grid, axes and points are pixels — CSS cannot reach any of it. Restyling them
 * has to happen in JS, before each chart is constructed.
 *
 * This is exactly what the MAIN-world content script exists for: `window.Chart`
 * is a page global, so we can wrap its constructor and merge DFP styling into
 * every chart config on the way through. Nothing is hardcoded — the colours are
 * read from the same CSS custom properties the rest of the product uses, so the
 * charts follow the active theme, including a later switch to light.
 *
 * Chart.js is loaded lazily by Discourse (`discourse/lib/load-script`), so the
 * global usually does not exist at boot. We trap the assignment rather than
 * polling.
 */

type ChartCtor = new (ctx: unknown, config: ChartConfig) => unknown;

interface ChartDataset {
  borderColor?: unknown;
  backgroundColor?: unknown;
  borderWidth?: number;
  pointRadius?: number;
  pointHoverRadius?: number;
  pointBackgroundColor?: unknown;
  pointBorderColor?: unknown;
  pointBorderWidth?: number;
  tension?: number;
  fill?: unknown;
  [key: string]: unknown;
}

interface ChartConfig {
  type?: string;
  data?: { datasets?: ChartDataset[] };
  options?: Record<string, unknown>;
}

const FONT_STACK =
  'BuilderSans, "Helvetica Neue", Helvetica, Arial, "Lucida Grande", sans-serif';

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** rgba() from a hex token, so we can build translucent fills. */
function alpha(hex: string, a: number): string {
  const n = hex.replace("#", "");
  if (n.length < 6) return hex;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function palette() {
  return {
    accent: token("--dfp-accent", "#37b3ff"),
    text: token("--dfp-text", "#eff4fc"),
    text3: token("--dfp-text-3", "#868a91"),
    border: token("--dfp-border", "#2b2e34"),
    surface2: token("--dfp-surface-2", "#1c1f25"),
    surface3: token("--dfp-surface-3", "#25282e"),
  };
}

/**
 * Merge our styling into a chart config.
 *
 * Deliberately non-destructive: anything Discourse set explicitly for a
 * specific chart is left alone, and we only fill in the presentation defaults.
 * A chart that needs its own colours (a multi-series report, say) keeps them.
 */
function themeConfig(config: ChartConfig): void {
  const p = palette();

  for (const dataset of config.data?.datasets ?? []) {
    const isLine = config.type === "line" || config.type === undefined;

    dataset.borderColor ??= p.accent;
    dataset.borderWidth ??= 2;

    if (isLine) {
      // A gentle curve reads as a trend; hard polylines read as a spreadsheet.
      dataset.tension ??= 0.35;
      // Points at every sample turn a dense series into a beaded string. Hide
      // them until hover, where they become the hit target for the tooltip.
      dataset.pointRadius ??= 0;
      dataset.pointHoverRadius ??= 5;
      dataset.pointBackgroundColor ??= p.accent;
      dataset.pointBorderColor ??= p.surface2;
      dataset.pointBorderWidth ??= 2;
      dataset.backgroundColor ??= alpha(p.accent, 0.14);
      dataset.fill ??= true;
    } else {
      dataset.backgroundColor ??= alpha(p.accent, 0.75);
    }
  }

  const options = (config.options ??= {});

  options["maintainAspectRatio"] ??= false;
  options["animation"] ??= { duration: 320, easing: "easeOutCubic" };

  const plugins = (options["plugins"] ??= {}) as Record<string, unknown>;
  plugins["legend"] ??= { display: false };
  plugins["tooltip"] = {
    backgroundColor: p.surface3,
    titleColor: p.text,
    bodyColor: p.text,
    borderColor: p.border,
    borderWidth: 1,
    cornerRadius: 8,
    padding: 10,
    displayColors: false,
    titleFont: { family: FONT_STACK, size: 12, weight: "600" },
    bodyFont: { family: FONT_STACK, size: 12 },
    ...((plugins["tooltip"] as Record<string, unknown>) ?? {}),
  };

  const scales = (options["scales"] ??= {}) as Record<string, Record<string, unknown>>;
  for (const axis of ["x", "y"]) {
    const s = (scales[axis] ??= {});
    s["grid"] = {
      color: alpha(p.border, 0.85),
      // The axis border adds a second line right next to the outermost
      // gridline; one of them is enough.
      drawBorder: false,
      tickLength: 0,
      ...((s["grid"] as Record<string, unknown>) ?? {}),
    };
    s["ticks"] = {
      color: p.text3,
      font: { family: FONT_STACK, size: 11 },
      padding: 8,
      maxRotation: 0,
      ...((s["ticks"] as Record<string, unknown>) ?? {}),
    };
    s["border"] = { display: false, ...((s["border"] as Record<string, unknown>) ?? {}) };
  }
  // Vertical gridlines on a time series are noise; the x labels already mark
  // the intervals.
  const xGrid = scales["x"]?.["grid"] as Record<string, unknown> | undefined;
  if (xGrid) xGrid["display"] ??= false;
}

function install(Chart: ChartCtor): ChartCtor {
  return new Proxy(Chart, {
    construct(target, args: unknown[]) {
      try {
        const config = args[1] as ChartConfig | undefined;
        if (config && typeof config === "object") themeConfig(config);
      } catch {
        // A styling failure must never stop the chart from rendering.
      }
      return Reflect.construct(target, args) as object;
    },
  });
}

export function chartTheme(): DfpModule {
  return {
    id: "chart-theme",
    budgetMs: 3,
    install() {
      const existing = (window as { Chart?: ChartCtor }).Chart;
      if (typeof existing === "function") {
        (window as { Chart?: ChartCtor }).Chart = install(existing);
        return;
      }

      // Chart.js is lazy-loaded, so intercept the assignment instead of polling.
      let stored: ChartCtor | undefined;
      Object.defineProperty(window, "Chart", {
        configurable: true,
        enumerable: true,
        get: () => stored,
        set(value: ChartCtor) {
          stored = typeof value === "function" ? install(value) : value;
          // Step out of the way once we have wrapped it.
          Object.defineProperty(window, "Chart", {
            value: stored,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        },
      });
    },
  };
}
