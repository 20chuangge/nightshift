/**
 * imagefit.mjs - make a picture the right size for the vision model.
 *
 * Measured on a 1080x2400 phone screenshot (Qwen3-VL-32B, SiliconFlow): the
 * model bills and reads by pixels - 2577 input tokens as is, 1105 with the
 * long side at 1568, same answer - and a short question came back in 2.3 s
 * instead of 4.4 s. A phone photo (4000x3000) is far worse. So before a
 * picture goes out it is scaled so its long side is at most 1568 px and sent
 * as JPEG (quality 80). Small pictures go as they are (sharper text).
 *
 * PNG is decoded here (zlib is built in); JPEG with the vendored jpeg-js.
 * Anything else (gif, webp, bmp, an interlaced or 16-bit PNG) goes unchanged,
 * and so does any picture this code fails on: never worse than before.
 */

import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Loaded on first use, and never fatal: a build that left the vendored files
// out (1.2.88's first build did) must still start; pictures then go unchanged.
let jpegLib = null;
function jpeg() {
  if (jpegLib === null) {
    try {
      jpegLib = { decode: require('./vendor/jpeg-js/decoder.cjs'), encode: require('./vendor/jpeg-js/encoder.cjs') };
    } catch {
      jpegLib = false;
    }
  }
  return jpegLib || null;
}
const decodeJpeg = (...args) => jpeg().decode(...args);
const encodeJpeg = (...args) => jpeg().encode(...args);

export const VISION_MAX_SIDE = 1568;
const PASS_BYTES = 1.5 * 1024 * 1024; // small enough on the wire as it is

/** PNG (8-bit, not interlaced: what browsers and phones write) -> {w, h, rgba} or null. */
export function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ct = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!w || !h || depth !== 8 || interlace || !channels || (ct === 3 && !palette)) return null;
  if (w * h > 60e6) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  if (raw.length < h * (stride + 1)) return null;
  const rgba = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    const filter = raw[p];
    p += 1;
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const i = x * channels;
      if (ct === 6) { rgba[o] = line[i]; rgba[o + 1] = line[i + 1]; rgba[o + 2] = line[i + 2]; rgba[o + 3] = line[i + 3]; }
      else if (ct === 2) { rgba[o] = line[i]; rgba[o + 1] = line[i + 1]; rgba[o + 2] = line[i + 2]; rgba[o + 3] = 255; }
      else if (ct === 0) { rgba[o] = rgba[o + 1] = rgba[o + 2] = line[i]; rgba[o + 3] = 255; }
      else if (ct === 4) { rgba[o] = rgba[o + 1] = rgba[o + 2] = line[i]; rgba[o + 3] = line[i + 1]; }
      else {
        const k = line[i] * 3;
        rgba[o] = palette[k] ?? 0; rgba[o + 1] = palette[k + 1] ?? 0; rgba[o + 2] = palette[k + 2] ?? 0;
        rgba[o + 3] = trns && line[i] < trns.length ? trns[line[i]] : 255;
      }
    }
    prev = line;
  }
  return { w, h, rgba };
}

/** Area-average downscale onto white (transparent parts become white), -> RGBA. */
export function shrink({ w, h, rgba }, maxSide = VISION_MAX_SIDE) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const W = Math.max(1, Math.round(w * s));
  const H = Math.max(1, Math.round(h * s));
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    const y0 = Math.floor(y / s);
    const y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) / s)));
    for (let x = 0; x < W; x += 1) {
      const x0 = Math.floor(x / s);
      const x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) / s)));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * w + xx) * 4;
          const al = rgba[i + 3] / 255;
          r += rgba[i] * al + 255 * (1 - al);
          g += rgba[i + 1] * al + 255 * (1 - al);
          b += rgba[i + 2] * al + 255 * (1 - al);
          n += 1;
        }
      }
      const o = (y * W + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { w: W, h: H, rgba: out };
}

function decode(bytes, mime) {
  if (mime === 'image/png') return decodePng(bytes);
  if (mime === 'image/jpeg') {
    const img = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 60, maxMemoryUsageInMB: 768 });
    return { w: img.width, h: img.height, rgba: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
  }
  return null;
}

/**
 * The picture as the vision model should get it.
 * -> {bytes, mime, changed, from:{w,h,bytes}, to:{w,h,bytes}}
 */
export function fitForVision(bytes, mime, { maxSide = VISION_MAX_SIDE, quality = 80 } = {}) {
  const same = (extra = {}) => ({ bytes, mime, changed: false, from: { bytes: bytes.length, ...extra }, to: { bytes: bytes.length, ...extra } });
  if (!jpeg()) return same();
  let img = null;
  try { img = decode(bytes, mime); } catch { return same(); }
  if (!img) return same();
  const dims = { w: img.w, h: img.h };
  if (Math.max(img.w, img.h) <= maxSide && bytes.length <= PASS_BYTES) return same(dims);
  try {
    const small = Math.max(img.w, img.h) > maxSide ? shrink(img, maxSide) : shrink(img, Math.max(img.w, img.h));
    const out = encodeJpeg({ data: small.rgba, width: small.w, height: small.h }, quality).data;
    const jpeg = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    if (jpeg.length >= bytes.length && Math.max(img.w, img.h) <= maxSide) return same(dims);
    return { bytes: jpeg, mime: 'image/jpeg', changed: true, from: { ...dims, bytes: bytes.length }, to: { w: small.w, h: small.h, bytes: jpeg.length } };
  } catch {
    return same(dims);
  }
}
