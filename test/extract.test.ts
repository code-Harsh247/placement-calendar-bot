import { describe, expect, it } from "vitest";
import { buildUserPrompt, EVENTS_SCHEMA, llmExtractor, sanitize } from "../src/extract";
import type { Notice } from "../src/naarad";

const notice: Notice = {
  ntfyId: "m1", noticeId: "1", type: "PLACEMENT", subject: "Schedule", company: "Google",
  body: "Online test tomorrow at 2 PM", postedAt: Date.parse("2026-10-29T04:30:00Z") / 1000,
};

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

  it("treats a missing start time as low confidence", () => {
    const [ev] = sanitize({ events: [{ ...good, start: null, confidence: "high" }] }, []);
    expect(ev?.confidence).toBe("low");
  });

  it("turns an update with an unknown target into a create", () => {
    const [ev] = sanitize({ events: [{ ...good, action: "update", target_event_id: 99 }] }, []);
    expect(ev).toMatchObject({ action: "create", target_event_id: null });
  });

  it("keeps a valid update target", () => {
    const [ev] = sanitize({ events: [{ ...good, action: "update", target_event_id: 5 }] }, [{ id: 5, kind: "test", title: "x", starts_at: null }]);
    expect(ev).toMatchObject({ action: "update", target_event_id: 5 });
  });

  it("unwraps google.com/url redirect links", () => {
    const wrapped = "https://www.google.com/url?q=https%3A%2F%2Fcapitalone.zoom.us%2Fj%2F930%3Fpwd%3Dabc&sa=D&source=calendar";
    expect(sanitize({ events: [{ ...good, link: wrapped }] }, [])[0]?.link).toBe("https://capitalone.zoom.us/j/930?pwd=abc");
    expect(sanitize({ events: [{ ...good, link: "https://meet.google.com/abc" }] }, [])[0]?.link).toBe("https://meet.google.com/abc");
  });

  it("rejects output without an events array", () => {
    expect(() => sanitize({ foo: 1 }, [])).toThrow();
  });
});

describe("llmExtractor", () => {
  const output = { events: [{ action: "create", target_event_id: null, kind: "test", company: null, title_hint: "Online Test", date: "2026-10-30", start: "14:00", end: null, venue: null, link: null, note: null, confidence: "high" }] };

  it("sends the prompt and schema to Workers AI and parses an object reply", async () => {
    let call: { model: string; input: any } | undefined;
    const ai = { run: async (model: string, input: unknown) => { call = { model, input }; return { response: output }; } };
    const events = await llmExtractor({ ai, model: "@cf/test-model" })({ notice, known: [] });
    expect(events).toHaveLength(1);
    expect(call?.model).toBe("@cf/test-model");
    expect(call?.input.response_format).toEqual({ type: "json_schema", json_schema: EVENTS_SCHEMA });
    expect(call?.input.max_tokens).toBe(4096);
    expect(call?.input.messages[1].content).toContain("Online test tomorrow");
  });

  it("parses a JSON string reply", async () => {
    const ai = { run: async () => ({ response: JSON.stringify(output) }) };
    const events = await llmExtractor({ ai, model: "m" })({ notice, known: [] });
    expect(events[0]?.date).toBe("2026-10-30");
  });

  it("fails on a truncated reply so the notice is retried", async () => {
    const ai = { run: async () => ({ response: "{\"events\": [{\"action\": \"cre" }) };
    await expect(llmExtractor({ ai, model: "m" })({ notice, known: [] })).rejects.toThrow();
  });

  it("passes Workers AI errors through", async () => {
    const ai = { run: async () => { throw new Error("3040: Capacity temporarily exceeded"); } };
    await expect(llmExtractor({ ai, model: "m" })({ notice, known: [] })).rejects.toThrow(/Capacity/);
  });
});
