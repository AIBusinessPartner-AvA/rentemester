// Tests: src/core/invoice-mail.ts — emne og kroppe i faktura- og rykkermails.
//
// Fejlene her er ikke nedbrud, de er pinligheder — og de kan ikke kaldes
// tilbage, når mailen først er hos kunden. Et uudfyldt {{kontaktnavn}} i
// hilsenen. En rykker der åbner med at takke kunden for samarbejdet. En
// udkommenteret linje fra en signaturfil der rider med ud. Hver af dem har sin
// egen test herunder.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_INVOICE_SUBJECT,
  DEFAULT_REMINDER_SUBJECT,
  buildMergeFields,
  composeMail,
  extractSignature,
  fillTemplate,
  formatDanishAmount,
  formatDanishDate,
  resolveBrandEntry,
  resolveContactName,
  resolveTemplatePath,
  subjectTemplateFor,
  templateRelFor,
} from "../../src/core/invoice-mail";

const VARS = {
  kontaktnavn: "Tue",
  brand: "Mind AI ApS",
  fakturanummer: "2026-27-0001",
  fakturadato: "30. august 2026",
  "beløb": "4.500,00 DKK",
  signatur: "<p>Venlig hilsen</p>",
};

describe("formatDanishDate", () => {
  test("ISO bliver til dansk skrivemåde", () => {
    expect(formatDanishDate("2026-08-30")).toBe("30. august 2026");
    expect(formatDanishDate("2026-01-01")).toBe("1. januar 2026");
    expect(formatDanishDate("2026-12-31")).toBe("31. december 2026");
  });

  test("dagen mister sit foranstillede nul", () => {
    expect(formatDanishDate("2026-03-05")).toBe("5. marts 2026");
  });

  test("alle tolv måneder staves rigtigt", () => {
    const names = [...Array(12)].map((_, i) =>
      formatDanishDate(`2026-${String(i + 1).padStart(2, "0")}-01`).split(" ")[1]);
    expect(names).toEqual([
      "januar", "februar", "marts", "april", "maj", "juni",
      "juli", "august", "september", "oktober", "november", "december",
    ]);
  });

  test("uparsbart input går uændret igennem i stedet for at blive gættet", () => {
    expect(formatDanishDate("30-08-2026")).toBe("30-08-2026");
    expect(formatDanishDate("")).toBe("");
    expect(formatDanishDate(undefined)).toBe("");
  });
});

