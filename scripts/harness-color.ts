/**
 * Colour maths for check-harness.ts, in a module of its own for one reason: it
 * runs inside the page. Playwright ships a function to the browser as source,
 * so everything the audit needs has to sit inside one function with no
 * imports — and a function that can only run in a page cannot be tested.
 * `colorTools()` is that function: check-harness.ts installs it in the page
 * as an init script (`globalThis.__dfpColor = (colorTools)()`), and
 * tests/unit/harness-color.test.ts calls it in Node, where there is no
 * document and the canvas fallback has to stay out of the way.
 *
 * Nothing inside the factory may reference module scope — no imports, no
 * constants outside it, no helpers beside it — or the page's copy throws
 * ReferenceError at the first call. The type alias is the one exception,
 * because it is erased.
 */

export type Rgba = [number, number, number, number];

export function colorTools() {
  type Rgba = [number, number, number, number];
  const WHITE: Rgba = [255, 255, 255, 1];
  const CLEAR: Rgba = [0, 0, 0, 0];

  /** Computed colour strings parseColor could not read — coverage silently lost. */
  const unparsed: string[] = [];
  let canvas: CanvasRenderingContext2D | null | undefined;

  /* Chromium serialises computed sRGB colours in the legacy comma form,
   * `rgb(r, g, b)` / `rgba(r, g, b, a)`, and everything the 82 color-mix(in
   * oklab …) tokens produce as `oklab(L a b / alpha)` — measured on the first
   * run: eight distinct oklab() values per theme, every one a border or a
   * tinted surface behind text. A 2D canvas was the first idea for those
   * (assign any CSS colour, read back sRGB); Edge 140 hands the oklab() string
   * straight back, so the conversion is done here from the published OKLab
   * matrices instead. The canvas stays as the last resort for anything else. */
  const parseSimple = (raw: string): Rgba | null => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(raw);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [Number(m[1]), Number(m[2]), Number(m[3]), a];
    }
    const h = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(raw);
    if (h) {
      return [
        parseInt(h[1]!, 16),
        parseInt(h[2]!, 16),
        parseInt(h[3]!, 16),
        h[4] === undefined ? 1 : parseInt(h[4], 16) / 255,
      ];
    }
    if (raw === "transparent") return CLEAR;
    return null;
  };

  /** Linear-light channel → 8-bit sRGB. */
  const encode = (v: number): number => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, c * 255));
  };

  /** OKLab → sRGB, Björn Ottosson's published matrices. */
  const fromOklab = (L: number, a: number, b: number): [number, number, number] => {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  };

  /** `oklab(L a b / α)`, `oklch(L C h / α)` and `color(srgb r g b / α)`, as computed values serialise them. */
  const parseModern = (raw: string): Rgba | null => {
    const m = /^(oklab|oklch|color)\(\s*([^/)]*?)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/.exec(raw);
    if (!m) return null;
    const alpha = m[3] === undefined ? 1 : m[3].endsWith("%") ? parseFloat(m[3]) / 100 : parseFloat(m[3]);
    const parts = m[2]!.split(/\s+/);
    // A percentage is relative to the channel's reference range: 100% of
    // lightness is 1, of an oklab a/b or oklch chroma is 0.4, of an sRGB
    // channel is 1. `none` is a missing component, which reads as 0.
    const num = (s: string | undefined, full = 1): number =>
      s === undefined || s === "none" ? 0 : s.endsWith("%") ? (parseFloat(s) / 100) * full : parseFloat(s);
    if (m[1] === "color") {
      const space = parts.shift();
      if (space !== "srgb" && space !== "srgb-linear") return null;
      const ch = space === "srgb" ? (v: number) => Math.min(255, Math.max(0, v * 255)) : encode;
      return [ch(num(parts[0])), ch(num(parts[1])), ch(num(parts[2])), alpha];
    }
    const L = num(parts[0]);
    let a = num(parts[1], 0.4);
    let b = num(parts[2], 0.4);
    if (m[1] === "oklch") {
      const hue = (num(parts[2]) * Math.PI) / 180;
      a = num(parts[1], 0.4) * Math.cos(hue);
      b = num(parts[1], 0.4) * Math.sin(hue);
    }
    return [...fromOklab(L, a, b), alpha];
  };

  const parseColor = (raw: string): Rgba | null => {
    const direct = parseSimple(raw) ?? parseModern(raw);
    if (direct) return direct;
    if (canvas === undefined) {
      canvas = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    }
    if (canvas) {
      // A sentinel no real value parses to: if the assignment is refused the
      // getter still reports it, and that is how "unparseable" is detected.
      canvas.fillStyle = "#010203";
      canvas.fillStyle = raw;
      const out = String(canvas.fillStyle);
      if (out !== "#010203") {
        const viaCanvas = parseSimple(out);
        if (viaCanvas) return viaCanvas;
      }
    }
    if (unparsed.length < 8 && !unparsed.includes(raw)) unparsed.push(raw);
    return null;
  };

  /** Source-over, straight (non-premultiplied) alpha. */
  const over = (s: Rgba, d: Rgba): Rgba => {
    const a = s[3] + d[3] * (1 - s[3]);
    if (a <= 0) return CLEAR;
    const mix = (i: 0 | 1 | 2) => (s[i] * s[3] + d[i] * d[3] * (1 - s[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };

  const fade = (c: Rgba, o: number): Rgba => [c[0], c[1], c[2], c[3] * o];

  /** WCAG relative luminance. */
  const lum = (c: Rgba): number => {
    const lin = (v: number) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  };

  /** WCAG contrast ratio, 1 to 21, of two opaque colours. */
  const contrast = (a: Rgba, b: Rgba): number => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const hex = (c: Rgba): string =>
    "#" + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

  /**
   * The colours a background-image contributes: the stops of a gradient, [] for
   * no image, null for a bitmap (or a gradient this cannot read), which is
   * opaque to the audit.
   */
  const imageColors = (image: string): Rgba[] | null => {
    if (image === "none") return [];
    if (/url\(/.test(image) || !/gradient\(/.test(image)) return null;
    const out: Rgba[] = [];
    for (const m of image.matchAll(/(?:rgba?|hsla?|color|oklab|oklch|lab|lch)\([^()]*\)/g)) {
      const c = parseColor(m[0]);
      if (c) out.push(c);
    }
    return out.length ? out : null;
  };

  return { WHITE, CLEAR, unparsed, parseColor, over, fade, contrast, hex, imageColors };
}

export type ColorTools = ReturnType<typeof colorTools>;
