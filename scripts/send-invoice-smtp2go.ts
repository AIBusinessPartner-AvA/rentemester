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
 *   Add --html-out <file> to also write the rendered HTML body for inspection.
 *   Add --schedule "2026-09-01 08:00" (local time, or ISO 8601 with a zone) to
 *   have SMTP2GO hold the mail and deliver it later — max 3 days ahead.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

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

const DA_MONTHS = ["januar","februar","marts","april","maj","juni","juli","august","september","oktober","november","december"];
function formatDanishDate(iso?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim());
  if (!m) return (iso ?? "").trim();
  return `${Number(m[3])}. ${DA_MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
function formatDanishAmount(value: number | undefined, currency = "DKK"): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const fixed = value.toFixed(2);
  const [intPart, dec] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${grouped},${dec} ${currency}`;
}
function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zæøå]+)\s*\}\}/gi, (_m, key) => vars[key.toLowerCase()] ?? "");
}
function extractSignature(html: string): string {
  const m = /<!--\s*SIGNATUR START\s*-->([\s\S]*?)<!--\s*SIGNATUR SLUT\s*-->/i.exec(html);
  const block = m ? m[1] : html;
  // Strip HTML comments so notes / commented-out rows never ride along in the mail.
  return block.replace(/<!--[\s\S]*?-->/g, "").trim();
}

const args = parseArgs(process.argv.slice(2));
const companyRoot = str(args.company) ?? fail("--company <path> er påkrævet");
const invoiceNumber = str(args["invoice-number"]) ?? fail("--invoice-number <no> er påkrævet");
const recipientOverride = str(args.to);
const kind = (str(args.kind) ?? "invoice") as "invoice" | "reminder";
if (kind !== "invoice" && kind !== "reminder") fail("--kind skal være 'invoice' eller 'reminder'");
const live = args.live === true;
const htmlOut = str(args["html-out"]);
const actor = str(args.actor) ?? "user:anders";

// --- --schedule: udskudt afsendelse ------------------------------------------
// SMTP2GO tager imod mailen nu og leverer den på det angivne tidspunkt. Kravet
// er ISO 8601 i UTC (YYYY-MM-DDTHH:MM:SSZ), i fremtiden og maks. 3 døgn frem.
// Vi accepterer også lokal tid uden tidszone ("2026-09-01 08:00") og omregner,
// så man slipper for at hovedregne sommertid.
const SCHEDULE_MAX_DAYS = 3;
function parseSchedule(raw: string): string {
  const bare = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(raw);
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw);
  // Kun de to former ovenfor accepteres. new Date() alene duer ikke: dens
  // fallback-parser GÆTTER på vrøvl ("i morgen kl 8" bliver til 2001-07-31)
  // i stedet for at fejle, og en gættet dato på en fakturamail er værre end
  // en afvist kommando.
  if (!bare && !zoned) {
    fail(`--schedule "${raw}" kunne ikke læses. Brug "2026-09-01 08:00" (lokal tid) eller "2026-09-01T06:00:00Z" (UTC).`);
  }
  // Uden tidszone: læs som LOKAL tid (new Date(y, m, d, ...) er lokal).
  const when = bare
    ? new Date(
        Number(bare[1].slice(0, 4)), Number(bare[1].slice(5, 7)) - 1, Number(bare[1].slice(8, 10)),
        Number(bare[2].slice(0, 2)), Number(bare[2].slice(3, 5)), Number((bare[3] ?? ":00").slice(1)),
      )
    : new Date(raw);
  if (Number.isNaN(when.getTime())) fail(`--schedule "${raw}" er ikke en gyldig dato.`);
  // Date ruller stiltiende en ugyldig kalenderdato videre (31. september bliver
  // 1. oktober). Tjek at vi fik den dag der blev skrevet.
  if (bare) {
    const back = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
    if (back !== bare[1]) fail(`--schedule "${raw}" er ikke en gyldig kalenderdato (${bare[1]} findes ikke).`);
  }
  const now = Date.now();
  if (when.getTime() <= now) fail(`--schedule skal ligge i fremtiden (${when.toISOString()} er passeret).`);
  const days = (when.getTime() - now) / 86_400_000;
  if (days > SCHEDULE_MAX_DAYS) {
    fail(`--schedule må højst være ${SCHEDULE_MAX_DAYS} døgn frem — ${when.toISOString()} er ${days.toFixed(1)} døgn ude. Det er SMTP2GOs grænse, ikke vores.`);
  }
  return `${when.toISOString().slice(0, 19)}Z`;
}
const scheduleRaw = str(args.schedule);
const schedule = scheduleRaw ? parseSchedule(scheduleRaw) : undefined;

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
  buyer?: { name?: string; email?: string };
  issueDate?: string;
  currency?: string;
  totals?: { grossAmount?: number };
};

