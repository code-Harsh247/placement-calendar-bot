// Step 2: writes each event's calendar description — a few short lines with only what
// the student needs (link, meeting ID, passcode, venue, reporting time).
//
// The model's lines are untrusted: every URL, meeting ID and passcode in them must appear
// in the notice (or the event's previous details). If one doesn't, that event falls back
// to plain lines built from step 1's venue and link, so a mangled link never reaches the calendar.

import { unwrapLink, type AiRunner, type Kind } from "./extract";
import type { Notice } from "./naarad";

export interface DescribeItem {
  ref: number;
  company: string;
  kind: Kind;
  date: string | null;
  start: string | null;
  end: string | null;
  venue: string | null;
  link: string | null;
  previous_details: string[]; // what the calendar shows now, for updates
}

export interface DescribeResult {
  lines: Map<number, string[]>;
  // Events whose lines failed validation and got the fallback instead.
  rejected: { ref: number; reason: string }[];
}

export type Describer = (notice: Notice, items: DescribeItem[]) => Promise<DescribeResult>;

export const MAX_LINES = 5;
const MAX_LINE_LENGTH = 300;

export const DESCRIBE_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "integer" },
          lines: { type: "array", items: { type: "string" } },
        },
        required: ["ref", "lines"],
      },
    },
  },
  required: ["entries"],
};

export const DESCRIBE_PROMPT = `You write calendar event descriptions for a student, from an IIT Kharagpur placement notice. The title (company and event type) and the time are set separately, so don't repeat the company, date or time.

For each item in "events", return {"ref": <its ref>, "lines": [...]}: at most 5 short lines (under 160 characters each) with only what the student needs, such as:
- the meeting or test link, meeting ID and passcode, copied exactly as written in the notice
- the venue or room, and when to report or join (e.g. "Join 15 min early")
- which roles or profiles it is for, eligibility, or batches, if the notice says
- "Attendance compulsory" or "Schedule is tentative", if the notice says so
- anything to bring or do beforehand

Only write what the notice actually says. Don't add general advice the notice doesn't give, such as "Join 15 min early", "Be on time" or "Attendance compulsory".
Every line must add something the title and time don't already say: never write lines like "Online PPT", "Test" or "Test for All Profiles", and never restate the date, start or end time.
Leave out boilerplate: CDC sign-offs, disclaimers, POC phone numbers, and the notice's own date stamp. Never invent or reformat a link, meeting ID or passcode.
If the notice covers several companies, each item's lines must only contain what applies to that item's company.
If an item has "previous_details", that's what the calendar shows now: keep the lines that are still valid (especially links and passcodes) and change only what this notice changes.
If the notice has nothing useful for an item, return an empty "lines" array.

Return {"entries": [...]}, one entry per item.`;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
// Meeting IDs like "930 2629 0652": digits with optional spaces, 6+ digits in total.
const DIGITS_RE = /\d[\d ]{4,}\d/g;
const SECRET_RE = /\b(?:passcode|password|pwd|pin|code)\b\s*[:=]?\s*([A-Za-z0-9@#$%^&*._-]{3,})/gi;

const trimUrl = (url: string) => url.replace(/[.,;:!?]+$/, "");

// Returns why the lines can't be trusted, or null if every critical token is in `sources`.
export function validateLines(lines: string[], sources: string): string | null {
  const sourceUrls = new Set([...sources.matchAll(URL_RE)].map((m) => trimUrl(m[0])).flatMap((u) => [u, unwrapLink(u) ?? u]));
  const sourceDigits = sources.replace(/\s+/g, "");
  for (const line of lines) {
    for (const [raw] of line.matchAll(URL_RE)) {
      const url = trimUrl(raw);
      if (!sourceUrls.has(url) && !sources.includes(url)) return `link not in the notice: ${url}`;
    }
    // Links were checked whole above; "pwd=…" or digits inside one aren't separate tokens.
    const bare = line.replace(URL_RE, " ");
    for (const [run] of bare.matchAll(DIGITS_RE)) {
      const digits = run.replace(/\s+/g, "");
      if (digits.length >= 6 && !sourceDigits.includes(digits)) return `number not in the notice: ${run.trim()}`;
    }
    for (const m of bare.matchAll(SECRET_RE)) {
      if (!sources.includes(m[1]!)) return `passcode not in the notice: ${m[1]}`;
    }
  }
  return null;
}

// Plain lines from step 1's facts, used when the model's lines are missing or rejected.
export function fallbackLines(item: Pick<DescribeItem, "venue" | "link" | "previous_details">): string[] {
  const lines = [...item.previous_details];
  if (item.venue && !lines.some((l) => l.includes(item.venue!))) lines.push(`Venue: ${item.venue}`);
  if (item.link && !lines.some((l) => l.includes(item.link!))) lines.push(`Link: ${item.link}`);
  return lines.slice(0, MAX_LINES + 1);
}

function cleanLines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is string => typeof l === "string")
    .map((l) => l.replace(/\s+/g, " ").trim().replace(URL_RE, (u) => unwrapLink(u) ?? u))
    .filter((l) => l !== "" && l.length <= MAX_LINE_LENGTH)
    .slice(0, MAX_LINES);
}

