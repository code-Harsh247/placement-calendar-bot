// Turns a notice's free text into structured events with an LLM.
// Gemini is the primary model; Workers AI is the fallback when Gemini is unavailable
// (rate limits, 5xx, or "location not supported" from some Cloudflare regions).

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
          "action", "target_event_id", "kind", "title_hint", "date", "start",
          "end", "venue", "link", "note", "confidence",
        ],
      },
    },
  },
  required: ["events"],
};

// Gemini's responseSchema uses the OpenAPI subset: upper-case types and `nullable`.
type Schema = { [key: string]: unknown };
export function toGeminiSchema(schema: Schema): Schema {
  const out: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") {
      const types = Array.isArray(value) ? value : [value];
      const real = types.filter((t) => t !== "null") as string[];
      out.type = real[0]!.toUpperCase();
      if (real.length < types.length) out.nullable = true;
    } else if (key === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, Schema>).map(([k, v]) => [k, toGeminiSchema(v)]),
      );
    } else if (key === "items") {
      out.items = toGeminiSchema(value as Schema);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const SYSTEM_PROMPT = `You read placement notices from IIT Kharagpur's placement cell and extract the events a student would attend, so they can be put on a calendar.

Return {"events": [...]}. Rules:
- Events are tests, interviews, group discussions (gd), and PPTs/workshops/seminars (ppt). Anything else that the student attends at a set time is "other". Deadlines (CV submission, form filling) are NOT events.
- Resolve relative dates ("tomorrow", "this Friday") against the notice's post time. Dates are YYYY-MM-DD, times are 24-hour HH:MM in IST.
- If a notice lists several rounds or sessions with different times, return one event per round or session.
- If candidates are split into batches or slots with different times, return ONE event from the earliest start to the latest end, and say in "note" that the student should check which slot is theirs.
- "known_events" lists events already on the calendar for this company. If the notice moves, postpones or changes one of them, use action "update" with its id in target_event_id and give the full new details. If it cancels one, use action "cancel" with its id. Otherwise use "create" with target_event_id null.
- title_hint is a short name such as "Online Test", "Technical Interview" or "Pre-Placement Talk". Don't include the company name.
- venue is a room or place; link is a meeting or test URL. Use null when the notice doesn't say.
- Set confidence "low" if the date or time is ambiguous, says "TBA", or the notice says details are in an attachment.
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
    if (date !== validDate || start !== validStart) confidence = "low";

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
      title_hint: str(item.title_hint),
      date: validDate,
      start: validStart,
      end: validEnd,
      venue: str(item.venue),
      link: str(item.link),
      note: str(item.note),
      confidence,
    };
  });
}

export interface ExtractorConfig {
  geminiApiKey: string;
  geminiModel: string;
  ai?: { run(model: string, input: unknown): Promise<unknown> };
  workersAiModel?: string;
  log?: (msg: string) => void;
}

class GeminiUnavailable extends Error {}

async function callGemini(cfg: ExtractorConfig, input: ExtractInput, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.geminiApiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: buildUserPrompt(input) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(EVENTS_SCHEMA),
        },
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    const unavailable = res.status === 429 || res.status >= 500 || /location is not supported/i.test(text);
    const err = `Gemini HTTP ${res.status}: ${text.slice(0, 300)}`;
    throw unavailable ? new GeminiUnavailable(err) : new Error(err);
  }
  const body = JSON.parse(text) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const out = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) throw new GeminiUnavailable(`Gemini returned no content: ${text.slice(0, 300)}`);
  return JSON.parse(out);
}

async function callWorkersAi(cfg: ExtractorConfig, input: ExtractInput): Promise<unknown> {
  if (!cfg.ai || !cfg.workersAiModel) throw new Error("Workers AI fallback is not configured");
  const result = (await cfg.ai.run(cfg.workersAiModel, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ],
    response_format: { type: "json_schema", json_schema: EVENTS_SCHEMA },
    temperature: 0,
  })) as { response?: unknown };
  const out = result.response;
  return typeof out === "string" ? JSON.parse(out) : out;
}

export function llmExtractor(cfg: ExtractorConfig, fetchFn: typeof fetch = fetch): Extractor {
  return async (input) => {
    let raw: unknown;
    try {
      raw = await callGemini(cfg, input, fetchFn);
    } catch (err) {
      if (!(err instanceof GeminiUnavailable)) throw err;
      cfg.log?.(`${err.message}; falling back to Workers AI`);
      raw = await callWorkersAi(cfg, input);
    }
    return sanitize(raw, input.known);
  };
}
