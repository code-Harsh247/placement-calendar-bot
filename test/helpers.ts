import type { Calendar, CalendarEvent } from "../src/calendar";
import type { ExtractedEvent } from "../src/extract";
import type { NtfyMessage } from "../src/naarad";
import type { NoticeRecord, Store, StoredEvent } from "../src/store";

export function memoryStore() {
  const state = { cursor: null as string | null };
  const kv = new Map<string, string>();
  const notices = new Map<string, NoticeRecord>();
  const events: StoredEvent[] = [];
  const store: Store = {
    async getCursor() { return state.cursor; },
    async setCursor(id) { state.cursor = id; },
    async getState(key) { return kv.get(key) ?? null; },
    async setState(key, value) { kv.set(key, value); },
    async getNotice(id) { return notices.get(id) ?? null; },
    async saveNotice(r) {
      const body = r.body ?? notices.get(r.noticeId)?.body ?? null;
      notices.set(r.noticeId, { ...r, body });
    },
    async getNoticeBody(id) { return notices.get(id)?.body ?? null; },
    async knownEvents(key, today) {
      return events
        .filter((e) => e.company_key === key && e.status === "active" && (!e.starts_at || e.starts_at.slice(0, 10) >= today))
        .map(({ id, kind, title, starts_at }) => ({ id, kind, title, starts_at }));
    },
    async getEvent(id) { return events.find((e) => e.id === id) ?? null; },
    async findSlot(noticeId, slot) { return events.find((e) => e.notice_id === noticeId && e.slot === slot) ?? null; },
    async upcomingEvents(today) {
      return events.filter((e) => e.status === "active" && (!e.starts_at || e.starts_at.slice(0, 10) >= today));
    },
    async addEvent(e) {
      const id = events.length + 1;
      events.push({ ...e, id, status: "active" });
      return id;
    },
    async updateEvent(id, fields) { Object.assign(events.find((e) => e.id === id)!, fields); },
  };
  return { store, state, notices, events };
}

export function fakeCalendar() {
  const inserted: CalendarEvent[] = [];
  const patches: { id: string; event: Partial<CalendarEvent> }[] = [];
  let failNext = 0;
  const calendar: Calendar = {
    async insert(event) {
      if (failNext > 0) { failNext--; throw new Error("calendar down"); }
      inserted.push(event);
      return `gcal-${inserted.length}`;
    },
    async patch(id, event) { patches.push({ id, event }); },
  };
  return { calendar, inserted, patches, failInserts: (n: number) => { failNext = n; } };
}

let seq = 0;
export function message(noticeId: number, subject: string, company: string, body = "", time = NOW_UNIX): NtfyMessage {
  seq++;
  return {
    id: `m${String(seq).padStart(4, "0")}`,
    time,
    event: "message",
    title: `#${noticeId} | PLACEMENT | ${subject} | ${company}`,
    message: body,
  };
}

// Thursday 2026-10-29 10:00 IST
export const NOW = new Date("2026-10-29T04:30:00Z");
export const NOW_UNIX = NOW.getTime() / 1000;

export function event(partial: Partial<ExtractedEvent>): ExtractedEvent {
  return {
    action: "create",
    target_event_id: null,
    kind: "test",
    company: null,
    qualifier: null,
    date: "2026-11-03",
    start: "14:00",
    end: "15:30",
    venue: null,
    link: null,
    confidence: "high",
    ...partial,
  };
}
