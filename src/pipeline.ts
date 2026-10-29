// One polling run: read new notices, extract events, sync them to the calendar.

import type { Alert } from "./alert";
import type { Calendar, CalendarEvent } from "./calendar";
import type { ReportError } from "./errors";
import type { ExtractedEvent, Extractor, Kind } from "./extract";
import { IN_SCOPE_SUBJECTS, IN_SCOPE_TYPES, toNotice, type Notice, type NtfyMessage } from "./naarad";
import { companyKey, type Store } from "./store";
import { addMinutes, istDate, istToInstant, nextDay, TIME_ZONE } from "./time";

export interface Deps {
  store: Store;
  poll: (since: string) => Promise<NtfyMessage[]>;
  extract: Extractor;
  calendar: Calendar;
  alert: Alert;
  // Sends errors to your alert topic (throttled); see errors.ts.
  reportError: ReportError;
  now: () => Date;
  maxNotices: number;
  log: (msg: string) => void;
}

export interface RunSummary {
  seen: number;
  skipped: number;
  handled: number;
  failed: number;
  created: number;
  updated: number;
  cancelled: number;
  // True when notices were left for the next run (budget reached, or a notice will be retried).
  more: boolean;
}

// On the very first run, backfill everything Naarad still has cached (it keeps 3 days).
// Naarad's ntfy rejects day durations like "3d", so ask for everything.
export const INITIAL_SINCE = "all";
export const MAX_ATTEMPTS = 3;
const DEFAULT_DURATION_MIN = 60;

const LABELS: Record<Kind, string> = {
  test: "Test",
  interview: "Interview",
  gd: "Group Discussion",
  ppt: "PPT",
  other: "Event",
};

// Google Calendar event colours: Tomato, Tangerine, Banana, Blueberry, Graphite.
const COLORS: Record<Kind, string> = { test: "11", interview: "6", gd: "5", ppt: "9", other: "8" };

type Built =
  | { ok: true; event: CalendarEvent; title: string; startsAt: string; placeholder: boolean }
  | { ok: false; reason: "no-date" | "past" };

export function buildEvent(notice: Notice, ev: ExtractedEvent, now: Date): Built {
  if (!ev.date) return { ok: false, reason: "no-date" };

  const company = ev.company ?? notice.company;
  const name = ev.title_hint ?? LABELS[ev.kind];
  const placeholder = !ev.start || ev.confidence === "low";
  let title: string;
  let start: CalendarEvent["start"];
  let end: CalendarEvent["end"];
  let startsAt: string;

  if (placeholder) {
    if (ev.date < istDate(now)) return { ok: false, reason: "past" };
    title = `⚠ ${company} — ${name} (${ev.start ? `${ev.start}? check` : "time TBA"})`;
    start = { date: ev.date, dateTime: null, timeZone: null };
    end = { date: nextDay(ev.date), dateTime: null, timeZone: null };
    startsAt = ev.date;
  } else {
    const startTime = ev.start!;
    if (istToInstant(ev.date, startTime) < now) return { ok: false, reason: "past" };
    title = `${company} — ${name}`;
    startsAt = `${ev.date}T${startTime}`;
    const endsAt = ev.end && ev.end > startTime ? `${ev.date}T${ev.end}` : addMinutes(ev.date, startTime, DEFAULT_DURATION_MIN);
    start = { dateTime: `${startsAt}:00`, timeZone: TIME_ZONE, date: null };
    end = { dateTime: `${endsAt}:00`, timeZone: TIME_ZONE, date: null };
  }

  const header: string[] = [];
  if (placeholder) header.push("⚠ The bot couldn't pin down the time. Check the notice below.");
  if (ev.note) header.push(`ℹ ${ev.note}`);
  if (ev.venue && ev.link) header.push(`Link: ${ev.link}`);
  const description = [
    ...(header.length ? [header.join("\n"), ""] : []),
    notice.body,
    "",
    `Notice #${notice.noticeId} · ${notice.type} · ${notice.subject}`,
  ].join("\n");

  return {
    ok: true,
    title,
    startsAt,
    placeholder,
    event: {
      summary: title,
      description,
      location: ev.venue ?? ev.link ?? null,
      start,
      end,
      colorId: COLORS[ev.kind],
      transparency: "opaque",
      extendedProperties: { private: { noticeId: notice.noticeId, company, kind: ev.kind } },
    },
  };
}

