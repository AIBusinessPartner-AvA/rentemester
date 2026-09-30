// Tests: src/core/smtp2go.ts — afsendelseskaldet og læsningen af kvitteringen.
//
// Hvorfor denne fil findes: afsendelse er det ene skridt der ikke kan fortrydes.
// Svaret på "tog SMTP2GO reelt ansvar for mailen?" afgør om Rentemesters eget
// email_send_log registrerer afsendelsen — og den log er det, der forhindrer at
// samme faktura ryger ud to gange. Et falsk "sendt" brænder idempotens-nøglen
// på en mail kunden aldrig fik; et falsk "ikke sendt" inviterer til en dublet.
//
// Den asymmetri der bærer de fleste tests: en STRAKS-afsendelse kvitteres med
// succeeded/failed-tællere, en PLANLAGT med et schedule_id og ingen tællere.
// Læses den ene med den andens regel, meldes fejl på en mail der er fint køsat
// — eller succes på en der aldrig blev det.
import { describe, expect, test } from "bun:test";
import {
  SMTP2GO_SEND_ENDPOINT,
  buildSmtp2goPayload,
  formatDeliveryLogLine,
  interpretSmtp2goResponse,
  sendViaSmtp2go,
  type Smtp2goOutcome,
  type Smtp2goPayload,
} from "../../src/core/smtp2go";

const API_KEY = "api-hemmelig-noegle-DENNE-MAA-ALDRIG-LOGGES";

function payload(overrides: Partial<Smtp2goPayload> = {}): Smtp2goPayload {
  return {
    ...buildSmtp2goPayload({
      apiKey: API_KEY,
      sender: "Mind AI ApS <bogholder@eksempel.dk>",
      to: "Kunde ApS <kunde@eksempel.dk>",
      subject: "Faktura 2026-27-0001",
      htmlBody: "<p>Hej Tue</p>",
      textBody: "Hej Tue",
      attachmentFilename: "2026-27-0001.pdf",
      attachmentBase64: "JVBERi0xLjQK",
    }),
    ...overrides,
  };
}

/** En fake fetch der svarer med præcis den krop og status testen beder om. */
function fakeFetch(body: string, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const IMMEDIATE_OK = JSON.stringify({ data: { succeeded: 1, failed: 0, email_id: "em-123" } });
const SCHEDULED_OK = JSON.stringify({ data: { schedule_id: "sch-abc" } });

describe("buildSmtp2goPayload", () => {
  test("bygger den krop SMTP2GOs v3-endpoint forventer", () => {
    const p = payload();
    expect(p.api_key).toBe(API_KEY);
    expect(p.sender).toBe("Mind AI ApS <bogholder@eksempel.dk>");
    expect(p.to).toEqual(["Kunde ApS <kunde@eksempel.dk>"]);
    expect(p.subject).toBe("Faktura 2026-27-0001");
    expect(p.html_body).toBe("<p>Hej Tue</p>");
    expect(p.text_body).toBe("Hej Tue");
  });

  test("modtageren pakkes i et array — SMTP2GO tager en liste", () => {
    expect(Array.isArray(payload().to)).toBe(true);
  });

  test("vedhæftningen bærer base64 uændret igennem", () => {
    const p = payload();
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0]!.fileblob).toBe("JVBERi0xLjQK");
    expect(p.attachments[0]!.filename).toBe("2026-27-0001.pdf");
    expect(p.attachments[0]!.mimetype).toBe("application/pdf");
  });

  test("en straks-afsendelse har slet INGEN schedule-nøgle", () => {
    // Ikke "schedule: undefined" — nøglen må ikke være der, ellers kan SMTP2GO
    // tolke det som en planlagt afsendelse uden tidspunkt.
    expect("schedule" in payload()).toBe(false);
  });

  test("en planlagt afsendelse har schedule med", () => {
    const p = buildSmtp2goPayload({
      apiKey: API_KEY, sender: "a <a@b.dk>", to: "c <c@d.dk>", subject: "s",
      htmlBody: "h", textBody: "t", attachmentFilename: "f.pdf", attachmentBase64: "x",
      schedule: "2026-10-01T07:00:00Z",
    });
    expect(p.schedule).toBe("2026-10-01T07:00:00Z");
  });
});