// Drops lines that only restate the event's time ("Join at 5:00 PM", "Duration: 30 min"),
// which the calendar already shows. Lines like "Batch A: 10:00 AM - 11:00 AM" stay.
export function dropRestated(lines: string[], item: Pick<DescribeItem, "start">): string[] {
  const times: string[] = [];
  if (item.start) {
    const [h, m] = item.start.split(":").map(Number) as [number, number];
    const h12 = ((h + 11) % 12) + 1;
    times.push(item.start, `${h12}:${String(m).padStart(2, "0")}`, `${h12} ${h < 12 ? "am" : "pm"}`, `${h12}${h < 12 ? "am" : "pm"}`);
  }
  return lines.filter((line) => {
    const l = line.toLowerCase();
    if (/^(duration|date|time|timings?)\b/.test(l)) return false;
    return !(/^(join|starts?|begins?|scheduled|at)\b/.test(l) && times.some((t) => l.includes(t)));
  });
}

export function buildDescribePrompt(notice: Notice, items: DescribeItem[]): string {
  return JSON.stringify({ notice: notice.body, events: items }, null, 2);
}

export function llmDescriber(cfg: { ai: AiRunner; model: string }): Describer {
  return async (notice, items) => {
    const result: DescribeResult = { lines: new Map(), rejected: [] };
    if (items.length === 0) return result;

    const response = (await cfg.ai.run(cfg.model, {
      messages: [
        { role: "system", content: DESCRIBE_PROMPT },
        { role: "user", content: buildDescribePrompt(notice, items) },
      ],
      response_format: { type: "json_schema", json_schema: DESCRIBE_SCHEMA },
      temperature: 0,
      max_tokens: 4096,
    })) as { response?: unknown };
    const out = response.response;
    const raw = (typeof out === "string" ? JSON.parse(out) : out) as { entries?: unknown };
    if (!Array.isArray(raw?.entries)) throw new Error("description step: response has no entries array");
    const entries = raw.entries as { ref?: unknown; lines?: unknown }[];

    for (const item of items) {
      const lines = dropRestated(cleanLines(entries.find((e) => e.ref === item.ref)?.lines), item);
      const sources = [notice.body, ...item.previous_details, item.link ?? "", item.venue ?? ""].join("\n");
      const problem = validateLines(lines, sources);
      if (problem) {
        result.rejected.push({ ref: item.ref, reason: problem });
        result.lines.set(item.ref, fallbackLines(item));
      } else {
        result.lines.set(item.ref, lines.length > 0 ? lines : fallbackLines(item));
      }
    }
    return result;
  };
}
