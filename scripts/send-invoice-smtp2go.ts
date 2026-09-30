#!/usr/bin/env bun
/**
 * Decoupled invoice delivery via the SMTP2GO HTTP API (#DLK-branding).
 *
 * DESIGN (user's idea): keep Rentemester's core untouched. Rentemester issues
 * the invoice (PDF + immutable snapshot); THIS standalone script is the separate
 * "pickup" that delivers it through SMTP2GO afterwards. It only READS Rentemester
 * outputs (issued snapshot + PDF + config/*), so no async change to the core.
 *
 * The mail is composed from an EDITABLE template (config/faktura-mail.html) with
 * {{ }} merge fields filled from the invoice, plus the BRAND's own HTML signature
 * (config/brands.json → signaturePath). Brand is resolved from the invoice's
 * seller.email, so DLK and Mind AI each get their own sender, signature and logo.
 * Nothing about the mail body is hardcoded here except the plain-text fallback.
 *
 * SAFETY: dry-run by DEFAULT (prints what would be sent, API key REDACTED,
 * transmits nothing). Real delivery requires --live. Each live send is appended
 * to invoices/smtp2go-delivery.log.
 *
 * Usage:
 *   bun run scripts/send-invoice-smtp2go.ts \
 *     --company <path> --invoice-number <no> --to <recipient@email> [--kind invoice|reminder] [--live]
 *   Add --attention <name> to greet a person instead of the buyer company.
 *   Add --html-out <file> to also write the rendered HTML body for inspection.
 *   Add --schedule "2026-09-01 08:00" (local time, or ISO 8601 with a zone) to
 *   have SMTP2GO hold the mail and deliver it later — max 3 days ahead.
 *   --schedule next picks the next slot inside the send window.
 *
 * SEND WINDOW: delivery must fall on a weekday between 08:00 and 15:00 local
 * time. --live outside that window is refused (override: --ignore-send-window);
 * dry-run only warns, so an invoice can be prepared and reviewed at any hour.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  WINDOW_LABEL,
  formatLocal,
  insideSendWindow,
  nextSendSlot,
  parseSchedule,
} from "../src/core/send-window";
import {
  SMTP2GO_SEND_ENDPOINT,
  buildSmtp2goPayload,
  formatDeliveryLogLine,
  sendViaSmtp2go,
} from "../src/core/smtp2go";
import {
  type BrandsMailFile,
  type Kontaktperson,
  buildMergeFields,
  composeMail,
  extractSignature,
  resolveBrandEntry,
  resolveContactName,
  resolveTemplatePath,
  templateRelFor,
} from "../src/core/invoice-mail";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}
function fail(msg: string): never { console.error(`FEJL: ${msg}`); process.exit(1); }
function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// Selve mailkompositionen — datoer, beløb, flettefelter, emne og kroppe — bor i
// src/core/invoice-mail.ts som rene funktioner. Her læses kun filerne.

const args = parseArgs(process.argv.slice(2));
const companyRoot = str(args.company) ?? fail("--company <path> er påkrævet");
const invoiceNumber = str(args["invoice-number"]) ?? fail("--invoice-number <no> er påkrævet");
const recipientOverride = str(args.to);
const kind = (str(args.kind) ?? "invoice") as "invoice" | "reminder";
if (kind !== "invoice" && kind !== "reminder") fail("--kind skal være 'invoice' eller 'reminder'");
const live = args.live === true;
const htmlOut = str(args["html-out"]);
const actor = str(args.actor) ?? "user:anders";
// Hilsenen i mailen. Uden --attention bruges køberens navn fra fakturaen, og så
// står der "Hej <firmanavn> ApS" — korrekt på selve fakturaen, men stift i en
// mail til et menneske. --attention "Tue" retter KUN hilsenen; fakturaens PDF og
// snapshot er udstedt og urørlige, og modtagerlinjen beholder firmanavnet.
const attention = str(args.attention);

// --- Afsendelsestidspunkt ----------------------------------------------------
// Reglerne selv bor i src/core/send-window.ts, så de kan testes uden at køre
// dette script. Her tages kun beslutningen om at afbryde.
//
// Vinduet (hverdage 08-15) gælder LEVERINGStidspunktet: med --schedule er det
// det planlagte tidspunkt, ellers "nu". Det blokerer kun faktisk afsendelse
// (--live) — dry-run advarer, men kører, så en faktura kan klargøres og
// gennemses når som helst.
const scheduleRaw = str(args.schedule);
// --schedule next = "næste gyldige tidspunkt i afsendelsesvinduet", så man
// slipper for selv at regne weekender og lukketid ud.
let scheduleAt: Date | undefined;
if (scheduleRaw === "next") {
  scheduleAt = nextSendSlot(new Date());
} else if (scheduleRaw) {
  const parsed = parseSchedule(scheduleRaw, new Date());
  if (!parsed.ok) fail(parsed.error);
  scheduleAt = parsed.when;
}
const schedule = scheduleAt ? `${scheduleAt.toISOString().slice(0, 19)}Z` : undefined;

const ignoreWindow = args["ignore-send-window"] === true;
const deliveryAt = scheduleAt ?? new Date();
const windowOk = insideSendWindow(deliveryAt);
if (!windowOk && live && !ignoreWindow) {
  fail(
    `afsendelsesvinduet er ${WINDOW_LABEL}, og ${formatLocal(deliveryAt)} ligger udenfor.\n` +
    `  Næste gyldige tidspunkt: --schedule "${formatLocal(nextSendSlot(deliveryAt))}"  (eller blot --schedule next)\n` +
    `  Skal den afsted alligevel: --ignore-send-window`,
  );
}

// --- config/smtp.json --------------------------------------------------------
const smtpPath = join(companyRoot, "config", "smtp.json");
if (!existsSync(smtpPath)) fail(`mangler ${smtpPath}`);
const smtp = JSON.parse(readFileSync(smtpPath, "utf8")) as { apiKey?: string; fromName?: string; fromAddress?: string };
const apiKey = str(smtp.apiKey) ?? fail("config/smtp.json mangler 'apiKey' (SMTP2GO API-nøgle)");

// --- issued invoice snapshot + PDF ------------------------------------------
const snapshotPath = join(companyRoot, "invoices", "issued", `${invoiceNumber}.json`);
const pdfPath = join(companyRoot, "invoices", "issued", `${invoiceNumber}.pdf`);
if (!existsSync(snapshotPath)) fail(`ingen udstedt faktura: ${snapshotPath}`);
if (!existsSync(pdfPath)) fail(`ingen faktura-PDF: ${pdfPath}`);
const snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
  seller?: { name?: string; email?: string };
  buyer?: { name?: string; email?: string; vatOrCvr?: string };
  issueDate?: string;
  currency?: string;
  totals?: { grossAmount?: number };
};

// --- config/brands.json (mail template + subject + per-brand signature) ------
const brandsPath = join(companyRoot, "config", "brands.json");
const brandsCfg: BrandsMailFile = existsSync(brandsPath)
  ? (JSON.parse(readFileSync(brandsPath, "utf8")) as BrandsMailFile)
  : {};

// Brandet udledes af fakturaens seller.email (unik pr. brand), ikke af et flag:
// et flag kunne være uenigt med den PDF der rent faktisk blev udstedt.
const sellerEmail = str(snap.seller?.email);
const brandEntry = resolveBrandEntry(brandsCfg.brands, sellerEmail);

const fromEmail = sellerEmail ?? str(smtp.fromAddress) ?? fail("ingen afsender-mail (seller.email/fromAddress mangler)");
const fromName = str(snap.seller?.name) ?? str(smtp.fromName) ?? fromEmail;
const sender = `${fromName} <${fromEmail}>`;

const recipientEmail = recipientOverride ?? str(snap.buyer?.email) ?? fail("ingen modtager: angiv --to <email>");
const recipientName = str(snap.buyer?.name);
const to = recipientName ? `${recipientName} <${recipientEmail}>` : recipientEmail;

// --- config/kontaktpersoner.json (hilsenens fornavn pr. kunde) ---------------
// Rentemesters kundekartotek har intet kontaktperson-felt, og customers er
// append-only uden update-kommando. Denne fil ligger derfor ved siden af
// bogføringen: den er ren præsentation og rører hverken ledger eller
// revisionsspor. Slås op på køberens CVR, ellers på modtagermailen.
const kontaktPath = join(companyRoot, "config", "kontaktpersoner.json");
const kontaktCfg: { kontakter?: Kontaktperson[] } = existsSync(kontaktPath)
  ? (JSON.parse(readFileSync(kontaktPath, "utf8")) as { kontakter?: Kontaktperson[] })
  : {};

// Brandets signatur (udtrukket og kommentar-strippet). Tom hvis ikke opsat.
let signatureHtml = "";
const sigPath = str(brandEntry?.signaturePath);
if (sigPath && existsSync(sigPath)) signatureHtml = extractSignature(readFileSync(sigPath, "utf8"));
else if (sigPath) console.error(`ADVARSEL: signaturePath findes ikke: ${sigPath} (mail sendes uden signatur)`);

// --- merge fields ------------------------------------------------------------
const vars = buildMergeFields({
  contactName: resolveContactName({
    attention,
    contacts: kontaktCfg.kontakter,
    buyerVatOrCvr: snap.buyer?.vatOrCvr,
    recipientEmail,
    buyerName: recipientName,
  }),
  brandName: fromName,
  invoiceNumber,
  issueDate: snap.issueDate,
  grossAmount: snap.totals?.grossAmount,
  currency: snap.currency,
  signatureHtml,
});

// --- emne + kroppe -----------------------------------------------------------
const mailCfg = brandsCfg.mail ?? {};
const templatePath = resolveTemplatePath(companyRoot, templateRelFor(mailCfg, kind));
const template = templatePath && existsSync(templatePath)
  ? readFileSync(templatePath, "utf8")
  : undefined;
const { subject, htmlBody, textBody } = composeMail({
  kind, vars, mail: mailCfg, template, signatureHtml, fromName, fromEmail,
});

if (htmlOut) { writeFileSync(htmlOut, htmlBody); console.log(`HTML-body skrevet til ${htmlOut}`); }

const pdfBase64 = readFileSync(pdfPath).toString("base64");
const payload = buildSmtp2goPayload({
  apiKey,
  sender,
  to,
  subject,
  htmlBody,
  textBody,
  attachmentFilename: `${invoiceNumber}.pdf`,
  attachmentBase64: pdfBase64,
  schedule,
});

// --- dry-run (default) -------------------------------------------------------
console.log(JSON.stringify({
  mode: live ? "LIVE" : "DRY-RUN",
  endpoint: SMTP2GO_SEND_ENDPOINT,
  from: sender, to, subject,
  levering: schedule ? `PLANLAGT ${schedule} (= ${formatLocal(deliveryAt)} lokal tid)` : "straks",
  afsendelsesvindue: windowOk
    ? `OK — ${formatLocal(deliveryAt)} er inden for ${WINDOW_LABEL}`
    : `⚠️  UDEN FOR ${WINDOW_LABEL} (${formatLocal(deliveryAt)}). --live vil blive afvist. Næste slot: "${formatLocal(nextSendSlot(deliveryAt))}"`,
  brand_matched: brandEntry ? (brandEntry.name ?? "(unnamed)") : "(ingen brand-match — ingen signatur)",
  merge_fields: vars,
  html_body_length: htmlBody.length,
  api_key: "***REDACTED***",
}, null, 2));

if (!live) { console.log("\nDRY-RUN: intet sendt. Kør igen med --live for at sende via SMTP2GO."); process.exit(0); }

// --- live send ---------------------------------------------------------------
// Kaldet og fortolkningen af svaret bor i src/core/smtp2go.ts, så reglen om
// hvornår SMTP2GO reelt har taget ansvar for mailen kan testes mod en fake i
// stedet for kun at kunne afprøves ved at sende til en rigtig kunde.
const outcome = await sendViaSmtp2go(payload);
if (outcome.networkError) fail(`netværksfejl mod SMTP2GO: ${outcome.networkError}`);

const logLine = formatDeliveryLogLine({
  at: new Date(), outcome, invoiceNumber, kind, to, fromEmail, schedule,
});
try { appendFileSync(join(companyRoot, "invoices", "smtp2go-delivery.log"), logLine); } catch { /* non-fatal */ }

