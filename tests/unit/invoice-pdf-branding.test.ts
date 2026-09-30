// Tests: src/core/invoice-pdf.ts — de brand-specifikke tilføjelser (#DLK-branding).
//
// AFGRÆNSNING: basis-renderingen er allerede dækket af
// tests/unit/invoice-render-cli.test.ts (paginering, WinAnsi-kodning af danske
// tegn, betalingsblok, talformat, determinisme). Denne fil dækker KUN det,
// brand-arbejdet lagde oven på: kontakt-footeren, morarente-noten,
// betalingsbetingelses-linjen og PNG-logoet i headeren.
//
// DEN VIGTIGSTE INVARIANT: en faktura UDEN brand skal se ud præcis som før.
// Derfor er de nye elementer alle bag en guard, og flere tests herunder handler
// om at guarden holder — ikke om at det nye virker.
import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { buildIssuedInvoicePdf } from "../../src/core/invoice-pdf";

/** Træk hver `( ... ) Tj` ud af content-streamen, så tekst kan tjekkes uden hensyn til placering. */
function pdfStrings(pdf: Uint8Array): string[] {
  const text = Buffer.from(pdf).toString("latin1");
  const out: string[] = [];
  const re = /\(((?:[^()\\]|\\.)*)\) Tj/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) out.push(match[1]!.replace(/\\([()\\])/g, "$1"));
  return out;
}

const drawn = (pdf: Uint8Array) => pdfStrings(pdf).join("\n");

