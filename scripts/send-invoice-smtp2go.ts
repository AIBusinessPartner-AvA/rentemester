#!/usr/bin/env bun
/**
 * Decoupled invoice delivery via the SMTP2GO HTTP API (#DLK-branding).
 *
 * DESIGN (user's idea): keep Rentemester's core untouched. Rentemester issues
 * the invoice (PDF + immutable snapshot) and can dry-run its own `invoice send`
 * for the intent log; THIS standalone script is the separate "pickup" that
 * performs the actual delivery through SMTP2GO afterwards. Because it only
 * READS Rentemester's outputs (the issued snapshot + PDF + config/smtp.json),
 * it needs no change to the synchronous EmailTransport pipeline.
 *
 * Brand-aware sender: the From address is the invoice's own seller.email — i.e.
 * the brand contact printed in the footer (DLK → kontakt@denlanghaaredekonsulent.dk,
 * Mind AI → bogholder@mindai.dk), both approved sender domains on SMTP2GO.
 *
 * SAFETY: dry-run by DEFAULT. It prints exactly what would be sent (API key
 * REDACTED) and transmits nothing. Real delivery requires the explicit --live
 * flag. Every actual send is appended to invoices/smtp2go-delivery.log.
 *
 * Usage:
 *   bun run scripts/send-invoice-smtp2go.ts \
 *     --company <path> --invoice-number <no> --to <recipient@email> [--kind invoice|reminder] [--live]
 */

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(`FEJL: ${msg}`);
  process.exit(1);
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const args = parseArgs(process.argv.slice(2));
const companyRoot = str(args.company) ?? fail("--company <path> er påkrævet");
const invoiceNumber = str(args["invoice-number"]) ?? fail("--invoice-number <no> er påkrævet");
const recipientOverride = str(args.to);
const kind = (str(args.kind) ?? "invoice") as "invoice" | "reminder";
if (kind !== "invoice" && kind !== "reminder") fail("--kind skal være 'invoice' eller 'reminder'");
const live = args.live === true;

// --- Load config/smtp.json (apiKey, fromName, fromAddress fallback) ----------
const smtpPath = join(companyRoot, "config", "smtp.json");
if (!existsSync(smtpPath)) fail(`mangler ${smtpPath}`);
const smtp = JSON.parse(readFileSync(smtpPath, "utf8")) as {
  apiKey?: string;
  fromName?: string;
  fromAddress?: string;
};
const apiKey = str(smtp.apiKey) ?? fail("config/smtp.json mangler 'apiKey' (SMTP2GO API-nøgle)");

// --- Load the issued invoice snapshot + PDF ----------------------------------
const snapshotPath = join(companyRoot, "invoices", "issued", `${invoiceNumber}.json`);
const pdfPath = join(companyRoot, "invoices", "issued", `${invoiceNumber}.pdf`);
if (!existsSync(snapshotPath)) fail(`ingen udstedt faktura: ${snapshotPath}`);
if (!existsSync(pdfPath)) fail(`ingen faktura-PDF: ${pdfPath}`);
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
  seller?: { name?: string; email?: string };
  buyer?: { name?: string; email?: string };
};

// Brand-aware sender: prefer the invoice's own seller.email (the brand contact
// printed on the invoice); fall back to the SMTP config's fromAddress.
const fromEmail = str(snapshot.seller?.email) ?? str(smtp.fromAddress) ?? fail(
  "ingen afsender-mail: fakturaen har ingen seller.email og smtp.json ingen fromAddress",
);
const fromName = str(snapshot.seller?.name) ?? str(smtp.fromName) ?? fromEmail;
const sender = `${fromName} <${fromEmail}>`;

const recipientEmail = recipientOverride ?? str(snapshot.buyer?.email)
  ?? fail("ingen modtager: angiv --to <email> (fakturaen har ingen buyer.email)");
const recipientName = str(snapshot.buyer?.name);
const to = recipientName ? `${recipientName} <${recipientEmail}>` : recipientEmail;

const subject = kind === "reminder"
  ? `Betalingspåmindelse for faktura ${invoiceNumber}`
  : `Faktura ${invoiceNumber}`;
const greeting = recipientName ? `Hej ${recipientName}` : "Hej";
const textBody = kind === "reminder"
  ? `${greeting}\n\nVi kan se at faktura ${invoiceNumber} endnu ikke er registreret som betalt. `
    + `Fakturaen er vedhæftet som PDF — kontakt os gerne, hvis betalingen allerede er gennemført.\n\n`
    + `Med venlig hilsen\n${fromName}\n${fromEmail}`
  : `${greeting}\n\nHermed faktura ${invoiceNumber}, vedhæftet som PDF.\n\n`
    + `Tak for samarbejdet.\n\nMed venlig hilsen\n${fromName}\n${fromEmail}`;

const pdfBase64 = readFileSync(pdfPath).toString("base64");

const payload = {
  api_key: apiKey,
  sender,
  to: [to],
  subject,
  text_body: textBody,
  attachments: [
    { filename: `${invoiceNumber}.pdf`, fileblob: pdfBase64, mimetype: "application/pdf" },
  ],
};

// --- Dry-run (default): show what WOULD be sent, transmit nothing -------------
const redacted = { ...payload, api_key: "***REDACTED***", attachments: [{ filename: `${invoiceNumber}.pdf`, mimetype: "application/pdf", fileblob: `<${pdfBase64.length} base64-tegn>` }] };
console.log(JSON.stringify({ mode: live ? "LIVE" : "DRY-RUN", endpoint: "https://api.smtp2go.com/v3/email/send", from: sender, to, subject, request: redacted }, null, 2));

if (!live) {
  console.log("\nDRY-RUN: intet sendt. Kør igen med --live for at sende via SMTP2GO.");
  process.exit(0);
}

// --- Live send ---------------------------------------------------------------
const res = await fetch("https://api.smtp2go.com/v3/email/send", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify(payload),
}).catch((e) => fail(`netværksfejl mod SMTP2GO: ${(e as Error).message}`));

const bodyText = await res.text();
let parsed: unknown;
try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
const data = (parsed as { data?: { succeeded?: number; failed?: number; failures?: unknown[]; email_id?: string } })?.data;
const ok = res.ok && (data?.succeeded ?? 0) >= 1 && (data?.failed ?? 0) === 0;

const logLine = `${new Date().toISOString()}\t${ok ? "OK" : "FAIL"}\t${invoiceNumber}\t${kind}\t${to}\tfrom=${fromEmail}\temail_id=${data?.email_id ?? "-"}\thttp=${res.status}\n`;
try { appendFileSync(join(companyRoot, "invoices", "smtp2go-delivery.log"), logLine); } catch { /* non-fatal */ }

console.log(`\n${ok ? "✅ SENDT" : "❌ IKKE SENDT"} — HTTP ${res.status}, succeeded=${data?.succeeded ?? "?"}, failed=${data?.failed ?? "?"}`);
if (!ok) {
  console.error("SMTP2GO-svar:", typeof parsed === "string" ? parsed.slice(0, 800) : JSON.stringify(parsed, null, 2).slice(0, 800));
  process.exit(1);
}
console.log(`Logget i invoices/smtp2go-delivery.log (email_id=${data?.email_id ?? "-"}).`);
