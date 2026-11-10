#!/usr/bin/env node
/**
 * make-android-icons.mjs - Android launcher icons + splash screens for Nightshift.
 *
 * Pure Node, no dependencies: a small PNG reader (8-bit RGB/RGBA, no interlace),
 * a box-filter resizer (alpha-premultiplied, so edges do not get halos) and a PNG
 * writer. Sources are the web icons the desktop app already ships.
 *
 *   node scripts/make-android-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'public', 'icons', 'icon-512.png');
const RES = path.join(REPO, 'mobile', 'android', 'app', 'src', 'main', 'res');

// ------------------------------------------------------------------ PNG read
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  let bitDepth = 8;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
      if (data[12] !== 0) throw new Error('interlaced png not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = value & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
  }
  return { width, height, data: out };
}

// ----------------------------------------------------------------- PNG write
function writePng(file, width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  return png.length;
}

// -------------------------------------------------------------------- resizing
/** Box-filter resize with premultiplied alpha (no dark fringes). */
function resize(src, outW, outH) {
  const out = Buffer.alloc(outW * outH * 4);
  const sx = src.width / outW;
  const sy = src.height / outH;
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const x0 = x * sx;
      const y0 = y * sy;
      const x1 = Math.min(src.width, x0 + sx);
      const y1 = Math.min(src.height, y0 + sy);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy += 1) {
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx += 1) {
          const i = (yy * src.width + xx) * 4;
          const alpha = src.data[i + 3] / 255;
          r += src.data[i] * alpha;
          g += src.data[i + 1] * alpha;
          b += src.data[i + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const o = (y * outW + x) * 4;
      const alpha = n ? a / n : 0;
      out[o] = alpha > 0 ? Math.round(r / n / alpha) : 0;
      out[o + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0;
      out[o + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0;
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return { width: outW, height: outH, data: out };
}

/** The icon scaled into a canvas of `size`, centred, occupying `ratio` of it. */
function compose(src, size, ratio, background = null) {
  const inner = Math.max(1, Math.round(size * ratio));
  const scaled = resize(src, inner, inner);
  const out = Buffer.alloc(size * size * 4);
  if (background) {
    const [r, g, b] = background;
    for (let i = 0; i < out.length; i += 4) {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
  const offset = Math.floor((size - inner) / 2);
  for (let y = 0; y < inner; y += 1) {
    for (let x = 0; x < inner; x += 1) {
      const s = (y * inner + x) * 4;
      const d = ((y + offset) * size + (x + offset)) * 4;
      const alpha = scaled.data[s + 3] / 255;
      if (background) {
        out[d] = Math.round(scaled.data[s] * alpha + out[d] * (1 - alpha));
        out[d + 1] = Math.round(scaled.data[s + 1] * alpha + out[d + 1] * (1 - alpha));
        out[d + 2] = Math.round(scaled.data[s + 2] * alpha + out[d + 2] * (1 - alpha));
        out[d + 3] = 255;
      } else {
        out[d] = scaled.data[s];
        out[d + 1] = scaled.data[s + 1];
        out[d + 2] = scaled.data[s + 2];
        out[d + 3] = scaled.data[s + 3];
      }
    }
  }
  return { width: size, height: size, data: out };
}

const main = () => {
  const icon = readPng(SRC);
  // The icon's own background colour (a corner pixel a few px inside the rounded
  // square), used for the adaptive background so the seam is invisible.
  const sampleIndex = ((Math.round(icon.height * 0.5) * icon.width) + Math.round(icon.width * 0.08)) * 4;
  const bg = [icon.data[sampleIndex], icon.data[sampleIndex + 1], icon.data[sampleIndex + 2]];
  console.log(`source ${icon.width}x${icon.height}, background #${bg.map((v) => v.toString(16).padStart(2, '0')).join('')}`);

  const densities = [
    ['mdpi', 48, 108],
    ['hdpi', 72, 162],
    ['xhdpi', 96, 216],
    ['xxhdpi', 144, 324],
    ['xxxhdpi', 192, 432],
  ];

  let total = 0;
  for (const [density, legacy, adaptive] of densities) {
    const dir = path.join(RES, `mipmap-${density}`);
    const full = compose(icon, legacy, 1.0);
    total += writePng(path.join(dir, 'ic_launcher.png'), legacy, legacy, full.data);
    total += writePng(path.join(dir, 'ic_launcher_round.png'), legacy, legacy, full.data);
    // Adaptive foreground: the mark inside the 66dp safe zone, transparent rest.
    const foreground = compose(icon, adaptive, 0.72);
    total += writePng(path.join(dir, 'ic_launcher_foreground.png'), adaptive, adaptive, foreground.data);
  }

  // Splash screens keep the sizes Capacitor generated, with the mark centred.
  for (const folder of fs.readdirSync(RES).filter((d) => /^drawable-(port|land)-/.test(d))) {
    const file = path.join(RES, folder, 'splash.png');
    if (!fs.existsSync(file)) continue;
    const { width, height } = readPngDimensions(file);
    const splash = compose(icon, Math.min(width, height), 0.42, bg);
    // Compose into a canvas of the splash size (square mark centred).
    const canvas = Buffer.alloc(width * height * 4);
    for (let i = 0; i < canvas.length; i += 4) {
      canvas[i] = bg[0];
      canvas[i + 1] = bg[1];
      canvas[i + 2] = bg[2];
      canvas[i + 3] = 255;
    }
    const ox = Math.floor((width - splash.width) / 2);
    const oy = Math.floor((height - splash.height) / 2);
    for (let y = 0; y < splash.height; y += 1) {
      for (let x = 0; x < splash.width; x += 1) {
        const s = (y * splash.width + x) * 4;
        const d = ((y + oy) * width + (x + ox)) * 4;
        const alpha = splash.data[s + 3] / 255;
        canvas[d] = Math.round(splash.data[s] * alpha + canvas[d] * (1 - alpha));
        canvas[d + 1] = Math.round(splash.data[s + 1] * alpha + canvas[d + 1] * (1 - alpha));
        canvas[d + 2] = Math.round(splash.data[s + 2] * alpha + canvas[d + 2] * (1 - alpha));
        canvas[d + 3] = 255;
      }
    }
    total += writePng(file, width, height, canvas);
  }

  // Adaptive background colour must match the icon.
  const colorFile = path.join(RES, 'values', 'ic_launcher_background.xml');
  const hex = `#${bg.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  fs.writeFileSync(
    colorFile,
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${hex}</color>
</resources>
`,
    'utf8',
  );
  console.log(`icons + splash written (${(total / 1024).toFixed(1)} KB), adaptive background ${hex}`);
};

function readPngDimensions(file) {
  const buf = fs.readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

main();
