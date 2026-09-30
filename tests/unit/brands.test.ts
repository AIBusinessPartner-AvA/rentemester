// Tests: src/core/brands.ts — brand-identiteter fra config/brands.json.
//
// Brands er præsentation, ikke bogføring: de skifter sælgernavn, kontaktlinje
// og logo på fakturaen, men aldrig CVR, ledger eller nummerserie. Det disse
// tests passer på, er at indlæsningen ALDRIG kaster — CLI'en skal kunne give
// en venlig besked i stedet for et stack trace, uanset hvad der står i filen.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasBrandsConfig, loadBrand } from "../../src/core/brands";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Windows holder af og til fat i en netop skrevet fil. Oprydning der
    // fejler må ikke vælte en ellers grøn test.
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignoreret med vilje */
    }
  }
});

/** Et tomt virksomheds-rod uden brands.json. */
function emptyCompany(): string {
  const root = mkdtempSync(join(tmpdir(), "rentemester-brands-"));
  roots.push(root);
  return root;
}

/** Et virksomheds-rod med præcis det indhold i config/brands.json. */
function companyWithRawConfig(raw: string): string {
  const root = emptyCompany();
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "brands.json"), raw, "utf8");
  return root;
}

function companyWithConfig(config: unknown): string {
  return companyWithRawConfig(JSON.stringify(config, null, 2));
}

const TWO_BRANDS = {
  default: "dlk",
  latePaymentNote: "Ved betaling efter forfald tilskrives der renter.",
  brands: {
    dlk: {
      name: "Den langhårede konsulent ApS",
      address: "Bøgevej 7, 4330 Hvalsø",
      email: "kontakt@eksempel.dk",
      phone: "12345678",
      web: "www.eksempel.dk",
    },
    mindai: {
      name: "Mind AI ApS",
      email: "bogholder@andeteksempel.dk",
      logoText: "Mind AI",
    },
  },
};

describe("hasBrandsConfig", () => {
  test("falsk uden filen, sand med den", () => {
    expect(hasBrandsConfig(emptyCompany())).toBe(false);
    expect(hasBrandsConfig(companyWithConfig(TWO_BRANDS))).toBe(true);
  });
});

describe("loadBrand — den glade sti", () => {
  test("slår et brand op på nøgle", () => {
    const result = loadBrand(companyWithConfig(TWO_BRANDS), "mindai");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.brand.name).toBe("Mind AI ApS");
    expect(result.resolved.brand.email).toBe("bogholder@andeteksempel.dk");
    expect(result.resolved.brand.logoText).toBe("Mind AI");
  });

  test("nøglen følger med ud på det løste brand", () => {
    const result = loadBrand(companyWithConfig(TWO_BRANDS), "dlk");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.brand.key).toBe("dlk");
  });

  test("uden nøgle bruges 'default'", () => {
    const result = loadBrand(companyWithConfig(TWO_BRANDS));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.brand.key).toBe("dlk");
    expect(result.resolved.brand.name).toBe("Den langhårede konsulent ApS");
  });

  test("morarente-noten er fælles og følger med uanset brand", () => {
    const root = companyWithConfig(TWO_BRANDS);
    for (const key of ["dlk", "mindai"]) {
      const result = loadBrand(root, key);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolved.latePaymentNote).toBe(TWO_BRANDS.latePaymentNote);
    }
  });

  test("mellemrum omkring nøglen ignoreres", () => {
    const result = loadBrand(companyWithConfig(TWO_BRANDS), "  mindai  ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.brand.key).toBe("mindai");
  });

  test("en eksplicit nøgle vinder over 'default'", () => {
    const result = loadBrand(companyWithConfig(TWO_BRANDS), "mindai");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.brand.key).toBe("mindai");
  });

  test("valgfri felter er simpelthen udeladt, ikke tomme strenge", () => {
    const result = loadBrand(companyWithConfig(TWO_BRANDS), "mindai");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.brand.address).toBeUndefined();
    expect(result.resolved.brand.phone).toBeUndefined();
  });
});

describe("loadBrand — fejl der skal blive til venlige beskeder", () => {
  test("manglende brands.json peger på hvor filen skal ligge", () => {
    const root = emptyCompany();
    const result = loadBrand(root, "dlk");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("config/brands.json");
    expect(result.error).toContain(root);
  });

  test("ugyldig JSON giver en læsefejl i stedet for et stack trace", () => {
    const result = loadBrand(companyWithRawConfig("{ dette er ikke json"), "dlk");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("kunne ikke læse");
  });

  test("ukendt nøgle lister de kendte brands", () => {
    const result = loadBrand(companyWithConfig(TWO_BRANDS), "findes-ikke");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("findes-ikke");
    expect(result.error).toContain("dlk");
    expect(result.error).toContain("mindai");
  });

  test("hverken nøgle eller default beder om --brand", () => {
    const result = loadBrand(companyWithConfig({ brands: { dlk: { name: "DLK ApS" } } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--brand");
  });

  test("et brand uden navn afvises — navnet ender på fakturaen", () => {
    const result = loadBrand(companyWithConfig({ brands: { tom: { email: "a@b.dk" } } }), "tom");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("mangler 'name'");
  });

  test("et navn der kun er mellemrum tæller som manglende", () => {
    const result = loadBrand(companyWithConfig({ brands: { tom: { name: "   " } } }), "tom");
    expect(result.ok).toBe(false);
  });

  test("tomt brands-objekt siger '(ingen)' i stedet for en tom liste", () => {
    const result = loadBrand(companyWithConfig({ brands: {} }), "dlk");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("(ingen)");
  });

  test("helt tom konfigurationsfil kaster ikke", () => {
    const root = companyWithConfig({});
    expect(() => loadBrand(root, "dlk")).not.toThrow();
    expect(loadBrand(root, "dlk").ok).toBe(false);
    expect(loadBrand(root).ok).toBe(false);
  });

  test("default der peger på et brand der ikke findes, afvises pænt", () => {
    const result = loadBrand(companyWithConfig({ default: "væk", brands: { dlk: { name: "DLK ApS" } } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("væk");
  });
});
