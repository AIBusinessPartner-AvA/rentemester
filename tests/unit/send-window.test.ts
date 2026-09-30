// Tests: src/core/send-window.ts — afsendelsesvindue og --schedule-parsing.
//
// Alle datoer bygges med den LOKALE Date-konstruktør (new Date(y, m, d, h, m)),
// og alle forventninger er formuleret i lokal tid. Testene er derfor
// uafhængige af maskinens tidszone — præcis som reglerne selv, der handler om
// den klokke mennesket kigger på.
//
// Kalenderen der bruges herunder:
//   ma 2026-09-28, ti 29, on 30, to 2026-10-01, fr 02, lø 03, sø 04
import { describe, expect, test } from "bun:test";
import {
  SCHEDULE_MAX_DAYS,
  WINDOW_LABEL,
  WORK_END_HOUR,
  WORK_START_HOUR,
  formatLocal,
  insideSendWindow,
  nextSendSlot,
  parseSchedule,
} from "../../src/core/send-window";

const MONDAY = [2026, 8, 28] as const;
const WEDNESDAY = [2026, 8, 30] as const;
const FRIDAY = [2026, 9, 2] as const;
const SATURDAY = [2026, 9, 3] as const;
const SUNDAY = [2026, 9, 4] as const;

/** Lokal tid, så testen betyder det samme uanset maskinens tidszone. */
function at([y, m, d]: readonly [number, number, number], hour: number, minute = 0): Date {
  return new Date(y, m, d, hour, minute, 0, 0);
}

describe("kalender-antagelser", () => {
  // Hvis disse fejler, er resten af filen meningsløs — så fejl højlydt her.
  test("de valgte datoer er de ugedage testene antager", () => {
    expect(at(MONDAY, 12).getDay()).toBe(1);
    expect(at(WEDNESDAY, 12).getDay()).toBe(3);
    expect(at(FRIDAY, 12).getDay()).toBe(5);
    expect(at(SATURDAY, 12).getDay()).toBe(6);
    expect(at(SUNDAY, 12).getDay()).toBe(0);
  });
});

describe("insideSendWindow", () => {
  test("midt på en hverdag er inden for", () => {
    expect(insideSendWindow(at(WEDNESDAY, 9))).toBe(true);
    expect(insideSendWindow(at(WEDNESDAY, 12, 30))).toBe(true);
  });

  test("begge endepunkter er inklusive", () => {
    expect(insideSendWindow(at(WEDNESDAY, WORK_START_HOUR, 0))).toBe(true);
    expect(insideSendWindow(at(WEDNESDAY, WORK_END_HOUR, 0))).toBe(true);
  });

  test("ét minut uden for hver ende er udenfor", () => {
    expect(insideSendWindow(at(WEDNESDAY, WORK_START_HOUR - 1, 59))).toBe(false);
    expect(insideSendWindow(at(WEDNESDAY, WORK_END_HOUR, 1))).toBe(false);
  });

  test("weekend er altid udenfor, også midt i arbejdstiden", () => {
    expect(insideSendWindow(at(SATURDAY, 10))).toBe(false);
    expect(insideSendWindow(at(SUNDAY, 10))).toBe(false);
  });

  test("midnat på en hverdag er udenfor", () => {
    expect(insideSendWindow(at(WEDNESDAY, 0))).toBe(false);
    expect(insideSendWindow(at(WEDNESDAY, 23, 59))).toBe(false);
  });
});

describe("nextSendSlot", () => {
  test("et tidspunkt der allerede er inde, flyttes ikke", () => {
    const inside = at(WEDNESDAY, 9, 17);
    expect(nextSendSlot(inside).getTime()).toBe(inside.getTime());
  });

  test("for tidligt på en hverdag venter til vinduet åbner samme dag", () => {
    const slot = nextSendSlot(at(WEDNESDAY, 6, 30));
    expect(slot.getDate()).toBe(30);
    expect(slot.getHours()).toBe(WORK_START_HOUR);
    expect(slot.getMinutes()).toBe(0);
  });

  test("efter lukketid på en hverdag ryger til næste morgen", () => {
    const slot = nextSendSlot(at(WEDNESDAY, 16));
    expect(slot.getDay()).toBe(4); // torsdag
    expect(slot.getHours()).toBe(WORK_START_HOUR);
  });

  test("fredag aften springer weekenden over og lander mandag", () => {
    const slot = nextSendSlot(at(FRIDAY, 18));
    expect(slot.getDay()).toBe(1);
    expect(slot.getHours()).toBe(WORK_START_HOUR);
  });

  test("lørdag og søndag lander begge mandag morgen", () => {
    for (const day of [SATURDAY, SUNDAY]) {
      const slot = nextSendSlot(at(day, 10));
      expect(slot.getDay()).toBe(1);
      expect(slot.getHours()).toBe(WORK_START_HOUR);
    }
  });

  test("resultatet er ALTID inden for vinduet — uanset udgangspunkt", () => {
    // Hele ugen, hver anden time. Dette er den egenskab der betyder noget:
    // --schedule next må aldrig foreslå et tidspunkt der selv ville blive afvist.
    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      for (let hour = 0; hour < 24; hour += 2) {
        const from = new Date(2026, 8, 28 + dayOffset, hour, 0, 0, 0);
        expect(insideSendWindow(nextSendSlot(from))).toBe(true);
      }
    }
  });

  test("ændrer ikke datoen den får ind (ingen mutation)", () => {
    const from = at(SATURDAY, 10);
    const before = from.getTime();
    nextSendSlot(from);
    expect(from.getTime()).toBe(before);
  });
});

