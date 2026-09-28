// Date handling for business documents.
//
// The whole office runs on Japan time, so "today" has to be the JST calendar
// day regardless of where the browser or the build machine happens to be. The
// previous helpers used toISOString(), which is UTC: an order entered at 08:30
// JST was stamped with the previous day, and a request at 09:00 UTC was stamped
// with the next day in JST.
//
// A date-only value is a calendar day, not an instant, so it is carried as
// "YYYY-MM-DD" and never round-tripped through Date's implicit local parsing
// (new Date("2025-11-01") is UTC midnight, which in JST-9 renders as the 31st).

export const JST_OFFSET_MINUTES = 9 * 60;

function partsInTimeZone(date: Date, offsetMinutes: number) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function nowInJapan(): CalendarDate {
  return partsInTimeZone(new Date(), JST_OFFSET_MINUTES);
}

// ISO "YYYY-MM-DD" for the JST calendar day right now.
export function todayJST(): string {
  const { year, month, day } = nowInJapan();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addDaysJST(iso: string, days: number): string {
  const parsed = parseISODate(iso);
  if (!parsed) return iso;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function endOfMonthJST(iso: string): string {
  const parsed = parseISODate(iso);
  if (!parsed) return iso;
  const lastDay = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate();
  return `${iso.slice(0, 8)}${String(lastDay).padStart(2, "0")}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Strict on purpose. Date's parser rolls 2025-02-30 over to March 2 and accepts
// bare years, so an out-of-range Excel cell silently became a different, valid
// looking day and then sorted into the wrong period.
export function parseISODate(value: string | null | undefined): CalendarDate | null {
  if (!value) return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day, hour: 0, minute: 0, second: 0 };
}

export function isValidISODate(value: string | null | undefined): boolean {
  return parseISODate(value) !== null;
}

// A wall-clock Date for a date-only ISO value, built at noon so a display in
// any timezone still lands on the intended calendar day.
export function dateFromISO(iso: string): Date {
  const parsed = parseISODate(iso);
  if (!parsed) return new Date(NaN);
  return new Date(parsed.year, parsed.month - 1, parsed.day, 12, 0, 0);
}

export function formatLongJST(date: Date, lang: "en" | "ja"): string {
  const { year, month, day } = partsInTimeZone(date, JST_OFFSET_MINUTES);
  return lang === "ja" ? `${year}年${month}月${day}日` : date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// Numeric input handling. Number("") is 0 and Number("abc") is NaN, so a blank
// or mistyped cell used to save as a real zero, and empty numeric fields were
// indistinguishable from zero. Every numeric read goes through this.
export function parseNumberStrict(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim().replace(/,/g, "");
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseNonNegativeInt(value: string | number | null | undefined): number | null {
  const parsed = parseNumberStrict(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}
