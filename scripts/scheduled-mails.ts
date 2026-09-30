#!/usr/bin/env bun
/**
 * Se og annullér mails der ligger i kø hos SMTP2GO (#DLK-branding).
 *
 * Modstykket til `send-invoice-smtp2go.ts --schedule`: når en faktura er køsat,
 * ligger den hos SMTP2GO indtil leveringstidspunktet. Dette script er den eneste
 * pæne måde at se køen og trække noget tilbage igen.
 *
 * Bruger de to endpoints /email/scheduled/search og /email/scheduled/remove.
 * De autentificerer med X-Smtp2go-Api-Key-headeren (send-endpointet tager
 * nøglen i body'en — det er SMTP2GOs inkonsekvens, ikke vores).
 *
 * SIKKERHED: `cancel` er dry-run som standard. Den slår først op hvad der
 * annulleres, viser det, og kræver --yes for at gøre alvor af det.
 *
 * Usage:
 *   bun run scripts/scheduled-mails.ts list --company <path>
 *   bun run scripts/scheduled-mails.ts list --company <path> --recipient kunde@example.dk
 *   bun run scripts/scheduled-mails.ts cancel --company <path> --schedule-id <id> [--yes]
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const mode = process.argv[2];
if (mode !== "list" && mode !== "cancel") {
  fail("første argument skal være 'list' eller 'cancel'. Se toppen af filen for brug.");
}
const args = parseArgs(process.argv.slice(3));
const companyRoot = str(args.company) ?? fail("--company <path> er påkrævet");

const smtpPath = join(companyRoot, "config", "smtp.json");
if (!existsSync(smtpPath)) fail(`mangler ${smtpPath}`);
const smtp = JSON.parse(readFileSync(smtpPath, "utf8")) as { apiKey?: string };
const apiKey = str(smtp.apiKey) ?? fail("config/smtp.json mangler 'apiKey'");

const BASE = "https://api.smtp2go.com/v3";
async function call(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Smtp2go-Api-Key": apiKey },
    body: JSON.stringify(body),
  }).catch((e) => fail(`netværksfejl mod SMTP2GO: ${(e as Error).message}`));
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    const err = (parsed as { data?: { error?: string } })?.data?.error;
    fail(`SMTP2GO svarede HTTP ${res.status}${err ? `: ${err}` : ` — ${text.slice(0, 300)}`}`);
  }
  return parsed as { request_id?: string; data?: unknown };
}

type Scheduled = {
  schedule_id?: string;
  schedule?: string;
  sender?: string;
  subject?: string;
  recipients?: string;
};

// SMTP2GO returnerer afsender/modtager som de står i mail-headeren, dvs. med
// RFC 2047-kodede navne ("=?utf-8?q?Gr=C3=B8nne_Leverum?="). Ulæseligt i en
// liste et menneske skal skimme, så vi folder dem ud igen.
function decodeMimeWords(value?: string): string {
  if (!value) return "-";
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, _charset, encoding, text: string) => {
    try {
      if (encoding.toLowerCase() === "b") return Buffer.from(text, "base64").toString("utf8");
      // Q-encoding: '_' er mellemrum, '=XX' er en hex-byte.
      const bytes = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(bytes, "binary").toString("utf8");
    } catch {
      return whole;
    }
  });
}

function localTime(iso?: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  const days = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
  return `${days[d.getDay()]} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function search(filter: Record<string, unknown>): Promise<Scheduled[]> {
  const res = await call("/email/scheduled/search", filter);
  // Endpointet svarer med en array i `data`. Et tomt svar er ikke en fejl —
  // det betyder bare at køen er tom.
  return Array.isArray(res.data) ? (res.data as Scheduled[]) : [];
}

if (mode === "list") {
  const filter: Record<string, unknown> = { limit: Number(str(args.limit) ?? 100) };
  const recipient = str(args.recipient);
  const sender = str(args.sender);
  const subject = str(args.subject);
  if (recipient) filter.search_recipient = recipient;
  if (sender) filter.search_sender = sender;
  if (subject) filter.search_subject = subject;

  const rows = await search(filter);
  if (rows.length === 0) {
    console.log("Ingen planlagte mails i køen.");
    process.exit(0);
  }
  console.log(`${rows.length} planlagt${rows.length === 1 ? "" : "e"} mail${rows.length === 1 ? "" : "s"} i kø:\n`);
  for (const r of rows) {
    console.log(`  ${localTime(r.schedule)}   ${decodeMimeWords(r.recipients)}`);
    console.log(`    ${r.subject ? decodeMimeWords(r.subject) : "(intet emne)"}`);
    console.log(`    fra ${decodeMimeWords(r.sender)}   schedule_id=${r.schedule_id ?? "-"}\n`);
  }
  console.log(`Annullér én: bun run scripts/scheduled-mails.ts cancel --company "${companyRoot}" --schedule-id <id> --yes`);
  process.exit(0);
}

// --- cancel ------------------------------------------------------------------
const scheduleId = str(args["schedule-id"]) ?? fail("--schedule-id <id> er påkrævet (find den med 'list')");
const yes = args.yes === true;

// Slå op FØR vi sletter, så man ser hvad man annullerer — og så en forkert id
// fanges her i stedet for at slette en anden mail.
const found = await search({ schedule_id: scheduleId });
if (found.length === 0) {
  fail(`ingen planlagt mail med schedule_id=${scheduleId}. Den kan allerede være afsendt eller annulleret — tjek med 'list'.`);
}
const target = found[0];
console.log("Fundet i køen:");
console.log(`  Leveres:  ${localTime(target.schedule)}`);
console.log(`  Til:      ${decodeMimeWords(target.recipients)}`);
console.log(`  Emne:     ${target.subject ? decodeMimeWords(target.subject) : "(intet emne)"}`);
console.log(`  Fra:      ${decodeMimeWords(target.sender)}\n`);

if (!yes) {
  console.log("DRY-RUN: intet annulleret. Kør igen med --yes for at fjerne den fra køen.");
  process.exit(0);
}

await call("/email/scheduled/remove", { schedule_id: scheduleId });
console.log(`🗑️  ANNULLERET — ${scheduleId} er fjernet fra køen og bliver ikke sendt.`);
console.log("");
console.log("⚠️  Rentemesters email_send_log ved det IKKE. Loggen markerede mailen som");
console.log("    sendt da den blev køsat, og den er append-only — den kan ikke rulles tilbage.");
console.log("    Fakturaen står derfor som afsendt uden at være leveret. Skal den ud alligevel,");
console.log("    afvises et nyt 'invoice send' som en dublet; send den manuelt, eller notér");
console.log("    afvigelsen så regnskabet kan forklares.");
