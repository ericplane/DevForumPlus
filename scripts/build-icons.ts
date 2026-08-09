/**
 * Generate the extension icons.
 *
 * They are drawn here rather than committed as binaries for the same reason the
 * colour tokens are: the accent is derived from one seed, and an icon pasted in
 * from a design tool drifts from it the first time that seed moves. This reads
 * the same `--dfp-accent` seed the theme does.
 *
 * PNG is written by hand — a 4-channel raw buffer, one filter byte per row,
 * deflated, wrapped in IHDR/IDAT/IEND. That is a few dozen lines and avoids a
 * native image dependency in a repo whose only runtime deps are Preact.
 *
 * Everything is drawn at 4x and box-filtered down, which is what keeps the
 * 16px icon's curves from turning into stairs.
 *
 * Run: npm run icons
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/icon");

const SIZES = [16, 32, 48, 128] as const;
const SS = 4; // supersample factor

type RGBA = [number, number, number, number];

/* Sampled from the live forum and used as the theme's accent seed — see
 * SEEDS.accent in build-tokens.ts. Kept in sync by hand deliberately: this is
 * the one place a *brand* colour is wanted rather than a contrast-tuned step. */
const ACCENT: RGBA = [0x2b, 0xb1, 0xff, 255];
const INK: RGBA = [0x0c, 0x0e, 0x14, 255];

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
function linearToSrgb(x: number): number {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/** Signed distance to a rounded rectangle, for crisp edges at any size. */
function sdRoundRect(
  px: number,
  py: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  r: number,
): number {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to a thick line segment — the chevron is two of these. */
function sdSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/**
 * The mark: an accent rounded-square with a dark chevron.
 *
 * A chevron rather than a letter. At 16px — the size that actually appears in
 * the toolbar — glyphs turn to mud, and this has to read as *something* at that
 * size before it has to look clever at 128. A `>` also says "code" without
 * spelling anything, which is what the extension is about.
 */
function draw(size: number): Buffer {
  const n = size * SS;
  const buf = Buffer.alloc(n * n * 4);

  const cx = n / 2;
  const cy = n / 2;
  const half = n / 2;
  // A hair of inset so the rounded square never touches the canvas edge.
  const pad = n * 0.045;
  const radius = n * 0.26;

  // Chevron geometry, proportional so every size is the same drawing.
  const armX0 = n * 0.4;
  const armX1 = n * 0.6;
  const armY0 = n * 0.3;
  const armY1 = n * 0.7;
  const stroke = n * 0.085;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const dPlate = sdRoundRect(px, py, cx, cy, half - pad, half - pad, radius);
      // 1px-equivalent feather at the supersampled scale.
      const plate = Math.min(1, Math.max(0, 0.5 - dPlate));

      const dChev = Math.min(
        sdSegment(px, py, armX0, armY0, armX1, cy),
        sdSegment(px, py, armX0, armY1, armX1, cy),
      );
      const chev = Math.min(1, Math.max(0, 0.5 - (dChev - stroke)));

      // Composite ink over accent, then the whole plate over transparency.
      const a = plate;
      const mix = chev * plate;
      const o = (y * n + x) * 4;
      for (let c = 0; c < 3; c++) {
        const lin = srgbToLinear(ACCENT[c]!) * (1 - mix) + srgbToLinear(INK[c]!) * mix;
        buf[o + c] = linearToSrgb(lin);
      }
      buf[o + 3] = Math.round(a * 255);
    }
  }

  return downsample(buf, n, size);
}

/** Box filter in linear light, so edges do not darken the way an sRGB average does. */
function downsample(src: Buffer, n: number, size: number): Buffer {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * n + (x * SS + sx)) * 4;
          const alpha = src[o + 3]! / 255;
          // Premultiply, or transparent pixels drag colour toward black.
          r += srgbToLinear(src[o]!) * alpha;
          g += srgbToLinear(src[o + 1]!) * alpha;
          b += srgbToLinear(src[o + 2]!) * alpha;
          a += alpha;
        }
      }
      const count = SS * SS;
      const ao = a / count;
      const o = (y * size + x) * 4;
      if (ao > 0) {
        out[o] = linearToSrgb(r / count / ao);
        out[o + 1] = linearToSrgb(g / count / ao);
        out[o + 2] = linearToSrgb(b / count / ao);
      }
      out[o + 3] = Math.round(ao * 255);
    }
  }
  return out;
}

// ── Minimal PNG writer ──────────────────────────────────────────────────────

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba: Buffer, size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
const report: string[] = [];
for (const size of SIZES) {
  const file = resolve(outDir, `${size}.png`);
  const bytes = png(draw(size), size);
  writeFileSync(file, bytes);
  report.push(`${size}px ${(bytes.length / 1024).toFixed(1)}kB`);
}
console.log(`icons: wrote ${SIZES.length} files to public/icon — ${report.join(", ")}`);