// --- en gyldig lille PNG, bygget her så testen ikke afhænger af en fixture ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** 2x2 RGB PNG, ufiltrerede scanlines. `colorType` 3 bruges til at lave en UNDERSTØTTET-ikke-PNG. */
function tinyPng(colorType = 2): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[12] = 0;
  const px = colorType === 2 ? 3 : 1;
  const rows = Buffer.concat([
    Buffer.from([0]), Buffer.alloc(2 * px, 0x20),
    Buffer.from([0]), Buffer.alloc(2 * px, 0x40),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG_BASE64 = tinyPng().toString("base64");

// --- en basis-payload testene varierer over -----------------------------------

type Payload = Parameters<typeof buildIssuedInvoicePdf>[0];

function invoice(overrides: Record<string, unknown> = {}): Payload {
  return {
    invoiceNumber: "2026-27-0001",
    issueDate: "2026-05-16",
    currency: "DKK",
    seller: { name: "Mind AI ApS", address: "Bøgevej 7, 4330 Hvalsø", vatOrCvr: "DK46376080" },
    buyer: { name: "Kunde ApS", address: "Købervej 9, 8000 Aarhus", vatOrCvr: "DK87654321" },
    lines: [{ description: "Konsulenttimer", quantity: 3, unitPriceExVat: 1200, lineTotalExVat: 3600 }],
    totals: { netAmount: 3600, vatRate: 0.25, vatAmount: 900, grossAmount: 4500 },
    ...overrides,
  } as Payload;
}

/** Sælger med kontaktoplysninger — altså en faktura udstedt under et brand. */
function brandedSeller(extra: Record<string, unknown> = {}) {
  return {
    name: "Mind AI ApS",
    address: "Bøgevej 7, 4330 Hvalsø",
    vatOrCvr: "DK46376080",
    email: "bogholder@eksempel.dk",
    phone: "12345678",
    web: "www.eksempel.dk",
    ...extra,
  };
}

describe("kontakt-footer", () => {
  test("et brand får sine kontaktoplysninger i footeren", () => {
    const text = drawn(buildIssuedInvoicePdf(invoice({ seller: brandedSeller() })));
    expect(text).toContain("Mail: bogholder@eksempel.dk");
    expect(text).toContain("Tlf. 12345678");
    expect(text).toContain("Web: www.eksempel.dk");
    expect(text).toContain("CVR DK46376080");
  });

  test("navn og adresse sættes sammen med skråstreg", () => {
    const text = drawn(buildIssuedInvoicePdf(invoice({ seller: brandedSeller() })));
    expect(text).toContain("Mind AI ApS / Bøgevej 7, 4330 Hvalsø");
  });

  test("UDEN kontaktoplysninger tilføjes ingen footer-linjer overhovedet", () => {
    // Guarden der holder ubrandede fakturaer uændrede. Det er IKKE nok at
    // tjekke for "Mail:"/"Tlf."/"Web:" — uden guarden ville footeren stadig
    // blive tegnet, bare med navn, adresse og CVR. Derfor kigger testen efter
    // den skråstreg-samlede linje, som kun footeren producerer.
    const text = drawn(buildIssuedInvoicePdf(invoice()));
    expect(text).not.toContain("Mail:");
    expect(text).not.toContain("Tlf.");
    expect(text).not.toContain("Web:");
    expect(text).not.toContain("Mind AI ApS / Bøgevej 7, 4330 Hvalsø");
    expect(text).not.toContain("CVR DK46376080");
  });

  test("én enkelt kontaktoplysning er nok til at udløse footeren", () => {
    const text = drawn(buildIssuedInvoicePdf(invoice({
      seller: { name: "Mind AI ApS", address: "Bøgevej 7", vatOrCvr: "DK46376080", email: "a@b.dk" },
    })));
    expect(text).toContain("Mail: a@b.dk");
    expect(text).not.toContain("Tlf.");
    expect(text).not.toContain("Web:");
  });

  test("kontaktfelter der kun er mellemrum tæller som fraværende", () => {
    const text = drawn(buildIssuedInvoicePdf(invoice({
      seller: { name: "Mind AI ApS", address: "Bøgevej 7", vatOrCvr: "DK46376080", email: "  ", phone: "", web: "   " },
    })));
    expect(text).not.toContain("Mail:");
    expect(text).not.toContain("Tlf.");
  });

  test("blanke kontaktfelter giver BYTE-IDENTISK PDF som helt fraværende felter", () => {
    // Den skarpeste formulering af guarden: tomme strenge må ikke kunne ændre
    // så meget som én byte i forhold til en faktura uden felterne.
    const withBlanks = buildIssuedInvoicePdf(invoice({
      seller: { name: "Mind AI ApS", address: "Bøgevej 7, 4330 Hvalsø", vatOrCvr: "DK46376080", email: "", phone: "  ", web: null },
    }));
    const without = buildIssuedInvoicePdf(invoice({
      seller: { name: "Mind AI ApS", address: "Bøgevej 7, 4330 Hvalsø", vatOrCvr: "DK46376080" },
    }));
    expect(Buffer.from(withBlanks).equals(Buffer.from(without))).toBe(true);
  });
});

describe("morarente-note", () => {
  const NOTE = "Ved betaling efter forfald tilskrives der renter på 0,81% pr. påbegyndt måned samt et gebyr på 100,00 DKK.";

  test("noten printes når den er opsat", () => {
    const text = drawn(buildIssuedInvoicePdf(invoice({ latePaymentNote: NOTE })));
    expect(text).toContain("Ved betaling efter forfald");
    expect(text).toContain("0,81%");
  });

  test("uden note printes ingenting", () => {
    expect(drawn(buildIssuedInvoicePdf(invoice()))).not.toContain("Ved betaling efter forfald");
  });

  test("en note der kun er mellemrum tæller som fraværende", () => {
    const blank = buildIssuedInvoicePdf(invoice({ latePaymentNote: "   " }));
    const none = buildIssuedInvoicePdf(invoice());
    expect(Buffer.from(blank).equals(Buffer.from(none))).toBe(true);
  });
});

describe("betalingsbetingelser", () => {
  test("antal dage regnes ud af udstedelses- og forfaldsdato", () => {
    const text = drawn(buildIssuedInvoicePdf(invoice({ issueDate: "2026-05-16", dueDate: "2026-05-30" })));
    expect(text).toContain("Betalingsbetingelser: Netto 14 dage (forfald 2026-05-30).");
  });

  test("nul dage er en gyldig frist, ikke en manglende", () => {
    const text = drawn(buildIssuedInvoicePdf(invoice({ issueDate: "2026-05-16", dueDate: "2026-05-16" })));
    expect(text).toContain("Netto 0 dage");
  });

  test("uden forfaldsdato skrives ingen betalingsbetingelse", () => {
    expect(drawn(buildIssuedInvoicePdf(invoice()))).not.toContain("Betalingsbetingelser");
  });

  test("en forfaldsdato FØR udstedelsen falder tilbage til den simple form", () => {
    // Negativt antal dage ville se ud som en fejl på kundens faktura.
    const text = drawn(buildIssuedInvoicePdf(invoice({ issueDate: "2026-05-30", dueDate: "2026-05-16" })));
    expect(text).toContain("Betalingsbetingelser: forfald 2026-05-16.");
    expect(text).not.toContain("-14");
  });

  test("en uparsbar udstedelsesdato falder også tilbage til den simple form", () => {
    const text = drawn(buildIssuedInvoicePdf(invoice({ issueDate: "ikke-en-dato", dueDate: "2026-05-30" })));
    expect(text).toContain("Betalingsbetingelser: forfald 2026-05-30.");
  });
});

describe("PNG-logo i headeren", () => {
  test("et gyldigt logo lægges ind som billede", () => {
    const pdf = buildIssuedInvoicePdf(invoice({ logoText: "Mind AI ApS", logoImage: PNG_BASE64 }));
    const raw = Buffer.from(pdf).toString("latin1");
    expect(raw).toContain("/Subtype /Image");
    expect(raw).toContain("/ColorSpace /DeviceRGB");
  });

  test("med et logo tegnes ordmærket IKKE — ellers stod der begge dele", () => {
    const withLogo = pdfStrings(buildIssuedInvoicePdf(invoice({ logoText: "MIT ORDMÆRKE", logoImage: PNG_BASE64 })));
    expect(withLogo.join("\n")).not.toContain("MIT ORDMÆRKE");
  });

  test("logoet ændrer KUN headeren — al anden tekst er den samme", () => {
    const withLogo = pdfStrings(buildIssuedInvoicePdf(invoice({ logoText: "MIT ORDMÆRKE", logoImage: PNG_BASE64 })));
    const without = pdfStrings(buildIssuedInvoicePdf(invoice({ logoText: "MIT ORDMÆRKE" })));
    expect(without.filter((s) => s !== "MIT ORDMÆRKE")).toEqual(withLogo);
  });

  test("et ULÆSELIGT logo vælter ikke fakturaen — der falder tilbage til ordmærket", () => {
    // Hele begrundelsen for at dekoderen returnerer et resultat i stedet for at
    // kaste: et dårligt logo er kosmetik, en fejlet rendering er det ikke.
    for (const bad of ["ikke-base64!!!", Buffer.from("slet ikke en PNG").toString("base64"), tinyPng(3).toString("base64")]) {
      const pdf = buildIssuedInvoicePdf(invoice({ logoText: "MIT ORDMÆRKE", logoImage: bad }));
      expect(Buffer.from(pdf).toString("latin1").startsWith("%PDF-")).toBe(true);
      expect(pdfStrings(pdf).join("\n")).toContain("MIT ORDMÆRKE");
    }
  });

  test("tomt logoImage er det samme som slet intet logo", () => {
    const blank = buildIssuedInvoicePdf(invoice({ logoText: "MÆRKE", logoImage: "   " }));
    const none = buildIssuedInvoicePdf(invoice({ logoText: "MÆRKE" }));
    expect(Buffer.from(blank).equals(Buffer.from(none))).toBe(true);
  });

  test("uden ordmærke og uden logo bruges sælgerens navn", () => {
    expect(drawn(buildIssuedInvoicePdf(invoice()))).toContain("Mind AI ApS");
  });
});

describe("determinisme med branding", () => {
  test("samme brandede payload giver byte-identisk PDF", () => {
    // Uden dette kan en udstedt faktura ikke gengives identisk år senere.
    const payload = () => invoice({
      seller: brandedSeller(),
      logoText: "Mind AI ApS",
      logoImage: PNG_BASE64,
      latePaymentNote: "Ved betaling efter forfald tilskrives der renter.",
      dueDate: "2026-05-30",
    });
    expect(Buffer.from(buildIssuedInvoicePdf(payload())).equals(Buffer.from(buildIssuedInvoicePdf(payload())))).toBe(true);
  });

  test("PDF'en er velformet med alle brand-elementer på", () => {
    const pdf = buildIssuedInvoicePdf(invoice({
      seller: brandedSeller(), logoText: "Mind AI ApS", logoImage: PNG_BASE64,
      latePaymentNote: "Note.", dueDate: "2026-05-30",
    }));
    const raw = Buffer.from(pdf).toString("latin1");
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(raw).toContain("/Encoding /WinAnsiEncoding");
  });
});
