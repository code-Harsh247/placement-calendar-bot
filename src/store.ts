// Bot state in D1: the ntfy cursor, which notices were handled, and which calendar
// events the bot created (so reschedules can patch them).

import type { KnownEvent } from "./extract";

export type NoticeStatus = "done" | "skipped" | "pending" | "failed";

export interface NoticeRecord {
  noticeId: string;
  ntfyId: string;
  subject: string;
  company: string;
  status: NoticeStatus;
  attempts: number;
  error?: string | null;
  body?: string | null; // kept for in-scope notices, so descriptions can be regenerated
}

export interface StoredEvent {
  id: number;
  notice_id: string;
  slot: number;
  company: string;
  company_key: string;
  kind: string;
  title: string;
  starts_at: string | null;
  gcal_event_id: string;
  status: "active" | "cancelled";
  details: string | null; // JSON array of description lines
}

export type NewEvent = Omit<StoredEvent, "id" | "status">;

export function parseDetails(details: string | null | undefined): string[] {
  if (!details) return [];
  try {
    const lines = JSON.parse(details);
    return Array.isArray(lines) ? lines.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

export interface Store {
  getCursor(): Promise<string | null>;
  setCursor(ntfyId: string): Promise<void>;
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
  getNotice(noticeId: string): Promise<NoticeRecord | null>;
  saveNotice(record: NoticeRecord): Promise<void>;
  getNoticeBody(noticeId: string): Promise<string | null>;
  // Active events for a company that haven't happened yet (or have no date).
  knownEvents(companyKey: string, today: string): Promise<KnownEvent[]>;
  getEvent(id: number): Promise<StoredEvent | null>;
  findSlot(noticeId: string, slot: number): Promise<StoredEvent | null>;
  // All active events that haven't happened yet, for regenerating descriptions.
  upcomingEvents(today: string): Promise<StoredEvent[]>;
  addEvent(event: NewEvent): Promise<number>;
  updateEvent(id: number, fields: Partial<Pick<StoredEvent, "title" | "starts_at" | "kind" | "status" | "details">>): Promise<void>;
}

// "Goldman Sachs (India) Pvt. Ltd." and "goldman sachs india" should match, as should
// "CAPITAL ONE SERVICES INDIA PVT. LTD." and "CAPITAL ONE" from a combined CDC schedule.
export function companyKey(company: string): string {
  return company
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|llc|corp|corporation|india|technologies|technology|solutions|services|software|systems|labs|group|global)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const nowIso = () => new Date().toISOString();

export function d1Store(db: D1Database): Store {
  const getState = async (key: string) => {
    const row = await db.prepare("SELECT value FROM state WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  };
  const setState = async (key: string, value: string) => {
    await db
      .prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run();
  };
  return {
    getState,
    setState,
    getCursor: () => getState("cursor"),
    setCursor: (ntfyId) => setState("cursor", ntfyId),
    async getNotice(noticeId) {
      const row = await db
        .prepare("SELECT notice_id, ntfy_id, subject, company, status, attempts, error FROM notices WHERE notice_id = ?")
        .bind(noticeId)
        .first<{ notice_id: string; ntfy_id: string; subject: string; company: string; status: NoticeStatus; attempts: number; error: string | null }>();
      if (!row) return null;
      return {
        noticeId: row.notice_id, ntfyId: row.ntfy_id, subject: row.subject, company: row.company,
        status: row.status, attempts: row.attempts, error: row.error,
      };
    },
    async saveNotice(r) {
      await db
        .prepare(
          `INSERT INTO notices (notice_id, ntfy_id, subject, company, status, attempts, error, body, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (notice_id) DO UPDATE SET ntfy_id = excluded.ntfy_id, status = excluded.status,
             attempts = excluded.attempts, error = excluded.error, body = COALESCE(excluded.body, notices.body),
             updated_at = excluded.updated_at`,
        )
        .bind(r.noticeId, r.ntfyId, r.subject, r.company, r.status, r.attempts, r.error ?? null, r.body ?? null, nowIso())
        .run();
    },
    async getNoticeBody(noticeId) {
      const row = await db.prepare("SELECT body FROM notices WHERE notice_id = ?").bind(noticeId).first<{ body: string | null }>();
      return row?.body ?? null;
    },
    async knownEvents(key, today) {
      const { results } = await db
        .prepare(
          `SELECT id, kind, title, starts_at FROM events
           WHERE company_key = ? AND status = 'active' AND (starts_at IS NULL OR substr(starts_at, 1, 10) >= ?)
           ORDER BY starts_at`,
        )
        .bind(key, today)
        .all<KnownEvent>();
      return results;
    },
    async getEvent(id) {
      return db.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<StoredEvent>();
    },
    async findSlot(noticeId, slot) {
      return db.prepare("SELECT * FROM events WHERE notice_id = ? AND slot = ?").bind(noticeId, slot).first<StoredEvent>();
    },
    async upcomingEvents(today) {
      const { results } = await db
        .prepare(
          `SELECT * FROM events WHERE status = 'active' AND (starts_at IS NULL OR substr(starts_at, 1, 10) >= ?)
           ORDER BY notice_id, slot`,
        )
        .bind(today)
        .all<StoredEvent>();
      return results;
    },
    async addEvent(e) {
      const row = await db
        .prepare(
          `INSERT INTO events (notice_id, slot, company, company_key, kind, title, starts_at, gcal_event_id, details, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(e.notice_id, e.slot, e.company, e.company_key, e.kind, e.title, e.starts_at, e.gcal_event_id, e.details, nowIso())
        .first<{ id: number }>();
      return row!.id;
    },
    async updateEvent(id, fields) {
      const entries = Object.entries(fields);
      if (entries.length === 0) return;
      const sets = entries.map(([k]) => `${k} = ?`).join(", ");
      await db
        .prepare(`UPDATE events SET ${sets}, updated_at = ? WHERE id = ?`)
        .bind(...entries.map(([, v]) => v), nowIso(), id)
        .run();
    },
  };
}