describe("parseSchedule", () => {
  const now = at(MONDAY, 9); // mandag kl. 9, midt i vinduet

  test("bar lokal tid læses som lokal tid", () => {
    const result = parseSchedule("2026-09-29 08:00", now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.when.getFullYear()).toBe(2026);
    expect(result.when.getMonth()).toBe(8);
    expect(result.when.getDate()).toBe(29);
    expect(result.when.getHours()).toBe(8);
    expect(result.when.getMinutes()).toBe(0);
  });

  test("T som separator og sekunder accepteres også", () => {
    const withT = parseSchedule("2026-09-29T08:30:15", now);
    expect(withT.ok).toBe(true);
    if (!withT.ok) return;
    expect(withT.when.getHours()).toBe(8);
    expect(withT.when.getSeconds()).toBe(15);
  });

  test("zonet ISO 8601 peger på det absolutte tidspunkt", () => {
    const result = parseSchedule("2026-09-29T06:00:00Z", now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sammenlignes som instant, ikke som lokal time — ellers ville testen
    // afhænge af maskinens tidszone.
    expect(result.when.toISOString()).toBe("2026-09-29T06:00:00.000Z");
  });

  test("vrøvl afvises i stedet for at blive gættet", () => {
    // new Date("i morgen kl 8") giver 2001-07-31 på nogle runtimes. En gættet
    // dato på en fakturamail er værre end en afvist kommando.
    const result = parseSchedule("i morgen kl 8", now);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("kunne ikke læses");
  });

  test("andre datoformater afvises", () => {
    for (const raw of ["29-09-2026 08:00", "2026/09/29 08:00", "08:00", "2026-09-29", ""]) {
      expect(parseSchedule(raw, now).ok).toBe(false);
    }
  });

  test("en dato der ikke findes i kalenderen afvises", () => {
    // Date ruller stiltiende 31. september videre til 1. oktober.
    const result = parseSchedule("2026-09-31 08:00", now);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("findes ikke");
  });

  test("29. februar i et ikke-skudår afvises", () => {
    expect(parseSchedule("2026-02-29 08:00", now).ok).toBe(false);
  });

  test("fortiden afvises", () => {
    const result = parseSchedule("2026-09-28 08:00", now); // en time før now
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("fremtiden");
  });

  test("præcis nu afvises — grænsen er skarp", () => {
    expect(parseSchedule("2026-09-28 09:00", now).ok).toBe(false);
  });

  test("længere end SMTP2GOs grænse afvises", () => {
    const tooFar = new Date(now.getTime() + (SCHEDULE_MAX_DAYS + 1) * 86_400_000);
    const raw = `${formatLocal(tooFar).replace(" ", "T")}`;
    const result = parseSchedule(raw, now);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(`${SCHEDULE_MAX_DAYS} døgn`);
  });

  test("lige inden for grænsen accepteres", () => {
    const justInside = new Date(now.getTime() + SCHEDULE_MAX_DAYS * 86_400_000 - 60_000);
    const raw = `${formatLocal(justInside).replace(" ", "T")}`;
    expect(parseSchedule(raw, now).ok).toBe(true);
  });

  test("kaster aldrig — også på ondsindet input", () => {
    for (const raw of ["../../etc/passwd", "9999-99-99 99:99", "\u0000", "2026-09-29 08:00extra"]) {
      expect(() => parseSchedule(raw, now)).not.toThrow();
      expect(parseSchedule(raw, now).ok).toBe(false);
    }
  });
});

describe("formatLocal", () => {
  test("nulpolstrer måned, dag, time og minut", () => {
    expect(formatLocal(new Date(2026, 0, 5, 7, 4))).toBe("2026-01-05 07:04");
  });

  test("formatet er det, fejlbeskeden beder brugeren skrive tilbage", () => {
    // Beskeden foreslår --schedule "<formatLocal(...)>", så outputtet skal
    // kunne læses af parseSchedule igen.
    const slot = nextSendSlot(new Date(2026, 9, 3, 10)); // lørdag
    const roundTrip = parseSchedule(formatLocal(slot), new Date(2026, 9, 3, 10));
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) return;
    expect(roundTrip.when.getTime()).toBe(slot.getTime());
  });
});

describe("WINDOW_LABEL", () => {
  test("nævner de faktiske timer, så beskeden ikke kan komme ud af trit", () => {
    expect(WINDOW_LABEL).toContain(String(WORK_START_HOUR));
    expect(WINDOW_LABEL).toContain(String(WORK_END_HOUR));
  });
});
