/**
 * Composing the invoice / reminder mail (#DLK-branding).
 *
 * Everything here is a pure function of values handed in. Reading brands.json,
 * the template file and the signature file stays with the caller, so the whole
 * composition can be tested without a filesystem — and, more to the point,
 * without sending anything.
 *
 * WHAT IS ACTUALLY AT STAKE: this text goes to a customer under the company's
 * own name, and it cannot be recalled. The failure modes are not crashes, they
 * are embarrassments — an unfilled `{{kontaktnavn}}` in the greeting, a reminder
 * that opens by thanking the customer for their business, a commented-out line
 * from a signature file riding along into the mail. Each of those is covered by
 * a test here.
 *
 * THE BRAND IS RESOLVED FROM THE INVOICE, NOT FROM A FLAG: `seller.email` in the
 * issued snapshot is unique per brand, so the mail's sender, signature and
 * subject follow the invoice that was actually issued. A flag could disagree
 * with the PDF; the snapshot cannot.
 */

import { isAbsolute, join } from "node:path";

export type MailKind = "invoice" | "reminder";

export type BrandMailEntry = {
  name?: string;
  email?: string;
  signaturePath?: string;
};

export type MailConfig = {
  subject?: string;
  templatePath?: string;
  reminderSubject?: string;
  reminderTemplatePath?: string;
};

export type BrandsMailFile = {
  mail?: MailConfig;
  brands?: Record<string, BrandMailEntry>;
};

export type Kontaktperson = { cvr?: string; email?: string; navn?: string };

export const DEFAULT_INVOICE_SUBJECT = "Faktura af {{fakturadato}} fra {{brand}}";
export const DEFAULT_REMINDER_SUBJECT = "Betalingspåmindelse for faktura {{fakturanummer}} fra {{brand}}";

const DA_MONTHS = [
  "januar", "februar", "marts", "april", "maj", "juni",
  "juli", "august", "september", "oktober", "november", "december",
];

/** Trimmed string, or undefined for blank/absent — the same rule everywhere. */
function str(v: string | undefined | null): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** "2026-08-30" → "30. august 2026". Anything unparseable passes through trimmed. */
export function formatDanishDate(iso?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim());
  if (!m) return (iso ?? "").trim();
  return `${Number(m[3])}. ${DA_MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** 4500 → "4.500,00 DKK". Danish grouping and decimal comma. */
export function formatDanishAmount(value: number | undefined, currency = "DKK"): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const fixed = value.toFixed(2);
  const [intPart, dec] = fixed.split(".");
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${grouped},${dec} ${currency}`;
}

/**
 * Replace `{{ felt }}` with its value. An unknown field becomes the empty
 * string rather than staying as `{{felt}}` — a blank in a mail is quiet, a
 * visible placeholder is not.
 */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zæøå]+)\s*\}\}/gi, (_m, key: string) => vars[key.toLowerCase()] ?? "");
}

/**
 * Pull the signature out of an exported HTML file: the part between the
 * SIGNATUR START/SLUT markers if present, otherwise the whole file. HTML
 * comments are stripped either way, so notes and commented-out rows in a
 * hand-maintained signature never ride along into a customer's inbox.
 */