// --- config/brands.json (mail template + subject + per-brand signature) ------
type BrandsFile = {
  mail?: { subject?: string; templatePath?: string; reminderSubject?: string; reminderTemplatePath?: string };
  brands?: Record<string, { name?: string; email?: string; signaturePath?: string }>;
};
const brandsPath = join(companyRoot, "config", "brands.json");
const brandsCfg: BrandsFile = existsSync(brandsPath)
  ? (JSON.parse(readFileSync(brandsPath, "utf8")) as BrandsFile)
  : {};

// Resolve the brand from the invoice's seller.email (unique per brand).
const sellerEmail = str(snap.seller?.email);
const brandEntry = Object.values(brandsCfg.brands ?? {}).find(
  (b) => str(b.email)?.toLowerCase() === sellerEmail?.toLowerCase(),
);

const fromEmail = sellerEmail ?? str(smtp.fromAddress) ?? fail("ingen afsender-mail (seller.email/fromAddress mangler)");
const fromName = str(snap.seller?.name) ?? str(smtp.fromName) ?? fromEmail;
const sender = `${fromName} <${fromEmail}>`;

const recipientEmail = recipientOverride ?? str(snap.buyer?.email) ?? fail("ingen modtager: angiv --to <email>");
const recipientName = str(snap.buyer?.name);
const to = recipientName ? `${recipientName} <${recipientEmail}>` : recipientEmail;

// --- merge fields ------------------------------------------------------------
const vars: Record<string, string> = {
  kontaktnavn: recipientName ?? "kunde",
  brand: fromName,
  fakturanummer: invoiceNumber,
  fakturadato: formatDanishDate(snap.issueDate),
  "beløb": formatDanishAmount(snap.totals?.grossAmount, (snap.currency ?? "DKK").toUpperCase()),
  signatur: "",
};

// Brand signature (extracted, comment-stripped). Empty if not configured.
let signatureHtml = "";
const sigPath = str(brandEntry?.signaturePath);
if (sigPath && existsSync(sigPath)) signatureHtml = extractSignature(readFileSync(sigPath, "utf8"));
else if (sigPath) console.error(`ADVARSEL: signaturePath findes ikke: ${sigPath} (mail sendes uden signatur)`);
vars.signatur = signatureHtml;

// --- subject + body from template -------------------------------------------
const mailCfg = brandsCfg.mail ?? {};
const subjectTpl = kind === "reminder"
  ? (mailCfg.reminderSubject ?? "Betalingspåmindelse for faktura {{fakturanummer}} fra {{brand}}")
  : (mailCfg.subject ?? "Faktura af {{fakturadato}} fra {{brand}}");
const subject = fillTemplate(subjectTpl, vars);

const templateRel = kind === "reminder" ? mailCfg.reminderTemplatePath : mailCfg.templatePath;
const templatePath = templateRel ? (isAbsolute(templateRel) ? templateRel : join(companyRoot, templateRel)) : undefined;
let htmlBody: string;
if (templatePath && existsSync(templatePath)) {
  htmlBody = fillTemplate(readFileSync(templatePath, "utf8").replace(/<!--[\s\S]*?-->/g, ""), vars);
} else {
  // Built-in fallback (used for reminders without a template, or if the file is missing).
  const intro = kind === "reminder"
    ? `<p>Vi kan se at faktura ${vars.fakturanummer} endnu ikke er registreret som betalt. Fakturaen er vedhæftet som PDF — kontakt os gerne, hvis betalingen allerede er gennemført.</p>`
    : `<p>Tusind tak, fordi du har valgt at være kunde hos ${vars.brand}.</p><p>Her er din faktura ${vars.fakturanummer} på ${vars["beløb"]}.</p><p>Fakturaen er vedhæftet denne mail som PDF.</p>`;
  htmlBody = `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5; color: #101820;"><p>Kære ${vars.kontaktnavn}</p>${intro}${signatureHtml}</div>`;
}