if (outcome.ok && schedule) {
  console.log(`\n🕒 KØSAT — HTTP ${outcome.httpStatus}, schedule_id=${outcome.scheduleId ?? "-"}`);
  console.log(`   Leveres ${new Date(schedule).toLocaleString("da-DK")} (lokal tid). Endnu IKKE i kundens indbakke.`);
  console.log(`   Fortryd: DELETE https://api.smtp2go.com/v3/email/scheduled med schedule_id ovenfor.`);
} else {
  console.log(`\n${outcome.ok ? "✅ SENDT" : "❌ IKKE SENDT"} — HTTP ${outcome.httpStatus}, succeeded=${outcome.succeeded ?? "?"}, failed=${outcome.failed ?? "?"}`);
}
if (!outcome.ok) { console.error("SMTP2GO-svar:", outcome.raw.slice(0, 800)); process.exit(1); }
console.log(`Logget i invoices/smtp2go-delivery.log (status=${outcome.status}).`);

// (b) ONLY after SMTP2GO has taken responsibility for the mail — delivered
// (HTTP 200 + succeeded), or queued with a schedule_id — do we record the send
// in Rentemester's own email_send_log. A queued mail is logged too: SMTP2GO has
// committed to sending it, and the log entry burns the idempotency key so a
// second run can't queue the same invoice twice.
// We record it by calling Rentemester's
// `invoice send` tool in dry-run. Rentemester never transmits (SMTP2GO already
// did); it just logs the confirmed send. Requires "dryRun": true in
// config/smtp.json so Rentemester's built-in transport records instead of erroring.
const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const proc = Bun.spawnSync(
  ["bun", "run", cliPath, "invoice", "send",
    "--company", companyRoot, "--invoice-number", invoiceNumber,
    "--kind", kind, "--to", recipientEmail, "--actor", actor],
  { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
);
if (proc.exitCode === 0) {
  console.log(`✅ Rentemesters email_send_log opdateret (${schedule ? "mailen er køsat hos SMTP2GO" : "efter bekræftet levering"}).`);
} else {
  console.error(`⚠️  Rentemesters log blev IKKE opdateret — mailen ER ${schedule ? "køsat" : "sendt"}, men Rentemester nåede ikke at logge den.`);
  console.error("    " + new TextDecoder().decode(proc.stderr).trim().split("\n").slice(-2).join(" ").slice(0, 400));
  console.error("    Tjek: config/smtp.json har \"dryRun\": true, og --actor er i policy.yaml-allowlist.");
}
