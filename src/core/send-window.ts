/**
 * Delivery timing for outgoing invoice mail (#DLK-branding).
 *
 * Two separate concerns, both pure:
 *
 * 1. THE SEND WINDOW — a house rule: an invoice should land in the customer's
 *    inbox during ordinary working hours, not Sunday morning and not at 23:00.
 *    Only weekday and clock time are checked; this module knows nothing about
 *    public holidays, so Christmas Day passes as an ordinary weekday.
 *
 * 2. SCHEDULE PARSING — SMTP2GO accepts a delivery time up to a few days out.
 *    We accept either local wall-clock time ("2026-09-01 08:00") or a zoned
 *    ISO 8601 instant, and nothing else.
 *
 * Extracted from `scripts/send-invoice-smtp2go.ts` so the rules can be tested
 * without running the script. Every function takes its inputs explicitly —
 * `parseSchedule` receives `now` rather than reading the clock — per the
 * determinism rule in docs/build-loop.md.
 *
 * All wall-clock reasoning is in the HOST's local timezone, because that is the
 * timezone the person typing `--schedule "08:00"` is thinking in.
 */

/** Window opens at 08:00 local time. */
export const WORK_START_HOUR = 8;
/** Window closes at 15:00 local time, inclusive of 15:00 sharp. */
export const WORK_END_HOUR = 15;
/** Human-readable window, reused in CLI error messages. */
export const WINDOW_LABEL = `hverdage kl. ${WORK_START_HOUR}-${WORK_END_HOUR}`;
/** SMTP2GO refuses a delivery time further out than this. */
export const SCHEDULE_MAX_DAYS = 3;

/** True when `d` falls on a weekday between 08:00 and 15:00 inclusive, local time. */
export function insideSendWindow(d: Date): boolean {
  const day = d.getDay(); // 0 = søndag, 6 = lørdag
  if (day === 0 || day === 6) return false;
  const minutes = d.getHours() * 60 + d.getMinutes();
  return minutes >= WORK_START_HOUR * 60 && minutes <= WORK_END_HOUR * 60;
}

/**
 * The first moment at or after `from` that is inside the window. Returns `from`
 * unchanged when it is already inside, so "next" is idempotent for a time that
 * needs no moving.
 */
export function nextSendSlot(from: Date): Date {
  const d = new Date(from);
  if (insideSendWindow(d)) return d;
  const isWeekday = d.getDay() >= 1 && d.getDay() <= 5;
  // Tidligt nok på en hverdag: vent til vinduet åbner samme dag.
  if (isWeekday && d.getHours() * 60 + d.getMinutes() < WORK_START_HOUR * 60) {
    d.setHours(WORK_START_HOUR, 0, 0, 0);
    return d;
  }
  d.setDate(d.getDate() + 1);
  d.setHours(WORK_START_HOUR, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

/** `YYYY-MM-DD HH:MM` in local time — the format the window messages quote back. */
export function formatLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type ParseScheduleResult =
  | { ok: true; when: Date }
  | { ok: false; error: string };

/**
 * Parse a `--schedule` value against an explicit `now`.
 *
 * Only two shapes are accepted: bare local wall-clock time, or a zoned ISO 8601
 * instant. `new Date(raw)` alone will not do — its fallback parser GUESSES at
 * nonsense ("i morgen kl 8" becomes 2001-07-31) instead of failing, and a
 * guessed date on an invoice mail is worse than a rejected command.
 */
export function parseSchedule(raw: string, now: Date): ParseScheduleResult {
  const bare = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(raw);
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw);
  if (!bare && !zoned) {
    return {
      ok: false,
      error: `--schedule "${raw}" kunne ikke læses. Brug "2026-09-01 08:00" (lokal tid) eller "2026-09-01T06:00:00Z" (UTC).`,
    };
  }
  // Uden tidszone: læs som LOKAL tid (new Date(y, m, d, ...) er lokal).
  const when = bare
    ? new Date(
        Number(bare[1].slice(0, 4)), Number(bare[1].slice(5, 7)) - 1, Number(bare[1].slice(8, 10)),
        Number(bare[2].slice(0, 2)), Number(bare[2].slice(3, 5)), Number((bare[3] ?? ":00").slice(1)),
      )
    : new Date(raw);
  if (Number.isNaN(when.getTime())) return { ok: false, error: `--schedule "${raw}" er ikke en gyldig dato.` };
  // Date ruller stiltiende en ugyldig kalenderdato videre (31. september bliver
  // 1. oktober). Tjek at vi fik den dag der blev skrevet.
  if (bare) {
    const back = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
    if (back !== bare[1]) {
      return { ok: false, error: `--schedule "${raw}" er ikke en gyldig kalenderdato (${bare[1]} findes ikke).` };
    }
  }
  if (when.getTime() <= now.getTime()) {
    return { ok: false, error: `--schedule skal ligge i fremtiden (${when.toISOString()} er passeret).` };
  }
  const days = (when.getTime() - now.getTime()) / 86_400_000;
  if (days > SCHEDULE_MAX_DAYS) {
    return {
      ok: false,
      error: `--schedule må højst være ${SCHEDULE_MAX_DAYS} døgn frem — ${when.toISOString()} er ${days.toFixed(1)} døgn ude. Det er SMTP2GOs grænse, ikke vores.`,
    };
  }
  return { ok: true, when };
}