// Plain-text fallback (few clients need it, but it keeps the mail well-formed).
const textBody = [
  `Kære ${vars.kontaktnavn}`,
  "",
  kind === "reminder"
    ? `Vi kan se at faktura ${vars.fakturanummer} endnu ikke er registreret som betalt. Fakturaen er vedhæftet som PDF.`
    : `Tusind tak, fordi du har valgt at være kunde hos ${vars.brand}.\n\nHer er din faktura ${vars.fakturanummer} på ${vars["beløb"]}. Fakturaen er vedhæftet som PDF.`,
  "",
  "Med venlig hilsen",
  fromName,
  fromEmail,
].join("\n");

if (htmlOut) { writeFileSync(htmlOut, htmlBody); console.log(`HTML-body skrevet til ${htmlOut}`); }

const pdfBase64 = readFileSync(pdfPath).toString("base64");
const payload = {
  api_key: apiKey,
  sender,
  to: [to],
  subject,
  html_body: htmlBody,
  text_body: textBody,
  attachments: [{ filename: `${invoiceNumber}.pdf`, fileblob: pdfBase64, mimetype: "application/pdf" }],
  ...(schedule ? { schedule } : {}),
};

// --- dry-run (default) -------------------------------------------------------
console.log(JSON.stringify({
  mode: live ? "LIVE" : "DRY-RUN",
  endpoint: "https://api.smtp2go.com/v3/email/send",
  from: sender, to, subject,
  levering: schedule ? `PLANLAGT ${schedule} (= ${new Date(schedule).toLocaleString("da-DK")} lokal tid)` : "straks",
  brand_matched: brandEntry ? (brandEntry.name ?? "(unnamed)") : "(ingen brand-match — ingen signatur)",
  merge_fields: vars,
  html_body_length: htmlBody.length,
  api_key: "***REDACTED***",
}, null, 2));

if (!live) { console.log("\nDRY-RUN: intet sendt. Kør igen med --live for at sende via SMTP2GO."); process.exit(0); }

// --- live send ---------------------------------------------------------------
const res = await fetch("https://api.smtp2go.com/v3/email/send", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify(payload),
}).catch((e) => fail(`netværksfejl mod SMTP2GO: ${(e as Error).message}`));
const bodyText = await res.text();
let parsed: unknown; try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
const data = (parsed as { data?: { succeeded?: number; failed?: number; email_id?: string; schedule_id?: string } })?.data;
// En planlagt mail er KØSAT, ikke leveret: SMTP2GO svarer med et schedule_id i
// stedet for succeeded/failed. Kvitteringen skal derfor læses forskelligt.
const ok = schedule
  ? res.ok && Boolean(data?.schedule_id)
  : res.ok && (data?.succeeded ?? 0) >= 1 && (data?.failed ?? 0) === 0;
const status = ok ? (schedule ? "SCHEDULED" : "OK") : "FAIL";
const logLine = `${new Date().toISOString()}\t${status}\t${invoiceNumber}\t${kind}\t${to}\tfrom=${fromEmail}\temail_id=${data?.email_id ?? "-"}\tschedule=${schedule ?? "-"}\tschedule_id=${data?.schedule_id ?? "-"}\thttp=${res.status}\n`;
try { appendFileSync(join(companyRoot, "invoices", "smtp2go-delivery.log"), logLine); } catch { /* non-fatal */ }
if (ok && schedule) {
  console.log(`\n🕒 KØSAT — HTTP ${res.status}, schedule_id=${data?.schedule_id ?? "-"}`);
  console.log(`   Leveres ${new Date(schedule).toLocaleString("da-DK")} (lokal tid). Endnu IKKE i kundens indbakke.`);
  console.log(`   Fortryd: DELETE https://api.smtp2go.com/v3/email/scheduled med schedule_id ovenfor.`);
} else {
  console.log(`\n${ok ? "✅ SENDT" : "❌ IKKE SENDT"} — HTTP ${res.status}, succeeded=${data?.succeeded ?? "?"}, failed=${data?.failed ?? "?"}`);
}
if (!ok) { console.error("SMTP2GO-svar:", typeof parsed === "string" ? parsed.slice(0, 800) : JSON.stringify(parsed, null, 2).slice(0, 800)); process.exit(1); }
console.log(`Logget i invoices/smtp2go-delivery.log (status=${status}).`);

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