export function extractSignature(html: string): string {
  const m = /<!--\s*SIGNATUR START\s*-->([\s\S]*?)<!--\s*SIGNATUR SLUT\s*-->/i.exec(html);
  const block = m ? m[1]! : html;
  return block.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Find the brand whose mail matches the invoice's seller.email (case-insensitively). */
export function resolveBrandEntry(
  brands: Record<string, BrandMailEntry> | undefined,
  sellerEmail: string | undefined,
): BrandMailEntry | undefined {
  const wanted = str(sellerEmail)?.toLowerCase();
  if (!wanted) return undefined;
  return Object.values(brands ?? {}).find((b) => str(b.email)?.toLowerCase() === wanted);
}

/** Compare VAT/CVR identifiers ignoring case, spaces and punctuation. */
function normalizeVat(v: string | undefined): string | undefined {
  return str(v)?.toUpperCase().replace(/[^A-Z0-9]/g, "") || undefined;
}

/**
 * The first name for the greeting.
 *
 * Order: an explicit `--attention` always wins, then the contact register
 * (matched on the buyer's VAT number, else on the recipient mail), then the
 * buyer's company name, and finally the word "kunde" so the greeting is never
 * left dangling.
 */
export function resolveContactName(args: {
  attention?: string;
  contacts?: Kontaktperson[];
  buyerVatOrCvr?: string;
  recipientEmail: string;
  buyerName?: string;
}): string {
  const attention = str(args.attention);
  if (attention) return attention;

  const buyerVat = normalizeVat(args.buyerVatOrCvr);
  const mail = args.recipientEmail.toLowerCase();
  const hit = (args.contacts ?? []).find((k) => {
    const byVat = Boolean(buyerVat) && normalizeVat(k.cvr) === buyerVat;
    const byMail = str(k.email)?.toLowerCase() === mail;
    return byVat || byMail;
  });
  return str(hit?.navn) ?? str(args.buyerName) ?? "kunde";
}

export function buildMergeFields(args: {
  contactName: string;
  brandName: string;
  invoiceNumber: string;
  issueDate?: string;
  grossAmount?: number;
  currency?: string;
  signatureHtml?: string;
}): Record<string, string> {
  return {
    kontaktnavn: args.contactName,
    brand: args.brandName,
    fakturanummer: args.invoiceNumber,
    fakturadato: formatDanishDate(args.issueDate),
    "beløb": formatDanishAmount(args.grossAmount, (args.currency ?? "DKK").toUpperCase()),
    signatur: args.signatureHtml ?? "",
  };
}

/** Where a configured template lives: absolute as given, otherwise under the company root. */
export function resolveTemplatePath(companyRoot: string, templateRel: string | undefined): string | undefined {
  const rel = str(templateRel);
  if (!rel) return undefined;
  return isAbsolute(rel) ? rel : join(companyRoot, rel);
}

/** Which template file this kind of mail uses, if any is configured. */
export function templateRelFor(mail: MailConfig | undefined, kind: MailKind): string | undefined {
  return kind === "reminder" ? mail?.reminderTemplatePath : mail?.templatePath;
}

export function subjectTemplateFor(mail: MailConfig | undefined, kind: MailKind): string {
  return kind === "reminder"
    ? (mail?.reminderSubject ?? DEFAULT_REMINDER_SUBJECT)
    : (mail?.subject ?? DEFAULT_INVOICE_SUBJECT);
}

export type ComposedMail = {
  subject: string;
  htmlBody: string;
  textBody: string;
};

/**
 * Build subject and both bodies.
 *
 * `template` is the CONTENT of the configured template file, already read by
 * the caller, or undefined when there is none. Undefined falls back to a
 * built-in body — which is what a reminder normally uses, since most setups
 * only template the invoice mail.
 */
export function composeMail(args: {
  kind: MailKind;
  vars: Record<string, string>;
  mail?: MailConfig;
  template?: string;
  signatureHtml?: string;
  fromName: string;
  fromEmail: string;
}): ComposedMail {
  const { kind, vars } = args;
  const signatureHtml = args.signatureHtml ?? "";
  const subject = fillTemplate(subjectTemplateFor(args.mail, kind), vars);

  let htmlBody: string;
  if (args.template !== undefined) {
    // Comments are stripped BEFORE filling, so a commented-out merge field
    // cannot smuggle a value into the mail.
    htmlBody = fillTemplate(args.template.replace(/<!--[\s\S]*?-->/g, ""), vars);
  } else {
    const intro = kind === "reminder"
      ? `<p>Vi kan se at faktura ${vars.fakturanummer} endnu ikke er registreret som betalt. Fakturaen er vedhæftet som PDF — kontakt os gerne, hvis betalingen allerede er gennemført.</p>`
      : `<p>Tusind tak, fordi du har valgt at være kunde hos ${vars.brand}.</p><p>Her er din faktura ${vars.fakturanummer} på ${vars["beløb"]}.</p><p>Fakturaen er vedhæftet denne mail som PDF.</p>`;
    htmlBody = `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5; color: #101820;"><p>Hej ${vars.kontaktnavn}</p>${intro}${signatureHtml}</div>`;
  }

  const textBody = [
    `Hej ${vars.kontaktnavn}`,
    "",
    kind === "reminder"
      ? `Vi kan se at faktura ${vars.fakturanummer} endnu ikke er registreret som betalt. Fakturaen er vedhæftet som PDF.`
      : `Tusind tak, fordi du har valgt at være kunde hos ${vars.brand}.\n\nHer er din faktura ${vars.fakturanummer} på ${vars["beløb"]}. Fakturaen er vedhæftet som PDF.`,
    "",
    "Med venlig hilsen",
    args.fromName,
    args.fromEmail,
  ].join("\n");

  return { subject, htmlBody, textBody };
}