describe("formatDanishAmount", () => {
  test("dansk tusindtalsseparator og decimalkomma", () => {
    expect(formatDanishAmount(4500)).toBe("4.500,00 DKK");
    expect(formatDanishAmount(1234567.89)).toBe("1.234.567,89 DKK");
  });

  test("små beløb får ingen separator", () => {
    expect(formatDanishAmount(0)).toBe("0,00 DKK");
    expect(formatDanishAmount(999)).toBe("999,00 DKK");
    expect(formatDanishAmount(1000)).toBe("1.000,00 DKK");
  });

  test("ører rundes til to decimaler", () => {
    expect(formatDanishAmount(33.255)).toBe("33,26 DKK");
    expect(formatDanishAmount(0.5)).toBe("0,50 DKK");
  });

  test("valutaen kan skiftes", () => {
    expect(formatDanishAmount(105.2, "EUR")).toBe("105,20 EUR");
  });

  test("manglende eller ugyldigt beløb bliver til tom streng, ikke NaN", () => {
    // "NaN DKK" i en fakturamail er værre end ingenting.
    expect(formatDanishAmount(undefined)).toBe("");
    expect(formatDanishAmount(Number.NaN)).toBe("");
    expect(formatDanishAmount(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("fillTemplate", () => {
  test("erstatter flettefelter", () => {
    expect(fillTemplate("Hej {{kontaktnavn}}", VARS)).toBe("Hej Tue");
  });

  test("tåler mellemrum inde i tuborgparenteserne", () => {
    expect(fillTemplate("{{ kontaktnavn }}", VARS)).toBe("Tue");
  });

  test("felter er ikke versalfølsomme", () => {
    expect(fillTemplate("{{KontaktNavn}}", VARS)).toBe("Tue");
  });

  test("danske bogstaver i feltnavne virker", () => {
    expect(fillTemplate("{{beløb}}", VARS)).toBe("4.500,00 DKK");
  });

  test("ukendt felt bliver tomt — aldrig en synlig pladsholder", () => {
    // En blank plads er stille; "{{fornavn}}" i kundens indbakke er ikke.
    expect(fillTemplate("Hej {{fornavn}}!", VARS)).toBe("Hej !");
  });

  test("flere forekomster af samme felt erstattes alle", () => {
    expect(fillTemplate("{{brand}} og {{brand}}", VARS)).toBe("Mind AI ApS og Mind AI ApS");
  });

  test("tekst uden felter er uændret", () => {
    expect(fillTemplate("<p>Ingen felter her</p>", VARS)).toBe("<p>Ingen felter her</p>");
  });
});

describe("extractSignature", () => {
  test("tager kun blokken mellem markørerne", () => {
    const html = `<html><body>FØR<!-- SIGNATUR START --><p>Anders</p><!-- SIGNATUR SLUT -->EFTER</body></html>`;
    expect(extractSignature(html)).toBe("<p>Anders</p>");
  });

  test("uden markører bruges hele filen", () => {
    expect(extractSignature("  <p>Anders</p>  ")).toBe("<p>Anders</p>");
  });

  test("HTML-kommentarer strippes — også uden markører", () => {
    // En udkommenteret linje i en håndholdt signaturfil må aldrig ende hos
    // kunden, hverken synligt eller i kildeteksten.
    const html = "<p>Anders</p><!-- gammelt telefonnummer: 12345678 -->";
    const out = extractSignature(html);
    expect(out).not.toContain("12345678");
    expect(out).not.toContain("<!--");
  });

  test("kommentarer inde i signaturblokken strippes også", () => {
    const html = `<!-- SIGNATUR START --><p>A</p><!-- note --><p>B</p><!-- SIGNATUR SLUT -->`;
    expect(extractSignature(html)).toBe("<p>A</p><p>B</p>");
  });

  test("markørerne er ikke versalfølsomme", () => {
    const html = `<!-- signatur start --><p>A</p><!-- signatur slut -->`;
    expect(extractSignature(html)).toBe("<p>A</p>");
  });

  test("tom fil giver tom signatur", () => {
    expect(extractSignature("")).toBe("");
  });
});

describe("resolveBrandEntry", () => {
  const brands = {
    dlk: { name: "Den langhårede konsulent ApS", email: "kontakt@eksempel.dk" },
    mindai: { name: "Mind AI ApS", email: "bogholder@andeteksempel.dk" },
  };

  test("finder brandet ud fra fakturaens seller.email", () => {
    expect(resolveBrandEntry(brands, "bogholder@andeteksempel.dk")?.name).toBe("Mind AI ApS");
    expect(resolveBrandEntry(brands, "kontakt@eksempel.dk")?.name).toBe("Den langhårede konsulent ApS");
  });

  test("mailen sammenlignes uden hensyn til store bogstaver", () => {
    expect(resolveBrandEntry(brands, "Bogholder@AndetEksempel.DK")?.name).toBe("Mind AI ApS");
  });

  test("ukendt eller manglende mail giver intet brand", () => {
    expect(resolveBrandEntry(brands, "ingen@eksempel.dk")).toBeUndefined();
    expect(resolveBrandEntry(brands, undefined)).toBeUndefined();
    expect(resolveBrandEntry(brands, "   ")).toBeUndefined();
    expect(resolveBrandEntry(undefined, "kontakt@eksempel.dk")).toBeUndefined();
  });
});

describe("resolveContactName", () => {
  const contacts = [
    { cvr: "DK42378291", email: "tue@eksempel.dk", navn: "Tue" },
    { email: "kun-mail@eksempel.dk", navn: "Mette" },
  ];

  test("--attention vinder over alt andet", () => {
    expect(resolveContactName({
      attention: "Jens", contacts, buyerVatOrCvr: "DK42378291",
      recipientEmail: "tue@eksempel.dk", buyerName: "Grønne Leverum ApS",
    })).toBe("Jens");
  });

  test("slår op på køberens CVR", () => {
    expect(resolveContactName({
      contacts, buyerVatOrCvr: "DK42378291",
      recipientEmail: "en-helt-anden@eksempel.dk", buyerName: "Grønne Leverum ApS",
    })).toBe("Tue");
  });

  test("CVR sammenlignes uden mellemrum og tegnsætning", () => {
    expect(resolveContactName({
      contacts, buyerVatOrCvr: "dk 42 37 82 91",
      recipientEmail: "x@eksempel.dk", buyerName: "Firma",
    })).toBe("Tue");
  });

  test("slår op på modtagermail når CVR ikke matcher", () => {
    expect(resolveContactName({
      contacts, buyerVatOrCvr: "DK99999999",
      recipientEmail: "kun-mail@eksempel.dk", buyerName: "Firma",
    })).toBe("Mette");
  });

  test("uden match bruges køberens firmanavn", () => {
    expect(resolveContactName({
      contacts, buyerVatOrCvr: "DK99999999",
      recipientEmail: "ukendt@eksempel.dk", buyerName: "Grønne Leverum ApS",
    })).toBe("Grønne Leverum ApS");
  });

  test("uden noget som helst bliver hilsenen 'kunde' — aldrig tom", () => {
    // "Hej " med efterfølgende ingenting er værre end en generisk hilsen.
    expect(resolveContactName({ recipientEmail: "x@eksempel.dk" })).toBe("kunde");
  });

  test("tom kontaktliste falder pænt igennem", () => {
    expect(resolveContactName({
      contacts: [], recipientEmail: "x@eksempel.dk", buyerName: "Firma",
    })).toBe("Firma");
  });

  test("en kontakt uden navn springes over", () => {
    expect(resolveContactName({
      contacts: [{ email: "x@eksempel.dk" }],
      recipientEmail: "x@eksempel.dk", buyerName: "Firma",
    })).toBe("Firma");
  });
});

describe("buildMergeFields", () => {
  test("samler alle seks felter", () => {
    const vars = buildMergeFields({
      contactName: "Tue", brandName: "Mind AI ApS", invoiceNumber: "2026-27-0001",
      issueDate: "2026-08-30", grossAmount: 4500, currency: "dkk",
      signatureHtml: "<p>sig</p>",
    });
    expect(vars).toEqual({
      kontaktnavn: "Tue",
      brand: "Mind AI ApS",
      fakturanummer: "2026-27-0001",
      fakturadato: "30. august 2026",
      "beløb": "4.500,00 DKK",
      signatur: "<p>sig</p>",
    });
  });

  test("valutakoden sættes med versaler", () => {
    const vars = buildMergeFields({
      contactName: "A", brandName: "B", invoiceNumber: "1", grossAmount: 1, currency: "eur",
    });
    expect(vars["beløb"]).toBe("1,00 EUR");
  });

  test("uden signatur er feltet tomt, ikke undefined", () => {
    const vars = buildMergeFields({ contactName: "A", brandName: "B", invoiceNumber: "1" });
    expect(vars.signatur).toBe("");
  });
});

describe("subjectTemplateFor / templateRelFor", () => {
  const mail = {
    subject: "Egen faktura-emnelinje",
    reminderSubject: "Egen rykker-emnelinje",
    templatePath: "config/faktura.html",
    reminderTemplatePath: "config/rykker.html",
  };

  test("de to slags mail har hver sin emnelinje og skabelon", () => {
    expect(subjectTemplateFor(mail, "invoice")).toBe("Egen faktura-emnelinje");
    expect(subjectTemplateFor(mail, "reminder")).toBe("Egen rykker-emnelinje");
    expect(templateRelFor(mail, "invoice")).toBe("config/faktura.html");
    expect(templateRelFor(mail, "reminder")).toBe("config/rykker.html");
  });

  test("uden opsætning bruges de indbyggede emnelinjer", () => {
    expect(subjectTemplateFor(undefined, "invoice")).toBe(DEFAULT_INVOICE_SUBJECT);
    expect(subjectTemplateFor(undefined, "reminder")).toBe(DEFAULT_REMINDER_SUBJECT);
    expect(subjectTemplateFor({}, "reminder")).toBe(DEFAULT_REMINDER_SUBJECT);
  });

  test("en rykker uden egen skabelon får ingen — og dermed fallback-kroppen", () => {
    expect(templateRelFor({ templatePath: "config/faktura.html" }, "reminder")).toBeUndefined();
  });
});

describe("resolveTemplatePath", () => {
  test("relativ sti lægges under virksomhedens mappe", () => {
    const path = resolveTemplatePath("/firma", "config/faktura.html");
    expect(path).toContain("firma");
    expect(path).toContain("faktura.html");
  });

  test("absolut sti bruges som den er", () => {
    const abs = process.platform === "win32" ? "C:\\andetsted\\f.html" : "/andetsted/f.html";
    expect(resolveTemplatePath("/firma", abs)).toBe(abs);
  });

  test("ingen sti opsat giver undefined", () => {
    expect(resolveTemplatePath("/firma", undefined)).toBeUndefined();
    expect(resolveTemplatePath("/firma", "  ")).toBeUndefined();
  });
});

describe("composeMail — emnelinjen", () => {
  const base = { vars: VARS, fromName: "Mind AI ApS", fromEmail: "bogholder@eksempel.dk" };

  test("fakturaens emne bruger dato og brand", () => {
    const mail = composeMail({ ...base, kind: "invoice" });
    expect(mail.subject).toBe("Faktura af 30. august 2026 fra Mind AI ApS");
  });

  test("rykkerens emne bruger fakturanummer og brand", () => {
    const mail = composeMail({ ...base, kind: "reminder" });
    expect(mail.subject).toBe("Betalingspåmindelse for faktura 2026-27-0001 fra Mind AI ApS");
  });

  test("en egen emnelinje fra brands.json bruges og flettes", () => {
    const mail = composeMail({
      ...base, kind: "invoice", mail: { subject: "{{brand}}: faktura {{fakturanummer}}" },
    });
    expect(mail.subject).toBe("Mind AI ApS: faktura 2026-27-0001");
  });

  test("emnet indeholder aldrig et uudfyldt flettefelt", () => {
    const mail = composeMail({
      ...base, kind: "invoice", mail: { subject: "Faktura {{findesikke}}" },
    });
    expect(mail.subject).not.toContain("{{");
  });
});

describe("composeMail — kroppen fra skabelon", () => {
  const base = { vars: VARS, fromName: "Mind AI ApS", fromEmail: "bogholder@eksempel.dk" };

  test("skabelonen flettes med felterne", () => {
    const mail = composeMail({
      ...base, kind: "invoice",
      template: "<p>Hej {{kontaktnavn}}</p><p>{{beløb}}</p>{{signatur}}",
    });
    expect(mail.htmlBody).toBe("<p>Hej Tue</p><p>4.500,00 DKK</p><p>Venlig hilsen</p>");
  });

  test("kommentarer i skabelonen strippes FØR fletning", () => {
    // Rækkefølgen er pointen: ellers ville et udkommenteret felt kunne smugle
    // en værdi med ud i mailen.
    const mail = composeMail({
      ...base, kind: "invoice",
      template: "<p>Hej {{kontaktnavn}}</p><!-- {{beløb}} intern note -->",
    });
    expect(mail.htmlBody).toBe("<p>Hej Tue</p>");
    expect(mail.htmlBody).not.toContain("4.500");
    expect(mail.htmlBody).not.toContain("intern note");
  });

  test("en tom skabelonfil giver en tom krop — ikke fallback", () => {
    // Tom fil er et valg; manglende fil er fravær af et valg. De to må ikke
    // forveksles.
    const mail = composeMail({ ...base, kind: "invoice", template: "" });
    expect(mail.htmlBody).toBe("");
  });
});

describe("composeMail — den indbyggede fallback-krop", () => {
  const base = { vars: VARS, fromName: "Mind AI ApS", fromEmail: "bogholder@eksempel.dk" };

  test("fakturaen takker kunden og nævner beløbet", () => {
    const mail = composeMail({ ...base, kind: "invoice" });
    expect(mail.htmlBody).toContain("Hej Tue");
    expect(mail.htmlBody).toContain("Tusind tak");
    expect(mail.htmlBody).toContain("4.500,00 DKK");
    expect(mail.htmlBody).toContain("2026-27-0001");
  });

  test("rykkeren takker IKKE — den siger at fakturaen ikke er registreret betalt", () => {
    // Den værste enkeltfejl i hele filen ville være en rykker der åbner med
    // "Tusind tak, fordi du har valgt at være kunde hos os".
    const mail = composeMail({ ...base, kind: "reminder" });
    expect(mail.htmlBody).not.toContain("Tusind tak");
    expect(mail.htmlBody).toContain("endnu ikke er registreret som betalt");
    expect(mail.textBody).not.toContain("Tusind tak");
  });

  test("rykkeren nævner hverken gebyr eller renter", () => {
    const mail = composeMail({ ...base, kind: "reminder" });
    for (const word of ["gebyr", "rente", "morarente", "inkasso"]) {
      expect(mail.htmlBody.toLowerCase()).not.toContain(word);
      expect(mail.textBody.toLowerCase()).not.toContain(word);
    }
  });

  test("rykkeren inviterer til at sige til, hvis der allerede er betalt", () => {
    const mail = composeMail({ ...base, kind: "reminder" });
    expect(mail.htmlBody).toContain("hvis betalingen allerede er gennemført");
  });

  test("signaturen sættes ind i fallback-kroppen", () => {
    const mail = composeMail({ ...base, kind: "invoice", signatureHtml: "<p>SIG</p>" });
    expect(mail.htmlBody).toContain("<p>SIG</p>");
  });

  test("uden signatur bliver kroppen stadig gyldig HTML", () => {
    const mail = composeMail({ ...base, kind: "invoice" });
    expect(mail.htmlBody.startsWith("<div")).toBe(true);
    expect(mail.htmlBody.endsWith("</div>")).toBe(true);
  });
});

describe("composeMail — tekstkroppen", () => {
  const base = { vars: VARS, fromName: "Mind AI ApS", fromEmail: "bogholder@eksempel.dk" };

  test("starter med hilsenen og slutter med afsenderen", () => {
    const mail = composeMail({ ...base, kind: "invoice" });
    const lines = mail.textBody.split("\n");
    expect(lines[0]).toBe("Hej Tue");
    expect(lines[lines.length - 2]).toBe("Mind AI ApS");
    expect(lines[lines.length - 1]).toBe("bogholder@eksempel.dk");
  });

  test("indeholder ingen HTML — heller ikke signaturens", () => {
    // Tekstdelen læses af klienter der ikke viser HTML; tags dér ser ud som
    // rod, ikke som formatering.
    const mail = composeMail({ ...base, kind: "invoice", signatureHtml: "<p>SIG</p>" });
    expect(mail.textBody).not.toContain("<");
  });

  test("tekstkroppen følger skabelonen når den findes — den er altid fallback", () => {
    // Skabelonen gælder kun HTML-delen; tekstdelen er den samme uanset.
    const withTemplate = composeMail({ ...base, kind: "invoice", template: "<p>helt anderledes</p>" });
    const without = composeMail({ ...base, kind: "invoice" });
    expect(withTemplate.textBody).toBe(without.textBody);
  });
});

describe("composeMail — hilsenen er aldrig tom", () => {
  test("et tomt kontaktnavn ville være synligt, så det må ikke opstå", () => {
    // resolveContactName garanterer et navn; denne test dokumenterer hvad der
    // ville ske hvis garantien blev brudt, så fejlen fanges her og ikke hos en
    // kunde.
    const name = resolveContactName({ recipientEmail: "x@eksempel.dk" });
    const mail = composeMail({
      kind: "invoice",
      vars: buildMergeFields({ contactName: name, brandName: "B", invoiceNumber: "1" }),
      fromName: "B", fromEmail: "b@eksempel.dk",
    });
    expect(mail.htmlBody).toContain("Hej kunde");
    expect(mail.htmlBody).not.toContain("Hej </p>");
  });
});
