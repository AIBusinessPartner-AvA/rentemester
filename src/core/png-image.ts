/**
 * Minimal PNG decoder for embedding brand logos in invoice PDFs (#DLK-branding).
 *
 * PDF has no PNG support: an image must be handed over as raw samples plus a
 * colour space. This module turns a PNG file into exactly that.
 *
 * WHY NOT REUSE THE PNG's OWN COMPRESSED STREAM: a PNG's IDAT is deflate-
 * compressed scanlines with per-row filters, which PDF *can* consume via
 * /DecodeParms /Predictor 15. But that only works when the sample layout maps
 * onto a PDF colour space, and PDF has no RGBA space — alpha must travel
 * separately as an /SMask. So an RGBA PNG has to be decoded either way.
 *
 * ALPHA IS COMPOSITED ONTO WHITE rather than carried as an /SMask. An invoice
 * is always drawn on a white page, so the result is pixel-identical, and it
 * halves both the object count and the code that can be wrong.
 *
 * DETERMINISM: decoding is a pure function of the input bytes — no clock, no
 * filesystem, no locale. The same PNG always yields the same samples, which is
 * what lets an issued invoice re-render byte-identically.
 *
 * SCOPE: 8-bit PNGs, non-interlaced, colour types 0/2/4/6 (grey, RGB, grey+
 * alpha, RGBA). Palette PNGs (type 3), 16-bit depth and Adam7 interlacing are
 * rejected with a named error rather than decoded wrongly — a silently mangled
 * logo on a customer-facing invoice is worse than a failed render.
 */

import { inflateSync } from "node:zlib";

export type DecodedImage = {
  width: number;
  height: number;
  /** Raw 8-bit RGB samples, 3 bytes per pixel, row-major, no padding. */
  rgb: Buffer;
};

export type DecodePngResult =
  | { ok: true; image: DecodedImage; errors: [] }
  | { ok: false; image?: undefined; errors: string[] };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per pixel for each supported PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Undo the per-scanline filters PNG applies before compression. Each row is
 * prefixed with a filter-type byte; every filter predicts a byte from its left
 * (`a`), above (`b`) and up-left (`c`) neighbours, so rows must be processed in
 * order and in place.
 */
function unfilter(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const bpp = channels; // 8-bit: one byte per channel
  const rowBytes = width * bpp;
  const out = Buffer.alloc(rowBytes * height);
  let pos = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const rowStart = y * rowBytes;
    const prevStart = (y - 1) * rowBytes;

    for (let x = 0; x < rowBytes; x += 1) {
      const value = raw[pos + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = x >= bpp && y > 0 ? out[prevStart + x - bpp] : 0;
      let restored: number;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + a; break;
        case 2: restored = value + b; break;
        case 3: restored = value + ((a + b) >> 1); break;
        case 4: restored = value + paeth(a, b, c); break;
        default: throw new Error(`ukendt PNG-rækkefilter ${filter} i række ${y}`);
      }
      out[rowStart + x] = restored & 0xff;
    }
    pos += rowBytes;
  }
  return out;
}

/** Expand decoded samples to RGB, compositing any alpha onto a white page. */
function toRgbOnWhite(samples: Buffer, width: number, height: number, colorType: number): Buffer {
  const pixels = width * height;
  const rgb = Buffer.alloc(pixels * 3);
  const channels = CHANNELS[colorType]!;

  for (let i = 0; i < pixels; i += 1) {
    const s = i * channels;
    let r: number, g: number, b: number, alpha: number;
    if (colorType === 0) { r = g = b = samples[s]; alpha = 255; }
    else if (colorType === 4) { r = g = b = samples[s]; alpha = samples[s + 1]; }
    else if (colorType === 2) { r = samples[s]; g = samples[s + 1]; b = samples[s + 2]; alpha = 255; }
    else { r = samples[s]; g = samples[s + 1]; b = samples[s + 2]; alpha = samples[s + 3]; }

    const d = i * 3;
    if (alpha === 255) {
      rgb[d] = r; rgb[d + 1] = g; rgb[d + 2] = b;
    } else {
      // over-operator against white: out = a*c + (1-a)*255
      const inv = 255 - alpha;
      rgb[d] = Math.round((r * alpha + 255 * inv) / 255);
      rgb[d + 1] = Math.round((g * alpha + 255 * inv) / 255);
      rgb[d + 2] = Math.round((b * alpha + 255 * inv) / 255);
    }
  }
  return rgb;
}

/**
 * Decode a PNG into 8-bit RGB samples ready for a PDF image XObject.
 * Returns `ok: false` with a named reason rather than throwing, so a bad logo
 * degrades the header to its text word-mark instead of failing the invoice.
 */
export function decodePng(bytes: Buffer): DecodePngResult {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, errors: ["filen er ikke en PNG (forkert signatur)"] };
  }

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  const idatParts: Buffer[] = [];
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (dataStart + length > bytes.length) {
      return { ok: false, errors: [`PNG-chunk '${type}' rækker ud over filens slutning`] };
    }
    if (type === "IHDR") {
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      depth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
    } else if (type === "IDAT") {
      idatParts.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4; // +4 for the CRC
  }

  if (width <= 0 || height <= 0) return { ok: false, errors: ["PNG mangler gyldig IHDR (bredde/højde)"] };
  if (depth !== 8) return { ok: false, errors: [`PNG-bitdybde ${depth} understøttes ikke — kun 8 bit`] };
  if (colorType === 3) return { ok: false, errors: ["palette-PNG (colour type 3) understøttes ikke — gem som RGB eller RGBA"] };
  if (CHANNELS[colorType] === undefined) return { ok: false, errors: [`PNG colour type ${colorType} understøttes ikke`] };
  if (interlace !== 0) return { ok: false, errors: ["interlaced (Adam7) PNG understøttes ikke — gem uden interlace"] };
  if (idatParts.length === 0) return { ok: false, errors: ["PNG mangler billeddata (ingen IDAT-chunks)"] };

  const channels = CHANNELS[colorType]!;
  const expected = height * (1 + width * channels);
  try {
    const raw = inflateSync(Buffer.concat(idatParts));
    if (raw.length < expected) {
      return { ok: false, errors: [`PNG-billeddata er for kort (${raw.length} af ${expected} bytes)`] };
    }
    const samples = unfilter(raw, width, height, channels);
    return { ok: true, image: { width, height, rgb: toRgbOnWhite(samples, width, height, colorType) }, errors: [] };
  } catch (error) {
    return { ok: false, errors: [`kunne ikke udpakke PNG-billeddata: ${(error as Error).message}`] };
  }
}
