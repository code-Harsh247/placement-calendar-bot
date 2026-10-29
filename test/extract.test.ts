import { describe, expect, it } from "vitest";
import { buildUserPrompt, EVENTS_SCHEMA, llmExtractor, sanitize, toGeminiSchema } from "../src/extract";
import type { Notice } from "../src/naarad";

const notice: Notice = {
  ntfyId: "m1", noticeId: "1", type: "PLACEMENT", subject: "Schedule", company: "Google",
  body: "Online test tomorrow at 2 PM", postedAt: Date.parse("2026-10-29T04:30:00Z") / 1000,
};

describe("toGeminiSchema", () => {
  it("converts nullable JSON Schema types to Gemini's format", () => {
    const g = toGeminiSchema(EVENTS_SCHEMA) as any;
    expect(g.type).toBe("OBJECT");
    const item = g.properties.events.items;
    expect(item.properties.date).toEqual({ type: "STRING", nullable: true });
    expect(item.properties.target_event_id).toEqual({ type: "INTEGER", nullable: true });
    expect(item.properties.action).toEqual({ type: "STRING", enum: ["create", "update", "cancel"] });
  });
});

describe("buildUserPrompt", () => {
  it("includes the IST post time with weekday", () => {
    expect(buildUserPrompt({ notice, known: [] })).toContain("Thursday 2026-10-29 10:00 IST");
  });
});

describe("sanitize", () => {
  const good = {
    action: "create", target_event_id: null, kind: "test", title_hint: "Online Test",
    date: "2026-10-30", start: "14:00", end: null, venue: "", link: null, note: null, confidence: "high",
  };

  it("passes good events through and blanks empty strings", () => {
    expect(sanitize({ events: [good] }, [])[0]).toMatchObject({ date: "2026-10-30", start: "14:00", venue: null, confidence: "high" });
  });

  it("downgrades confidence when the date or time doesn't parse", () => {
    const [ev] = sanitize({ events: [{ ...good, start: "2 PM" }] }, []);
    expect(ev).toMatchObject({ start: null, confidence: "low" });
  });

  it("turns an update with an unknown target into a create", () => {
    const [ev] = sanitize({ events: [{ ...good, action: "update", target_event_id: 99 }] }, []);
    expect(ev).toMatchObject({ action: "create", target_event_id: null });
  });

  it("keeps a valid update target", () => {
    const [ev] = sanitize({ events: [{ ...good, action: "update", target_event_id: 5 }] }, [{ id: 5, kind: "test", title: "x", starts_at: null }]);
    expect(ev).toMatchObject({ action: "update", target_event_id: 5 });
  });

  it("rejects output without an events array", () => {
    expect(() => sanitize({ foo: 1 }, [])).toThrow();
  });
});

describe("llmExtractor", () => {
  const output = { events: [{ action: "create", target_event_id: null, kind: "test", title_hint: "Online Test", date: "2026-10-30", start: "14:00", end: null, venue: null, link: null, note: null, confidence: "high" }] };

  it("parses Gemini's JSON reply", async () => {
    let body: any;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] });
    }) as unknown as typeof fetch;
    const events = await llmExtractor({ geminiApiKey: "k", geminiModel: "m" }, fakeFetch)({ notice, known: [] });
    expect(events).toHaveLength(1);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("falls back to Workers AI when Gemini is unavailable", async () => {
    const fakeFetch = (async () => new Response('{"error":{"message":"User location is not supported"}}', { status: 400 })) as unknown as typeof fetch;
    const ai = { run: async () => ({ response: output }) };
    const events = await llmExtractor({ geminiApiKey: "k", geminiModel: "m", ai, workersAiModel: "w" }, fakeFetch)({ notice, known: [] });
    expect(events[0]?.date).toBe("2026-10-30");
  });

  it("does not fall back on a bad request", async () => {
    const fakeFetch = (async () => new Response("bad schema", { status: 400 })) as unknown as typeof fetch;
    const ai = { run: async () => ({ response: output }) };
    await expect(llmExtractor({ geminiApiKey: "k", geminiModel: "m", ai, workersAiModel: "w" }, fakeFetch)({ notice, known: [] })).rejects.toThrow(/400/);
  });
});
