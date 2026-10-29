// IST wall-clock helpers. IST has no DST, so a fixed +05:30 offset is exact.

const IST_OFFSET_MS = 330 * 60 * 1000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const TIME_ZONE = "Asia/Kolkata";

function shifted(instant: Date): Date {
  return new Date(instant.getTime() + IST_OFFSET_MS);
}

// 'YYYY-MM-DD' in IST.
export function istDate(instant: Date): string {
  return shifted(instant).toISOString().slice(0, 10);
}

// e.g. 'Thursday 2026-10-29 14:05 IST', so the LLM can resolve "tomorrow" or "this Friday".
export function describeIst(instant: Date): string {
  const s = shifted(instant);
  return `${WEEKDAYS[s.getUTCDay()]} ${s.toISOString().slice(0, 10)} ${s.toISOString().slice(11, 16)} IST`;
}

// IST wall-clock 'YYYY-MM-DD' + 'HH:MM' → the real instant.
export function istToInstant(date: string, time = "00:00"): Date {
  return new Date(Date.parse(`${date}T${time}:00Z`) - IST_OFFSET_MS);
}

// Adds minutes to an IST wall-clock time, returning 'YYYY-MM-DDTHH:MM'.
export function addMinutes(date: string, time: string, minutes: number): string {
  return new Date(Date.parse(`${date}T${time}:00Z`) + minutes * 60_000).toISOString().slice(0, 16);
}

export function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