describe("interpretSmtp2goResponse — straks-afsendelse", () => {
  const immediate = (bodyText: string, httpStatus = 200) =>
    interpretSmtp2goResponse({ httpStatus, httpOk: httpStatus >= 200 && httpStatus < 300, bodyText, scheduled: false });

  test("succeeded 1 og failed 0 er en leveret mail", () => {
    const outcome = immediate(IMMEDIATE_OK);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("OK");
    expect(outcome.succeeded).toBe(1);
    expect(outcome.emailId).toBe("em-123");
  });

  test("succeeded 0 er ikke leveret", () => {
    const outcome = immediate(JSON.stringify({ data: { succeeded: 0, failed: 0 } }));
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("FAIL");
  });

  test("en enkelt failed diskvalificerer, selv med en succeeded", () => {
    const outcome = immediate(JSON.stringify({ data: { succeeded: 1, failed: 1 } }));
    expect(outcome.ok).toBe(false);
  });

  test("HTTP-fejl er ikke leveret, uanset hvad kroppen påstår", () => {
    expect(immediate(IMMEDIATE_OK, 401).ok).toBe(false);
    expect(immediate(IMMEDIATE_OK, 500).ok).toBe(false);
  });

  test("svar uden data-objekt er ikke leveret", () => {
    expect(immediate(JSON.stringify({ request_id: "abc" })).ok).toBe(false);
  });

  test("krop der ikke er JSON er ikke leveret — og gemmes råt", () => {
    const outcome = immediate("<html>502 Bad Gateway</html>");
    expect(outcome.ok).toBe(false);
    expect(outcome.raw).toContain("502");
  });

  test("tom krop er ikke leveret", () => {
    expect(immediate("").ok).toBe(false);
  });

  test("et schedule_id på en straks-afsendelse tæller IKKE som succes", () => {
    // SMTP2GO gjorde i så fald noget andet end det, vi bad om. Det er en fejl,
    // ikke en succes.
    expect(immediate(SCHEDULED_OK).ok).toBe(false);
  });
});

describe("interpretSmtp2goResponse — planlagt afsendelse", () => {
  const scheduled = (bodyText: string, httpStatus = 200) =>
    interpretSmtp2goResponse({ httpStatus, httpOk: httpStatus >= 200 && httpStatus < 300, bodyText, scheduled: true });

  test("et schedule_id betyder køsat", () => {
    const outcome = scheduled(SCHEDULED_OK);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("SCHEDULED");
    expect(outcome.scheduleId).toBe("sch-abc");
  });

  test("succeeded-tællere UDEN schedule_id tæller ikke som køsat", () => {
    // Den fejl der ville melde succes på en mail, der aldrig blev lagt i kø.
    const outcome = scheduled(IMMEDIATE_OK);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("FAIL");
  });

  test("HTTP-fejl med schedule_id er stadig ikke køsat", () => {
    expect(scheduled(SCHEDULED_OK, 503).ok).toBe(false);
  });

  test("tomt data-objekt er ikke køsat", () => {
    expect(scheduled(JSON.stringify({ data: {} })).ok).toBe(false);
  });
});

describe("formatDeliveryLogLine", () => {
  const outcome: Smtp2goOutcome = {
    ok: true, status: "OK", httpStatus: 200, succeeded: 1, failed: 0,
    emailId: "em-123", raw: IMMEDIATE_OK,
  };
  const base = {
    at: new Date(Date.UTC(2026, 8, 30, 6, 0, 0)),
    invoiceNumber: "2026-27-0001",
    kind: "invoice",
    to: "Kunde ApS <kunde@eksempel.dk>",
    fromEmail: "bogholder@eksempel.dk",
  };

  test("er én tabulator-adskilt linje med ti kolonner", () => {
    const line = formatDeliveryLogLine({ ...base, outcome });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().split("\t")).toHaveLength(10);
  });

  test("fører tidsstempel, status og identifikatorer med", () => {
    const line = formatDeliveryLogLine({ ...base, outcome });
    expect(line).toContain("2026-09-30T06:00:00.000Z");
    expect(line).toContain("\tOK\t");
    expect(line).toContain("2026-27-0001");
    expect(line).toContain("email_id=em-123");
    expect(line).toContain("http=200");
  });

  test("manglende værdier skrives som '-' så kolonnerne holder", () => {
    const line = formatDeliveryLogLine({
      ...base,
      outcome: { ok: false, status: "FAIL", httpStatus: 500, raw: "" },
    });
    expect(line).toContain("email_id=-");
    expect(line).toContain("schedule=-");
    expect(line).toContain("schedule_id=-");
    expect(line.trimEnd().split("\t")).toHaveLength(10);
  });

  test("en køsat mail logges med schedule og schedule_id", () => {
    const line = formatDeliveryLogLine({
      ...base,
      schedule: "2026-10-01T07:00:00Z",
      outcome: { ok: true, status: "SCHEDULED", httpStatus: 200, scheduleId: "sch-abc", raw: SCHEDULED_OK },
    });
    expect(line).toContain("\tSCHEDULED\t");
    expect(line).toContain("schedule=2026-10-01T07:00:00Z");
    expect(line).toContain("schedule_id=sch-abc");
  });

  test("API-NØGLEN havner ALDRIG i loggen", () => {
    // Loggen er et revisionsspor, ikke en fejlsøgningsdump. Selv når nøglen
    // skulle optræde i det rå svar, må den ikke skrives til disk.
    const line = formatDeliveryLogLine({
      ...base,
      outcome: { ...outcome, raw: `{"echo":"${API_KEY}"}` },
    });
    expect(line).not.toContain(API_KEY);
    expect(line).not.toContain("api-hemmelig");
  });
});

