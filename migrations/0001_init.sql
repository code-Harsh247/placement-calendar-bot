-- Key/value state, e.g. the ntfy message cursor.
CREATE TABLE state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per MFTP notice the bot has seen.
-- status: done | skipped | pending (failed, will retry) | failed (gave up)
CREATE TABLE notices (
  notice_id  TEXT PRIMARY KEY,
  ntfy_id    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  company    TEXT NOT NULL,
  status     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  updated_at TEXT NOT NULL
);

-- One row per calendar event the bot created.
-- starts_at is IST wall-clock: 'YYYY-MM-DDTHH:MM' for timed events, 'YYYY-MM-DD' for all-day ones.
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id     TEXT NOT NULL,
  slot          INTEGER NOT NULL,
  company       TEXT NOT NULL,
  company_key   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  starts_at     TEXT,
  gcal_event_id TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  updated_at    TEXT NOT NULL,
  UNIQUE (notice_id, slot)
);

CREATE INDEX events_by_company ON events (company_key, status);
