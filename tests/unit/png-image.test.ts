// Tests: src/core/png-image.ts — PNG → 8-bit RGB til fakturaens PDF-header.
//
// Testene BYGGER deres egne PNG'er i stedet for at læse fixtures. Det er med
// vilje: en fixture viser kun at dekoderen kan læse lige præcis den fil, mens
// en encoder her i filen lader os styre hver enkelt variabel — farvetype,
// filtertype pr. scanline, bitdybde, interlace — og dermed ramme de steder en
// PNG-dekoder faktisk går i stykker.
//
// Den vigtigste test er "alle fem filtertyper giver samme billede": PNG'ens
// scanline-filtre er ren forudsigelses-matematik, og en fejl i ét af dem giver
// et billede der ser næsten rigtigt ud. Ved at kode det SAMME billede med alle
// fem filtre og kræve ét fælles resultat, fanges den slags.
import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodePng } from "../../src/core/png-image";

// --- PNG-encoder, kun til test ------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Anvend ét PNG-scanline-filter på en råt-sample-række. Modstykket til dekoderens unfilter. */
function filterRow(raw: Buffer, prev: Buffer, type: number, bpp: number): Buffer {
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    const left = i >= bpp ? raw[i - bpp]! : 0;
    const up = prev[i]!;
    const upLeft = i >= bpp ? prev[i - bpp]! : 0;
    let predictor = 0;
    if (type === 1) predictor = left;
    else if (type === 2) predictor = up;
    else if (type === 3) predictor = Math.floor((left + up) / 2);
    else if (type === 4) predictor = paeth(left, up, upLeft);
    out[i] = (raw[i]! - predictor) & 0xff;
  }
  return out;
}

type PngOptions = {
  width: number;
  height: number;
  colorType: number;
  /** Én råt-sample-række pr. billedrække, uden filterbyte. */
  rows: Buffer[];
  /** Filtertype pr. række. Standard: 0 (None) overalt. */
  filters?: number[];
  depth?: number;
  interlace?: number;
  /** Del IDAT op i flere chunks — lovligt og almindeligt i rigtige PNG'er. */
  idatChunks?: number;
  /** Ekstra chunks indsat mellem IHDR og IDAT. */
  extraChunks?: Array<{ type: string; data: Buffer }>;
};

function buildPng(opts: PngOptions): Buffer {
  const { width, height, colorType, rows } = opts;
  const depth = opts.depth ?? 8;
  const interlace = opts.interlace ?? 0;
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = channels[colorType] ?? 1;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = interlace;

  const filters = opts.filters ?? rows.map(() => 0);
  const scanlines: Buffer[] = [];
  let prev: Buffer = Buffer.alloc(rows[0]?.length ?? 0);
  rows.forEach((row, index) => {
    const type = filters[index] ?? 0;
    scanlines.push(Buffer.from([type]), filterRow(row, prev, type, bpp));
    prev = row;
  });

  const compressed = deflateSync(Buffer.concat(scanlines));
  const parts: Buffer[] = [SIGNATURE, chunk("IHDR", ihdr)];
  for (const extra of opts.extraChunks ?? []) parts.push(chunk(extra.type, extra.data));

  const pieces = opts.idatChunks ?? 1;
  const size = Math.ceil(compressed.length / pieces);
  for (let i = 0; i < compressed.length; i += size) {
    parts.push(chunk("IDAT", compressed.subarray(i, i + size)));
  }
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// --- Billeder testene deler ---------------------------------------------------

/** 2x2 RGB: rød, grøn / blå, hvid. Værdier valgt så en kanalombytning ses straks. */
const RGB_ROWS = [
  Buffer.from([255, 0, 0, 0, 255, 0]),
  Buffer.from([0, 0, 255, 255, 255, 255]),
];
const RGB_EXPECTED = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];

/** Farvekomposition mod hvid: out = round((c*a + 255*(255-a)) / 255). */
function overWhite(channel: number, alpha: number): number {
  return Math.round((channel * alpha + 255 * (255 - alpha)) / 255);
}

