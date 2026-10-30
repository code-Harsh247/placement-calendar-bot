// One polling run: read new notices, find their events (step 1), write the events'
// descriptions (step 2), and sync them to the calendar.

import type { Alert } from "./alert";
import type { Calendar, CalendarEvent } from "./calendar";
import { fallbackLines, type DescribeItem, type Describer } from "./describe";
import type { ReportError } from "./errors";
import type { ExtractedEvent, Extractor, Kind } from "./extract";
import { IN_SCOPE_SUBJECTS, IN_SCOPE_TYPES, toNotice, type Notice, type NtfyMessage } from "./naarad";
import { companyKey, parseDetails, type Store, type StoredEvent } from "./store";
import { addMinutes, istDate, istToInstant, nextDay, TIME_ZONE } from "./time";
import { eventTitle, KIND_LABELS } from "./title";

export interface Deps {
  store: Store;
  poll: (since: string) => Promise<NtfyMessage[]>;
  find: Extractor; // step 1
  describe: Describer; // step 2
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

// Google Calendar event colours: Tomato, Tangerine, Banana, Blueberry, Graphite.
const COLORS: Record<Kind, string> = { test: "11", interview: "6", gd: "5", ppt: "9", other: "8" };

const PLACEHOLDER_LINE = "⚠ The bot couldn't pin down the time. Check the notice in the ntfy app.";

type Timing =
  | { ok: true; start: CalendarEvent["start"]; end: CalendarEvent["end"]; startsAt: string; placeholder: boolean }
  | { ok: false; reason: "no-date" | "past" };

export function buildTiming(ev: ExtractedEvent, now: Date): Timing {
  if (!ev.date) return { ok: false, reason: "no-date" };
  const placeholder = !ev.start || ev.confidence === "low";

  if (placeholder) {
    if (ev.date < istDate(now)) return { ok: false, reason: "past" };
    return {
      ok: true,
      placeholder,
      startsAt: ev.date,
      start: { date: ev.date, dateTime: null, timeZone: null },
      end: { date: nextDay(ev.date), dateTime: null, timeZone: null },
    };
  }
  const startTime = ev.start!;
  if (istToInstant(ev.date, startTime) < now) return { ok: false, reason: "past" };
  const startsAt = `${ev.date}T${startTime}`;
  const endsAt = ev.end && ev.end > startTime ? `${ev.date}T${ev.end}` : addMinutes(ev.date, startTime, DEFAULT_DURATION_MIN);
  return {
    ok: true,
    placeholder,
    startsAt,
    start: { dateTime: `${startsAt}:00`, timeZone: TIME_ZONE, date: null },
    end: { dateTime: `${endsAt}:00`, timeZone: TIME_ZONE, date: null },
  };
}

// The short description: the detail lines from step 2 and a footer pointing at the notice.
export function composeDescription(lines: string[], placeholder: boolean, notice: Notice): string {
  const body = [...(placeholder ? [PLACEHOLDER_LINE] : []), ...lines].join("\n");
  const footer = `Notice #${notice.noticeId} · ${notice.subject}`;
  return body ? `${body}\n\n${footer}` : footer;
}

function calendarEvent(
  notice: Notice,
  company: string,
  ev: ExtractedEvent,
  timing: Extract<Timing, { ok: true }>,
  title: string,
  description: string,
): CalendarEvent {
  return {
    summary: title,
    description,
    location: ev.venue ?? ev.link ?? null,
    start: timing.start,
    end: timing.end,
    colorId: COLORS[ev.kind],
    transparency: "opaque",
    extendedProperties: { private: { noticeId: notice.noticeId, company, kind: ev.kind } },
  };
}

// What step 1 found, turned into concrete calendar operations before anything is written.
type Plan =
  | { op: "cancel"; target: StoredEvent }
  | { op: "moved-tba"; target: StoredEvent }
  | { op: "info"; ev: ExtractedEvent; target: StoredEvent }
  | { op: "update"; ev: ExtractedEvent; target: StoredEvent; company: string; timing: Extract<Timing, { ok: true }>; title: string }
  | { op: "create"; ev: ExtractedEvent; slot: number; company: string; timing: Extract<Timing, { ok: true }>; title: string };

async function handleNotice(notice: Notice, deps: Deps, summary: RunSummary, followUp: boolean): Promise<void> {
  const { store, calendar } = deps;
  // A failed alert shouldn't fail (and re-run) the whole notice.
  const alert: Alert = (title, message) =>
    deps.alert(title, message).catch((err) => deps.log(`alert failed: ${err instanceof Error ? err.message : err}`));
  const now = deps.now();
  const known = await store.knownEvents(companyKey(notice.company), istDate(now));
  const events = await deps.find({ notice, known, followUp });
  const label = `#${notice.noticeId} ${notice.company} (${notice.subject})`;

  if (events.length === 0) {
    if (!followUp) {
      await alert(`No event found: ${notice.company}`, `${label} looked like a schedule, but the bot found no dated event in it. Please check the notice.`);
    }
    return;
  }

  // Phase 1: decide what to do with each event.
  const plans: Plan[] = [];
  for (const [slot, ev] of events.entries()) {
    const target = ev.target_event_id === null ? null : await store.getEvent(ev.target_event_id);

    if (ev.action === "cancel") {
      if (target?.status === "cancelled") continue; // already applied on an earlier attempt
      if (!target) {
        await alert(`Cancellation: ${notice.company}`, `${label} cancels something, but there's no matching event on the calendar.`);
        continue;
      }
      plans.push({ op: "cancel", target });
      continue;
    }

    if (ev.action === "info") {
      if (target?.status === "active") plans.push({ op: "info", ev, target });
      continue;
    }

    const timing = buildTiming(ev, now);
    const company = ev.company ?? notice.company;

    if (ev.action === "update" && target) {
      if (!timing.ok) {
        if (timing.reason === "no-date") plans.push({ op: "moved-tba", target });
        continue;
      }
      plans.push({ op: "update", ev, target, company, timing, title: eventTitle(company, ev.kind, ev.qualifier, timing.placeholder) });
      continue;
    }

    // create (or an update whose target no longer exists)
    if (await store.findSlot(notice.noticeId, slot)) continue; // created on an earlier attempt
    if (!timing.ok) {
      if (timing.reason === "no-date") {
        await alert(`No date: ${notice.company}`, `${label} mentions a ${KIND_LABELS[ev.kind]} but no date. Please check the notice.`);
      } else {
        deps.log(`${label}: slot ${slot} is in the past, skipping`);
      }
      continue;
    }
    plans.push({ op: "create", ev, slot, company, timing, title: eventTitle(company, ev.kind, ev.qualifier, timing.placeholder) });
  }

  // Phase 2: one step-2 call writes the descriptions for every event that needs one.
  const items: DescribeItem[] = [];
  for (const [ref, plan] of plans.entries()) {
    if (plan.op !== "create" && plan.op !== "update" && plan.op !== "info") continue;
    const { ev } = plan;
    items.push({
      ref,
      company: plan.op === "info" ? plan.target.company : plan.company,
      kind: plan.op === "info" ? (plan.target.kind as Kind) : ev.kind,
      date: ev.date,
      start: ev.start,
      end: ev.end,
      venue: ev.venue,
      link: ev.link,
      previous_details: plan.op === "create" ? [] : parseDetails(plan.target.details),
    });
  }
  let lines = new Map<number, string[]>();
  if (items.length > 0) {
    try {
      const described = await deps.describe(notice, items);
      lines = described.lines;
      for (const { reason } of described.rejected) {
        await deps.reportError(`description for ${label} looked wrong, used plain details`, new Error(reason));
      }
    } catch (err) {
      await deps.reportError(`description step for ${label} failed, used plain details`, err);
    }
  }
  const detailsFor = (ref: number) => lines.get(ref) ?? fallbackLines(items.find((i) => i.ref === ref)!);

  // Phase 3: write to the calendar and the database.
  for (const [ref, plan] of plans.entries()) {
    switch (plan.op) {
      case "cancel": {
        const title = `[CANCELLED] ${plan.target.title}`;
        await calendar.patch(plan.target.gcal_event_id, { summary: title, transparency: "transparent" });
        await store.updateEvent(plan.target.id, { title, status: "cancelled" });
        summary.cancelled++;
        break;
      }
      case "moved-tba": {
        const title = `⚠ [MOVED, new time TBA] ${plan.target.title.replace(/^⚠ \[MOVED, new time TBA\] /, "")}`;
        await calendar.patch(plan.target.gcal_event_id, { summary: title });
        await store.updateEvent(plan.target.id, { title });
        summary.updated++;
        await alert(`Moved: ${notice.company}`, `${label} moves "${plan.target.title}" but gives no new time.`);
        break;
      }
      case "info": {
        const details = detailsFor(ref);
        const placeholder = plan.target.title.startsWith("⚠");
        const location = plan.ev.venue ?? plan.ev.link;
        await calendar.patch(plan.target.gcal_event_id, {
          description: composeDescription(details, placeholder, notice),
          ...(location ? { location } : {}),
        });
        await store.updateEvent(plan.target.id, { details: JSON.stringify(details) });
        summary.updated++;
        break;
      }
      case "update": {
        const details = detailsFor(ref);
        const description = composeDescription(details, plan.timing.placeholder, notice);
        await calendar.patch(plan.target.gcal_event_id, calendarEvent(notice, plan.company, plan.ev, plan.timing, plan.title, description));
        await store.updateEvent(plan.target.id, {
          title: plan.title,
          starts_at: plan.timing.startsAt,
          kind: plan.ev.kind,
          details: JSON.stringify(details),
        });
        summary.updated++;
        if (plan.timing.placeholder) {
          await alert(`Check time: ${plan.company}`, `${label} reschedules "${plan.target.title}", but the new time is unclear.`);
        }
        break;
      }
      case "create": {
        const details = detailsFor(ref);
        const description = composeDescription(details, plan.timing.placeholder, notice);
        const gcalId = await calendar.insert(calendarEvent(notice, plan.company, plan.ev, plan.timing, plan.title, description));
        await store.addEvent({
          notice_id: notice.noticeId,
          slot: plan.slot,
          company: plan.company,
          company_key: companyKey(plan.company),
          kind: plan.ev.kind,
          title: plan.title,
          starts_at: plan.timing.startsAt,
          gcal_event_id: gcalId,
          details: JSON.stringify(details),
        });
        summary.created++;
        if (plan.timing.placeholder) {
          await alert(`Check time: ${plan.company}`, `Added "${plan.title}" on ${plan.ev.date}, but the bot couldn't pin down the time.`);
        }
        break;
      }
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
    const isPlacement = IN_SCOPE_TYPES.has(notice.type);
    const isSchedule = isPlacement && IN_SCOPE_SUBJECTS.has(notice.subject);
    // Other subjects (e.g. "Urgent" carrying a PPT link) are read only for companies with upcoming events.
    const followUp =
      isPlacement && !isSchedule &&
      (await store.knownEvents(companyKey(notice.company), istDate(deps.now()))).length > 0;
    if (!isSchedule && !followUp) {
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
      await handleNotice(notice, deps, summary, followUp);
      await store.saveNotice({ ...record, status: "done", attempts, body: notice.body });
      await store.setCursor(msg.id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.log(`#${notice.noticeId} failed (attempt ${attempts}): ${error}`);
      if (attempts >= MAX_ATTEMPTS) {
        await store.saveNotice({ ...record, status: "failed", attempts, error, body: notice.body });
        await store.setCursor(msg.id);
        summary.failed++;
        await deps.alert(
          `Bot gave up: ${notice.company}`,
          `#${notice.noticeId} ${notice.company} (${notice.subject}) failed ${attempts} times and was skipped. Add it to your calendar manually.\n\n${error}`,
        ).catch(() => {});
        continue;
      }
      // Stop here so this notice (and everything after it) is retried next run, in order.
      await store.saveNotice({ ...record, status: "pending", attempts, error, body: notice.body });
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