async function handleNotice(notice: Notice, deps: Deps, summary: RunSummary): Promise<void> {
  const { store, calendar } = deps;
  // A failed alert shouldn't fail (and re-run) the whole notice.
  const alert: Alert = (title, message) =>
    deps.alert(title, message).catch((err) => deps.log(`alert failed: ${err instanceof Error ? err.message : err}`));
  const now = deps.now();
  const key = companyKey(notice.company);
  const known = await store.knownEvents(key, istDate(now));
  const events = await deps.extract({ notice, known });
  const label = `#${notice.noticeId} ${notice.company} (${notice.subject})`;

  if (events.length === 0) {
    await alert(`No event found: ${notice.company}`, `${label} looked like a schedule, but the bot found no dated event in it. Please check the notice.`);
    return;
  }

  for (const [slot, ev] of events.entries()) {
    if (ev.action === "cancel") {
      const target = ev.target_event_id === null ? null : await store.getEvent(ev.target_event_id);
      if (target?.status === "cancelled") continue; // already applied on an earlier attempt
      if (!target) {
        await alert(`Cancellation: ${notice.company}`, `${label} cancels something, but there's no matching event on the calendar.`);
        continue;
      }
      const title = `[CANCELLED] ${target.title}`;
      await calendar.patch(target.gcal_event_id, { summary: title, transparency: "transparent" });
      await store.updateEvent(target.id, { title, status: "cancelled" });
      summary.cancelled++;
      continue;
    }

    const built = buildEvent(notice, ev, now);

    if (ev.action === "update" && ev.target_event_id !== null) {
      const target = await store.getEvent(ev.target_event_id);
      if (target) {
        if (!built.ok) {
          if (built.reason === "no-date") {
            const title = `⚠ [MOVED, new time TBA] ${target.title.replace(/^⚠ \[MOVED, new time TBA\] /, "")}`;
            await calendar.patch(target.gcal_event_id, { summary: title });
            await store.updateEvent(target.id, { title });
            await alert(`Moved: ${notice.company}`, `${label} moves "${target.title}" but gives no new time.`);
          }
          continue;
        }
        await calendar.patch(target.gcal_event_id, built.event);
        await store.updateEvent(target.id, { title: built.title, starts_at: built.startsAt, kind: ev.kind });
        summary.updated++;
        if (built.placeholder) {
          await alert(`Check time: ${notice.company}`, `${label} reschedules "${target.title}", but the new time is unclear.`);
        }
        continue;
      }
    }

    // create (or an update whose target no longer exists)
    if (await store.findSlot(notice.noticeId, slot)) continue; // created on an earlier attempt
    if (!built.ok) {
      if (built.reason === "no-date") {
        await alert(`No date: ${notice.company}`, `${label} mentions a ${LABELS[ev.kind]} but no date. Please check the notice.`);
      } else {
        deps.log(`${label}: slot ${slot} is in the past, skipping`);
      }
      continue;
    }
    const gcalId = await calendar.insert(built.event);
    const company = ev.company ?? notice.company;
    await store.addEvent({
      notice_id: notice.noticeId,
      slot,
      company,
      company_key: companyKey(company),
      kind: ev.kind,
      title: built.title,
      starts_at: built.startsAt,
      gcal_event_id: gcalId,
    });
    summary.created++;
    if (built.placeholder) {
      await alert(`Check time: ${company}`, `Added "${built.title}" on ${ev.date}, but the bot couldn't pin down the time.`);
    }
  }
}

export async function run(deps: Deps): Promise<RunSummary> {
  const { store } = deps;
  const summary: RunSummary = { seen: 0, skipped: 0, handled: 0, failed: 0, created: 0, updated: 0, cancelled: 0, more: false };
  const messages = await deps.poll((await store.getCursor()) ?? INITIAL_SINCE);
  summary.seen = messages.length;

  for (const msg of messages) {
    const notice = toNotice(msg);
    if (!notice) {
      deps.log(`ignoring non-MFTP message ${msg.id}: ${msg.title ?? "(no title)"}`);
      await store.setCursor(msg.id);
      continue;
    }

    const prior = await store.getNotice(notice.noticeId);
    if (prior && prior.status !== "pending") {
      await store.setCursor(msg.id); // already handled (ntfy can redeliver)
      continue;
    }

    const record = { noticeId: notice.noticeId, ntfyId: msg.id, subject: notice.subject, company: notice.company };
    if (!IN_SCOPE_TYPES.has(notice.type) || !IN_SCOPE_SUBJECTS.has(notice.subject)) {
      await store.saveNotice({ ...record, status: "skipped", attempts: 0 });
      await store.setCursor(msg.id);
      summary.skipped++;
      continue;
    }

    if (summary.handled >= deps.maxNotices) {
      summary.more = true;
      break;
    }
    summary.handled++;
    const attempts = (prior?.attempts ?? 0) + 1;

    try {
      await handleNotice(notice, deps, summary);
      await store.saveNotice({ ...record, status: "done", attempts });
      await store.setCursor(msg.id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.log(`#${notice.noticeId} failed (attempt ${attempts}): ${error}`);
      if (attempts >= MAX_ATTEMPTS) {
        await store.saveNotice({ ...record, status: "failed", attempts, error });
        await store.setCursor(msg.id);
        summary.failed++;
        await deps.alert(
          `Bot gave up: ${notice.company}`,
          `#${notice.noticeId} ${notice.company} (${notice.subject}) failed ${attempts} times and was skipped. Add it to your calendar manually.\n\n${error}`,
        ).catch(() => {});
        continue;
      }
      // Stop here so this notice (and everything after it) is retried next run, in order.
      await store.saveNotice({ ...record, status: "pending", attempts, error });
      await deps.reportError(
        `#${notice.noticeId} ${notice.company} (attempt ${attempts} of ${MAX_ATTEMPTS}, retrying in 5 min)`,
        err,
      );
      summary.more = true;
      break;
    }
  }

  return summary;
}