describe("decodePng — gyldige billeder", () => {
  test("læser et 2x2 RGB-billede pixel for pixel", () => {
    const result = decodePng(buildPng({ width: 2, height: 2, colorType: 2, rows: RGB_ROWS }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(2);
    expect(result.image.height).toBe(2);
    expect([...result.image.rgb]).toEqual(RGB_EXPECTED);
  });

  test("alle fem filtertyper giver præcis samme billede", () => {
    // Kernen i hele filen. Filtrene er forskellige forudsigelser af den samme
    // pixel; rammer én af dem forkert, falder netop denne test.
    for (const filter of [0, 1, 2, 3, 4]) {
      const png = buildPng({
        width: 2,
        height: 2,
        colorType: 2,
        rows: RGB_ROWS,
        filters: [filter, filter],
      });
      const result = decodePng(png);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect([...result.image.rgb]).toEqual(RGB_EXPECTED);
    }
  });

  test("blandede filtertyper på tværs af rækker virker også", () => {
    // Rigtige encodere vælger filter pr. række, ikke pr. fil.
    const rows = [
      Buffer.from([10, 20, 30, 40, 50, 60]),
      Buffer.from([70, 80, 90, 100, 110, 120]),
      Buffer.from([130, 140, 150, 160, 170, 180]),
    ];
    const result = decodePng(buildPng({ width: 2, height: 3, colorType: 2, rows, filters: [1, 4, 3] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.image.rgb]).toEqual(rows.flatMap((r) => [...r]));
  });

  test("gråtone-PNG (type 0) spejles ud på alle tre kanaler", () => {
    const rows = [Buffer.from([0, 128]), Buffer.from([200, 255])];
    const result = decodePng(buildPng({ width: 2, height: 2, colorType: 0, rows }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.image.rgb]).toEqual([0, 0, 0, 128, 128, 128, 200, 200, 200, 255, 255, 255]);
  });

  test("fuldt gennemsigtig pixel bliver hvid, ikke sort", () => {
    // Det er forskellen på et logo der forsvinder pænt og et logo med en sort
    // kasse om sig.
    const rows = [Buffer.from([0, 0, 0, 0, 255, 0, 0, 255])]; // sort/alpha 0, rød/alpha 255
    const result = decodePng(buildPng({ width: 2, height: 1, colorType: 6, rows }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.image.rgb]).toEqual([255, 255, 255, 255, 0, 0]);
  });

  test("halvgennemsigtig pixel komponeres mod hvid", () => {
    const alpha = 128;
    const rows = [Buffer.from([0, 0, 0, alpha])];
    const result = decodePng(buildPng({ width: 1, height: 1, colorType: 6, rows }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = overWhite(0, alpha);
    expect([...result.image.rgb]).toEqual([expected, expected, expected]);
  });

  test("gråtone med alpha (type 4) komponeres på samme måde", () => {
    const rows = [Buffer.from([0, 0, 64, 255])]; // sort/alpha 0, mørkegrå/alpha 255
    const result = decodePng(buildPng({ width: 2, height: 1, colorType: 4, rows }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.image.rgb]).toEqual([255, 255, 255, 64, 64, 64]);
  });

  test("flere IDAT-chunks samles til ét billede", () => {
    const result = decodePng(buildPng({ width: 2, height: 2, colorType: 2, rows: RGB_ROWS, idatChunks: 3 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.image.rgb]).toEqual(RGB_EXPECTED);
  });

  test("ukendte chunks før billeddataen springes over", () => {
    const result = decodePng(buildPng({
      width: 2,
      height: 2,
      colorType: 2,
      rows: RGB_ROWS,
      extraChunks: [
        { type: "tEXt", data: Buffer.from("Comment\0lavet af en test", "latin1") },
        { type: "pHYs", data: Buffer.alloc(9) },
      ],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.image.rgb]).toEqual(RGB_EXPECTED);
  });

  test("dekodning er deterministisk — samme bytes, samme resultat", () => {
    // Det er denne egenskab der gør at en udstedt faktura kan gengives
    // byte-identisk år senere.
    const png = buildPng({ width: 2, height: 2, colorType: 2, rows: RGB_ROWS, filters: [4, 3] });
    const first = decodePng(png);
    const second = decodePng(png);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.image.rgb.equals(second.image.rgb)).toBe(true);
  });

  test("en enkelt pixel er også et billede", () => {
    const result = decodePng(buildPng({ width: 1, height: 1, colorType: 2, rows: [Buffer.from([1, 2, 3])] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.image.rgb]).toEqual([1, 2, 3]);
  });
});

describe("decodePng — afvisninger med en navngiven grund", () => {
  // Ingen af disse må kaste: et dårligt logo skal degradere headeren til
  // ordmærket, ikke vælte fakturaen.

  test("tom buffer", () => {
    const result = decodePng(Buffer.alloc(0));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("signatur");
  });

  test("forkert signatur", () => {
    const result = decodePng(Buffer.from("dette er en JPEG, helt ærligt", "utf8"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("signatur");
  });

  test("palette-PNG (type 3) nævner hvad man skal gøre i stedet", () => {
    const result = decodePng(buildPng({ width: 2, height: 1, colorType: 3, rows: [Buffer.from([0, 1])] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("palette");
    expect(result.errors[0]).toContain("RGB");
  });

  test("16-bit bitdybde", () => {
    const result = decodePng(buildPng({ width: 1, height: 1, colorType: 2, rows: [Buffer.alloc(6)], depth: 16 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("8 bit");
  });

  test("interlaced (Adam7)", () => {
    const result = decodePng(buildPng({ width: 2, height: 2, colorType: 2, rows: RGB_ROWS, interlace: 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("interlace");
  });

  test("ukendt farvetype", () => {
    const result = decodePng(buildPng({ width: 1, height: 1, colorType: 7, rows: [Buffer.from([0])] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("colour type");
  });

  test("ingen IDAT-chunks", () => {
    const png = Buffer.concat([
      SIGNATURE,
      chunk("IHDR", (() => {
        const h = Buffer.alloc(13);
        h.writeUInt32BE(1, 0); h.writeUInt32BE(1, 4); h[8] = 8; h[9] = 2;
        return h;
      })()),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const result = decodePng(png);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("IDAT");
  });

  test("IHDR med nul i bredde eller højde", () => {
    const result = decodePng(buildPng({ width: 0, height: 0, colorType: 2, rows: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("IHDR");
  });

  test("billeddata der er for kort til den lovede størrelse", () => {
    // IHDR lover 4x4, men der er kun data til én række.
    const png = buildPng({ width: 4, height: 4, colorType: 2, rows: [Buffer.alloc(12)] });
    const result = decodePng(png);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("for kort");
  });

  test("ødelagt komprimeret data", () => {
    const png = buildPng({ width: 2, height: 2, colorType: 2, rows: RGB_ROWS });
    // Find IDAT og ødelæg en byte midt i nyttelasten.
    const idatAt = png.indexOf(Buffer.from("IDAT", "ascii"));
    const corrupted = Buffer.from(png);
    corrupted[idatAt + 8] = corrupted[idatAt + 8]! ^ 0xff;
    const result = decodePng(corrupted);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("udpakke");
  });

  test("en chunk der rækker ud over filens slutning", () => {
    const png = buildPng({ width: 2, height: 2, colorType: 2, rows: RGB_ROWS });
    const truncated = png.subarray(0, png.length - 20);
    const result = decodePng(truncated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("rækker ud over");
  });

  test("ingen input kan få dekoderen til at kaste", () => {
    const png = buildPng({ width: 2, height: 2, colorType: 2, rows: RGB_ROWS });
    const inputs = [
      Buffer.alloc(0),
      Buffer.alloc(8),
      SIGNATURE,
      png.subarray(0, 10),
      png.subarray(0, 30),
      Buffer.concat([SIGNATURE, Buffer.alloc(200, 0xff)]),
      Buffer.from("\u0000\u0000\u0000", "binary"),
    ];
    for (const input of inputs) {
      expect(() => decodePng(input)).not.toThrow();
      expect(decodePng(input).ok).toBe(false);
    }
  });
});
