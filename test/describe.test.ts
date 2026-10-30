import { describe, expect, it } from "vitest";
import { DESCRIBE_SCHEMA, dropRestated, fallbackLines, llmDescriber, validateLines, type DescribeItem } from "../src/describe";
import type { Notice } from "../src/naarad";

const notice: Notice = {
  ntfyId: "m1", noticeId: "1274", type: "PLACEMENT", subject: "PPT/Workshop/Seminars etc", company: "CAPITAL ONE",
  body: "PPT on 30th October from 11:55 AM.\nLink: https://capitalone.zoom.us/j/93026290652?pwd=abc.1\nMeeting ID: 930 2629 0652\nPasscode: 643657\nAttendance is compulsory.",
  postedAt: 0,
};

const item: DescribeItem = {
  ref: 0, company: "CAPITAL ONE", kind: "ppt", date: "2026-10-30", start: "11:55", end: null,
  venue: null, link: "https://capitalone.zoom.us/j/93026290652?pwd=abc.1", previous_details: [],
};

const ai = (lines: string[] | unknown) => ({
  calls: [] as { model: string; input: any }[],
  async run(model: string, input: unknown) {
    this.calls.push({ model, input });
    return { response: { entries: [{ ref: 0, lines }] } };
  },
});

describe("validateLines", () => {
  it("accepts tokens copied from the notice, including a spaced meeting ID", () => {
    expect(validateLines([
      "Zoom: https://capitalone.zoom.us/j/93026290652?pwd=abc.1",
      "Meeting ID: 930 2629 0652 · Passcode: 643657",
      "Attendance compulsory; join 15 min early",
    ], notice.body)).toBeNull();
  });

  it("accepts a meeting ID written without spaces", () => {
    expect(validateLines(["Meeting ID: 93026290652"], notice.body)).toBeNull();
  });

  it("rejects an altered link", () => {
    expect(validateLines(["Zoom: https://capitalone.zoom.us/j/93026290625"], notice.body)).toMatch(/link not in the notice/);
  });

  it("rejects an altered meeting ID or passcode", () => {
    expect(validateLines(["Meeting ID: 930 2629 0653"], notice.body)).toMatch(/number not in the notice/);
    expect(validateLines(["Passcode: 643675"], notice.body)).toMatch(/not in the notice/);
  });

  it("doesn't treat a link's own pwd= parameter as a separate passcode", () => {
    const wrapped = "Link: https://www.google.com/url?q=https%3A%2F%2Fcapitalone.zoom.us%2Fj%2F930%3Fpwd%3DOyJ.1%26jst%3D2&sa=D";
    expect(validateLines(["Zoom: https://capitalone.zoom.us/j/930?pwd=OyJ.1&jst=2"], wrapped)).toBeNull();
  });

  it("ignores times and short numbers", () => {
    expect(validateLines(["Join by 11:40, Room 121"], notice.body)).toBeNull();
  });
});

describe("dropRestated", () => {
  it("drops lines that only repeat the time", () => {
    expect(dropRestated(["Join at 5:00 PM", "Duration: 30 min", "Starts 17:00 sharp", "Room V-1"], { start: "17:00" }))
      .toEqual(["Room V-1"]);
  });

  it("keeps batch timings and joining instructions", () => {
    const lines = ["Batch A: 10:00 AM - 11:00 AM", "Join 15 min early", "Join with your institute email"];
    expect(dropRestated(lines, { start: "10:00" })).toEqual(lines);
  });
});

describe("fallbackLines", () => {
  it("keeps previous details and adds new venue and link", () => {
    expect(fallbackLines({ venue: "NR-121", link: "https://x.y", previous_details: ["Passcode: 1234"] }))
      .toEqual(["Passcode: 1234", "Venue: NR-121", "Link: https://x.y"]);
  });
});

describe("llmDescriber", () => {
  it("sends the notice and items with the schema", async () => {
    const runner = ai(["Join 15 min early"]);
    const res = await llmDescriber({ ai: runner, model: "@cf/m" })(notice, [item]);
    expect(res.lines.get(0)).toEqual(["Join 15 min early"]);
    expect(runner.calls[0]?.input.response_format).toEqual({ type: "json_schema", json_schema: DESCRIBE_SCHEMA });
    expect(JSON.parse(runner.calls[0]!.input.messages[1].content).events[0].ref).toBe(0);
  });

  it("falls back for an event whose lines don't match the notice", async () => {
    const res = await llmDescriber({ ai: ai(["Zoom: https://capitalone.zoom.us/j/11111111111"]), model: "m" })(notice, [item]);
    expect(res.rejected).toEqual([{ ref: 0, reason: expect.stringMatching(/link not in the notice/) }]);
    expect(res.lines.get(0)).toEqual(["Link: https://capitalone.zoom.us/j/93026290652?pwd=abc.1"]);
  });

  it("falls back when the model has nothing for an event", async () => {
    const res = await llmDescriber({ ai: ai([]), model: "m" })(notice, [item]);
    expect(res.lines.get(0)).toEqual(["Link: https://capitalone.zoom.us/j/93026290652?pwd=abc.1"]);
  });

  it("caps the number of lines", async () => {
    const res = await llmDescriber({ ai: ai(["a", "b", "c", "d", "e", "f", "g"]), model: "m" })(notice, [item]);
    expect(res.lines.get(0)).toHaveLength(5);
  });

  it("throws on a malformed response so the caller can fall back", async () => {
    const bad = { run: async () => ({ response: "{\"entr" }) };
    await expect(llmDescriber({ ai: bad, model: "m" })(notice, [item])).rejects.toThrow();
  });

  it("makes no call when there's nothing to describe", async () => {
    const runner = ai([]);
    await llmDescriber({ ai: runner, model: "m" })(notice, []);
    expect(runner.calls).toHaveLength(0);
  });
});
