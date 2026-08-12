/**
 * Brand profiles (#DLK-branding): one legal company can invoice under several
 * brand identities (e.g. "Den langhårede konsulent ApS" and its binavn
 * "Mind AI ApS"). A brand only changes PRESENTATION — the seller name shown on
 * the invoice, the contact line in the footer, and the sender address of the
 * delivery email. It NEVER changes the CVR, the ledger, or the invoice number
 * series: every brand issues from the same company, so the fortløbende
 * fakturanummerering stays a single shared sequence (a legal requirement).
 *
 * Brands are DATA, not code: they live in `config/brands.json` inside the
 * company directory so the owner edits names/mails/logos without touching the
 * codebase — mirroring the `smtp.json` / `digisense.json` config seam.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { companyPaths } from "./paths";

/** A single resolved brand identity. `key` is the lookup slug (e.g. "dlk"). */
export type BrandProfile = {
  key: string;
  name: string;
  address?: string;
  vatOrCvr?: string;
  email?: string;
  phone?: string;
  web?: string;
  /** Short text word-mark rendered in the invoice header. Defaults to `name`. */
  logoText?: string;
};

type BrandEntry = Omit<BrandProfile, "key">;

type BrandsConfigFile = {
  /** Brand used when `--brand` is omitted. */
  default?: string;
  /** Late-payment (morarente) note printed on every invoice. Optional. */
  latePaymentNote?: string;
  brands?: Record<string, BrandEntry>;
};

export type ResolvedBrand = {
  brand: BrandProfile;
  latePaymentNote?: string;
};

function configPath(companyRoot: string): string {
  return join(companyPaths(companyRoot).config, "brands.json");
}

/** True when the company has a brands.json at all (so callers can stay silent otherwise). */
export function hasBrandsConfig(companyRoot: string): boolean {
  return existsSync(configPath(companyRoot));
}

/**
 * Resolve a brand by key (or the configured default). Returns a clear error
 * when brands.json is missing or the key is unknown — never throws, so the CLI
 * can surface a friendly message and exit.
 */
export function loadBrand(
  companyRoot: string,
  key?: string,
): { ok: true; resolved: ResolvedBrand } | { ok: false; error: string } {
  const path = configPath(companyRoot);
  if (!existsSync(path)) {
    return {
      ok: false,
      error: `manglende brand-opsætning: opret config/brands.json (default, latePaymentNote, brands{}) her: ${path}`,
    };
  }
  let parsed: BrandsConfigFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as BrandsConfigFile;
  } catch (error) {
    return { ok: false, error: `kunne ikke læse config/brands.json: ${(error as Error).message}` };
  }
  const brands = parsed.brands ?? {};
  const wanted = (key ?? parsed.default ?? "").trim();
  if (!wanted) {
    return { ok: false, error: "ingen brand angivet og intet 'default' i brands.json — brug --brand <key>" };
  }
  const entry = brands[wanted];
  if (!entry) {
    const known = Object.keys(brands).join(", ") || "(ingen)";
    return { ok: false, error: `ukendt brand '${wanted}'. Kendte brands: ${known}` };
  }
  if (!entry.name || !entry.name.trim()) {
    return { ok: false, error: `brand '${wanted}' mangler 'name' i brands.json` };
  }
  return {
    ok: true,
    resolved: {
      brand: { key: wanted, ...entry },
      latePaymentNote: parsed.latePaymentNote,
    },
  };
}