describe("sendViaSmtp2go — mod en fake", () => {
  test("poster JSON til SMTP2GOs send-endpoint", async () => {
    const fake = fakeFetch(IMMEDIATE_OK);
    await sendViaSmtp2go(payload(), { fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe(SMTP2GO_SEND_ENDPOINT);
    expect(fake.calls[0]!.init.method).toBe("POST");
    expect((fake.calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("kroppen er den serialiserede payload — med nøglen, for den SKAL derhen", () => {
    // Nøglen hører hjemme i requesten. Den hører ikke hjemme i loggen; det er
    // to forskellige ting, og testen ovenfor vogter den anden.
    const fake = fakeFetch(IMMEDIATE_OK);
    return sendViaSmtp2go(payload(), { fetchImpl: fake.impl }).then(() => {
      const sent = JSON.parse(String(fake.calls[0]!.init.body)) as Smtp2goPayload;
      expect(sent.api_key).toBe(API_KEY);
      expect(sent.subject).toBe("Faktura 2026-27-0001");
      expect(sent.attachments[0]!.fileblob).toBe("JVBERi0xLjQK");
    });
  });

  test("straks-afsendelse der lykkes", async () => {
    const fake = fakeFetch(IMMEDIATE_OK);
    const outcome = await sendViaSmtp2go(payload(), { fetchImpl: fake.impl });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("OK");
    expect(outcome.emailId).toBe("em-123");
    expect(outcome.httpStatus).toBe(200);
  });

  test("planlagt afsendelse bedømmes efter schedule-reglen", async () => {
    // Regelvalget udledes af payloadens schedule-felt, ikke af et ekstra flag
    // kalderen kunne glemme at sætte.
    const fake = fakeFetch(SCHEDULED_OK);
    const outcome = await sendViaSmtp2go(payload({ schedule: "2026-10-01T07:00:00Z" }), { fetchImpl: fake.impl });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("SCHEDULED");
    expect(outcome.scheduleId).toBe("sch-abc");
  });

  test("planlagt afsendelse uden schedule_id fejler", async () => {
    const fake = fakeFetch(IMMEDIATE_OK);
    const outcome = await sendViaSmtp2go(payload({ schedule: "2026-10-01T07:00:00Z" }), { fetchImpl: fake.impl });
    expect(outcome.ok).toBe(false);
  });

  test("HTTP 500 giver FAIL med statuskoden i behold", async () => {
    const fake = fakeFetch('{"error":"boom"}', 500);
    const outcome = await sendViaSmtp2go(payload(), { fetchImpl: fake.impl });
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(500);
    expect(outcome.raw).toContain("boom");
  });

  test("netværksfejl bliver til et resultat, ikke en exception", async () => {
    const throwing = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
    const outcome = await sendViaSmtp2go(payload(), { fetchImpl: throwing });
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(0);
    expect(outcome.networkError).toContain("ENOTFOUND");
  });

  test("et svar hvis krop ikke kan læses, tælles som IKKE sendt", async () => {
    // Vi ved intet om leveringen, og så må antagelsen aldrig være "den gik nok".
    const broken = (async () => ({
      status: 200,
      ok: true,
      text: async () => { throw new Error("stream afbrudt"); },
    })) as unknown as typeof fetch;
    const outcome = await sendViaSmtp2go(payload(), { fetchImpl: broken });
    expect(outcome.ok).toBe(false);
    expect(outcome.networkError).toContain("stream afbrudt");
  });

  test("et alternativt endpoint kan sættes (til test mod en lokal fake)", async () => {
    const fake = fakeFetch(IMMEDIATE_OK);
    await sendViaSmtp2go(payload(), { fetchImpl: fake.impl, endpoint: "http://127.0.0.1:9999/send" });
    expect(fake.calls[0]!.url).toBe("http://127.0.0.1:9999/send");
  });

  test("kalder præcis én gang — ingen skjult genforsøg", async () => {
    // Et genforsøg på en send-operation uden idempotensnøgle ville kunne sende
    // den samme faktura to gange.
    const fake = fakeFetch('{"error":"boom"}', 500);
    await sendViaSmtp2go(payload(), { fetchImpl: fake.impl });
    expect(fake.calls).toHaveLength(1);
  });
});
