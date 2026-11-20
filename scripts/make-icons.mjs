#!/usr/bin/env node
/**
 * Generates the PWA icons as PNGs with zero dependencies (zlib + manual PNG encoding).
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BG = [10, 12, 17];
const ACCENT = [110, 231, 183];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixel) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y, size);
      const offset = y * (stride + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rounded-corner background + mint diamond glyph + ring, anti-aliased by 3x3 supersampling. */
function drawIcon(size, glyphScale) {
  const half = size / 2;
  const radius = size * 0.22;
  const diamondR = half * glyphScale;
  const stroke = size * 0.045;
  const dotR = size * 0.055 * glyphScale * 2;

  function sample(x, y) {
    // Rounded rect mask
    const dx = Math.abs(x - half) - (half - radius);
    const dy = Math.abs(y - half) - (half - radius);
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) > radius;
    if (outside) return [0, 0, 0, 0];

    const manhattan = Math.abs(x - half) + Math.abs(y - half);
    const inRing = Math.abs(manhattan - diamondR) < stroke / 2;
    const inDot = Math.hypot(x - half, y - half) < dotR;
    if (inRing || inDot) return [...ACCENT, 255];
    return [...BG, 255];
  }

  return (x, y) => {
    const samples = 3;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < samples; sy += 1) {
      for (let sx = 0; sx < samples; sx += 1) {
        const [sr, sg, sb, sa] = sample(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples);
        const alpha = sa / 255;
        r += sr * alpha;
        g += sg * alpha;
        b += sb * alpha;
        a += sa;
      }
    }
    const total = samples * samples;
    if (a === 0) return [0, 0, 0, 0];
    const weight = a / 255;
    return [r / weight, g / weight, b / weight, a / total].map((value) => Math.round(value));
  };
}

const outDir = path.resolve("board/icons");
await mkdir(outDir, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192, glyphScale: 0.74 },
  { file: "icon-512.png", size: 512, glyphScale: 0.74 },
  { file: "icon-maskable-512.png", size: 512, glyphScale: 0.52 },
  { file: "apple-touch-icon.png", size: 180, glyphScale: 0.74 },
];

for (const target of targets) {
  const png = encodePng(target.size, drawIcon(target.size, target.glyphScale));
  await writeFile(path.join(outDir, target.file), png);
  console.log(`wrote board/icons/${target.file} (${png.length} bytes)`);
}
