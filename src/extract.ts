// Turns a notice's free text into structured events with Workers AI.

import type { Notice } from "./naarad";
import { describeIst } from "./time";

export const ACTIONS = ["create", "update", "cancel"] as const;
export const KINDS = ["test", "interview", "gd", "ppt", "other"] as const;
export type Action = (typeof ACTIONS)[number];
export type Kind = (typeof KINDS)[number];

export interface ExtractedEvent {
  action: Action;
  target_event_id: number | null;
  kind: Kind;
  company: string | null; // set when one notice covers several companies
  title_hint: string | null;
  date: string | null; // YYYY-MM-DD
  start: string | null; // HH:MM, 24h IST
  end: string | null;
  venue: string | null;
  link: string | null;
  note: string | null;
  confidence: "high" | "low";
}

// An event the bot already created for this company, shown to the LLM so it can
// tell which one a reschedule or cancellation refers to.
export interface KnownEvent {
  id: number;
  kind: string;
  title: string;
  starts_at: string | null;
}

export interface ExtractInput {
  notice: Notice;
  known: KnownEvent[];
}

export type Extractor = (input: ExtractInput) => Promise<ExtractedEvent[]>;

const nullableString = { type: ["string", "null"] };

export const EVENTS_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          target_event_id: { type: ["integer", "null"] },
          kind: { type: "string", enum: [...KINDS] },
          company: nullableString,
          title_hint: nullableString,
          date: nullableString,
          start: nullableString,
          end: nullableString,
          venue: nullableString,
          link: nullableString,
          note: nullableString,
          confidence: { type: "string", enum: ["high", "low"] },
        },
        required: [
          "action", "target_event_id", "kind", "company", "title_hint", "date", "start",
          "end", "venue", "link", "note", "confidence",
        ],
      },
    },
  },
  required: ["events"],
};

export const SYSTEM_PROMPT = `You read placement notices from IIT Kharagpur's placement cell and extract the events a student would attend, so they can be put on a calendar.

Return {"events": [...]}. Rules:
- Events are tests, interviews, group discussions (gd), and PPTs/workshops/seminars (ppt). Anything else that the student attends at a set time is "other". Deadlines (CV submission, form filling) are NOT events.
- Resolve relative dates ("tomorrow", "this Friday") against the notice's post time. Dates are YYYY-MM-DD, times are 24-hour HH:MM in IST.
- If a notice lists several rounds or sessions with different times, return one event per round or session.
- If candidates are split into batches or slots with different times, return ONE event from the earliest start to the latest end, and say in "note" that the student should check which slot is theirs.
- "known_events" lists events already on the calendar for this company. If the notice moves, postpones or changes one of them, use action "update" with its id in target_event_id and give the full new details. If it cancels one, use action "cancel" with its id. If it describes the same event as a known one (same kind, same day, e.g. a company's own PPT notice after a combined CDC schedule listed it), use "update" with its id instead of creating a duplicate. Otherwise use "create" with target_event_id null.
- Some notices (e.g. a "CDC Placement Schedule") list events for several companies; the "company" field of the input is then just the notice's heading. In that case set "company" on each event to the company it is for, as written in the notice. Otherwise set "company" to null.
- title_hint is a short name such as "Online Test", "Technical Interview" or "Pre-Placement Talk". Don't include the company name. Put role names or other details in "note", not in title_hint.
- venue is a room or place; link is a meeting or test URL. Use null when the notice doesn't say.
- confidence is about the date and start time only. Set it "low" only if they are ambiguous, say "TBA", or are said to be in an attachment. A schedule called "tentative" or "subject to change", or links/venues to be "shared separately", is still "high" when the date and time are written out. Mention "tentative" in note instead.
- Never guess a date or time that the notice doesn't support. Use null instead.
- If the notice has no dated event at all, return {"events": []}.`;

export function buildUserPrompt({ notice, known }: ExtractInput): string {
  return JSON.stringify(
    {
      company: notice.company,
      subject: notice.subject,
      posted_at: describeIst(new Date(notice.postedAt * 1000)),
      known_events: known,
      notice: notice.body,
    },
    null,
    2,
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// ERP notices pasted from Google Calendar invites wrap links as google.com/url?q=<real url>.
export function unwrapLink(link: string | null): string | null {
  if (!link) return link;
  try {
    const url = new URL(link);
    const target = url.searchParams.get("q");
    if (/(^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname === "/url" && target && /^https?:\/\//.test(target)) {
      return target;
    }
  } catch {
    // not a URL; keep as is
  }
  return link;
}

// LLM output is untrusted: coerce it into well-formed events, downgrading confidence
// when fields don't parse rather than failing the whole notice.
export function sanitize(raw: unknown, known: KnownEvent[]): ExtractedEvent[] {
  const list = (raw as { events?: unknown })?.events;
  if (!Array.isArray(list)) throw new Error("LLM response has no events array");
  const knownIds = new Set(known.map((k) => k.id));

  return list.map((item: Record<string, unknown>): ExtractedEvent => {
    let confidence: "high" | "low" = item.confidence === "high" ? "high" : "low";
    const date = str(item.date);
    const start = str(item.start);
    const end = str(item.end);
    const validDate = date && DATE_RE.test(date) ? date : null;
    const validStart = start && TIME_RE.test(start) ? start : null;
    const validEnd = end && TIME_RE.test(end) ? end : null;
    // Unparseable or missing date/time is low confidence, whatever the model said.
    if (date !== validDate || start !== validStart || !validDate || !validStart) confidence = "low";

    const target = typeof item.target_event_id === "number" && knownIds.has(item.target_event_id)
      ? item.target_event_id
      : null;
    let action: Action = ACTIONS.includes(item.action as Action) ? (item.action as Action) : "create";
    // An update to an event we never saw (e.g. the bot started after the original notice) is a create.
    if (action === "update" && target === null) action = "create";

    return {
      action,
      target_event_id: target,
      kind: KINDS.includes(item.kind as Kind) ? (item.kind as Kind) : "other",
      company: str(item.company),
      title_hint: str(item.title_hint),
      date: validDate,
      start: validStart,
      end: validEnd,
      venue: str(item.venue),
      link: unwrapLink(str(item.link)),
      note: str(item.note),
      confidence,
    };
  });
}

// The Worker AI binding, or anything with the same run() shape (the eval script uses the REST API).
export interface AiRunner {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface ExtractorConfig {
  ai: AiRunner;
  model: string;
}

export function llmExtractor(cfg: ExtractorConfig): Extractor {
  return async (input) => {
    const result = (await cfg.ai.run(cfg.model, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
      response_format: { type: "json_schema", json_schema: EVENTS_SCHEMA },
      temperature: 0,
      // The default (256) truncates the JSON for a weekly CDC schedule with ~15 events.
      max_tokens: 4096,
    })) as { response?: unknown };
    const out = result.response;
    const raw = typeof out === "string" ? JSON.parse(out) : out;
    return sanitize(raw, input.known);
  };
}
