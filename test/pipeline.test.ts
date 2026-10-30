import { describe, expect, it } from "vitest";
import type { DescribeItem, Describer } from "../src/describe";
import type { ExtractedEvent, ExtractInput } from "../src/extract";
import type { NtfyMessage } from "../src/naarad";
import { buildTiming, composeDescription, INITIAL_SINCE, MAX_ATTEMPTS, run, type Deps } from "../src/pipeline";
import { event, fakeCalendar, memoryStore, message, NOW } from "./helpers";

function setup(messages: NtfyMessage[], find: (input: ExtractInput) => ExtractedEvent[] | Promise<ExtractedEvent[]>) {
  const mem = memoryStore();
  const cal = fakeCalendar();
  const alerts: string[] = [];
  const errors: string[] = [];
  const polls: string[] = [];
  const inputs: ExtractInput[] = [];
  const described: DescribeItem[][] = [];
  // Step 2 stub: one line per event naming its company, like "Details for Google".
  const describe: Describer = async (_notice, items) => {
    described.push(items);
    return { lines: new Map(items.map((i) => [i.ref, [`Details for ${i.company}`]])), rejected: [] };
  };
  const deps: Deps = {
    store: mem.store,
    poll: async (since) => {
      polls.push(since);
      return messages.filter((m) => since === INITIAL_SINCE || m.id > since);
    },
    find: async (input) => {
      inputs.push(input);
      return find(input);
    },
    describe,
    calendar: cal.calendar,
    alert: async (title) => { alerts.push(title); },
    reportError: async (where, err) => { errors.push(`${where}: ${err instanceof Error ? err.message : err}`); },
    now: () => NOW,
    maxNotices: 10,
    log: () => {},
  };
  return { deps, mem, cal, alerts, errors, polls, inputs, described };
}

describe("buildTiming", () => {
  it("builds a timed IST event", () => {
    const t = buildTiming(event({}), NOW);
    expect(t).toMatchObject({ ok: true, startsAt: "2026-11-03T14:00", placeholder: false });
    if (!t.ok) throw new Error();
    expect(t.start).toMatchObject({ dateTime: "2026-11-03T14:00:00", timeZone: "Asia/Kolkata" });
    expect(t.end).toMatchObject({ dateTime: "2026-11-03T15:30:00" });
  });

  it("defaults to one hour when there's no end time", () => {
    const t = buildTiming(event({ start: "23:30", end: null }), NOW);
    if (!t.ok) throw new Error();
    expect(t.end).toMatchObject({ dateTime: "2026-11-04T00:30:00" });
  });

  it("makes an all-day placeholder when the time is missing or unsure", () => {
    expect(buildTiming(event({ start: null }), NOW)).toMatchObject({ ok: true, placeholder: true, startsAt: "2026-11-03" });
    const unsure = buildTiming(event({ confidence: "low" }), NOW);
    if (!unsure.ok) throw new Error();
    expect(unsure.start).toMatchObject({ date: "2026-11-03" });
    expect(unsure.end).toMatchObject({ date: "2026-11-04" });
  });

  it("skips events that already happened", () => {
    expect(buildTiming(event({ date: "2026-10-29", start: "09:00" }), NOW)).toEqual({ ok: false, reason: "past" });
    expect(buildTiming(event({ date: "2026-10-29", start: "18:00" }), NOW)).toMatchObject({ ok: true });
    expect(buildTiming(event({ date: null }), NOW)).toEqual({ ok: false, reason: "no-date" });
  });
});

describe("composeDescription", () => {
  const notice = { ntfyId: "m", noticeId: "42", type: "PLACEMENT", subject: "Schedule", company: "Google", body: "long notice text", postedAt: 0 };

  it("is the detail lines plus a footer, without the notice text", () => {
    const d = composeDescription(["Link: https://meet.google.com/abc", "Join 15 min early"], false, notice);
    expect(d).toBe("Link: https://meet.google.com/abc\nJoin 15 min early\n\nNotice #42 · Schedule");
    expect(d).not.toContain("long notice text");
  });

  it("leads with a warning for placeholders", () => {
    expect(composeDescription([], true, notice)).toMatch(/^⚠ The bot couldn't pin down the time/);
  });
});

describe("run", () => {
  it("skips out-of-scope subjects without calling the LLM", async () => {
    const msgs = [message(1, "Result", "Google"), message(2, "Shortlist", "Amazon")];
    const t = setup(msgs, () => { throw new Error("should not be called"); });
    const summary = await run(t.deps);
    expect(summary).toMatchObject({ seen: 2, skipped: 2, handled: 0 });
    expect(t.mem.state.cursor).toBe(msgs[1]!.id);
    expect(t.polls).toEqual([INITIAL_SINCE]);
  });

  it("skips internship notices on the shared topic", async () => {
    const m = message(5, "Schedule", "Google");
    m.title = m.title!.replace("PLACEMENT", "INTERNSHIP");
    const t = setup([m], () => { throw new Error("should not be called"); });
    expect(await run(t.deps)).toMatchObject({ skipped: 1, handled: 0 });
  });

  it("creates events with code-built titles and short descriptions", async () => {
    const msgs = [
      message(10, "Schedule", "GOOGLE INDIA PVT. LTD.", "very long notice body"),
      message(11, "PPT/Workshop/Seminars etc", "Amazon"),
    ];
    const t = setup(msgs, ({ notice }) =>
      notice.company === "Amazon" ? [event({ kind: "ppt", start: "18:00", end: null, link: "https://zoom.us/j/1" })] : [event({})],
    );
    const summary = await run(t.deps);
    expect(summary).toMatchObject({ handled: 2, created: 2 });
    expect(t.cal.inserted.map((e) => e.summary)).toEqual(["GOOGLE — Test", "Amazon — PPT"]);
    expect(t.cal.inserted[0]?.description).toBe("Details for GOOGLE INDIA PVT. LTD.\n\nNotice #10 · Schedule");
    expect(t.cal.inserted[1]?.location).toBe("https://zoom.us/j/1");
    expect(t.mem.events[0]?.details).toBe(JSON.stringify(["Details for GOOGLE INDIA PVT. LTD."]));
    expect(t.mem.notices.get("10")).toMatchObject({ status: "done", body: "very long notice body" });
  });

  it("describes all of a notice's events in one step-2 call", async () => {
    const t = setup([message(12, "Schedule", "CDC Placement Schedule")], () => [
      event({ company: "IXANA", qualifier: "Embedded" }),
      event({ company: "IXANA", qualifier: "IC Design", start: "20:00", end: "20:30" }),
    ]);
    await run(t.deps);
    expect(t.described).toHaveLength(1);
    expect(t.described[0]).toHaveLength(2);
    expect(t.cal.inserted.map((e) => e.summary)).toEqual(["IXANA — Test (Embedded)", "IXANA — Test (IC Design)"]);
  });

  it("falls back to plain details and reports when step 2 fails", async () => {
    const t = setup([message(13, "Schedule", "Google")], () => [event({ venue: "NR-121", link: "https://hackerrank.com/t" })]);
    t.deps.describe = async () => { throw new Error("AI down"); };
    await run(t.deps);
    expect(t.cal.inserted[0]?.description).toBe("Venue: NR-121\nLink: https://hackerrank.com/t\n\nNotice #13 · Schedule");
    expect(t.errors).toEqual(["description step for #13 Google (Schedule) failed, used plain details: AI down"]);
  });

  it("reports rejected step-2 lines", async () => {
    const t = setup([message(14, "Schedule", "Google")], () => [event({})]);
    t.deps.describe = async (_n, items) => ({
      lines: new Map(items.map((i) => [i.ref, ["Venue: TBA"]])),
      rejected: [{ ref: items[0]!.ref, reason: "link not in the notice: https://evil" }],
    });
    await run(t.deps);
    expect(t.errors).toEqual(["description for #14 Google (Schedule) looked wrong, used plain details: link not in the notice: https://evil"]);
  });

  it("patches the existing event on a reschedule and passes its details to step 2", async () => {
    const first = message(20, "Schedule", "Goldman Sachs (India) Pvt. Ltd.");
    const t = setup([first], () => [event({})]);
    await run(t.deps);

    const second = message(21, "Re-schedule", "Goldman Sachs");
    const t2Messages = [first, second];
    t.deps.poll = async (since) => t2Messages.filter((m) => m.id > since);
    t.deps.find = async (input) => {
      t.inputs.push(input);
      return [event({ action: "update", target_event_id: input.known[0]!.id, start: "16:00", end: null })];
    };
    const summary = await run(t.deps);

    expect(t.inputs.at(-1)?.known).toEqual([{ id: 1, kind: "test", title: "Goldman Sachs — Test", starts_at: "2026-11-03T14:00" }]);
    expect(t.described.at(-1)?.[0]?.previous_details).toEqual(["Details for Goldman Sachs (India) Pvt. Ltd."]);
    expect(summary).toMatchObject({ updated: 1, created: 0 });
    expect(t.cal.patches[0]).toMatchObject({ id: "gcal-1", event: { start: { dateTime: "2026-11-03T16:00:00" } } });
    expect(t.mem.events[0]?.starts_at).toBe("2026-11-03T16:00");
  });

  it("reads a follow-up notice for a company with an upcoming event, whatever its subject", async () => {
    const t = setup([message(100, "PPT/Workshop/Seminars etc", "Capital One")], () => [event({ kind: "ppt" })]);
    await run(t.deps);
    t.deps.poll = async () => [message(101, "Urgent", "CAPITAL ONE SERVICES INDIA PVT. LTD.")];
    t.deps.find = async (input) => {
      t.inputs.push(input);
      return [event({ action: "info", target_event_id: input.known[0]!.id, date: null, start: null, link: "https://zoom.us/j/9" })];
    };
    const summary = await run(t.deps);
    expect(t.inputs.at(-1)?.followUp).toBe(true);
    expect(summary).toMatchObject({ handled: 1, updated: 1, skipped: 0 });
    // info only touches the description and location, not the time or title
    expect(t.cal.patches[0]).toEqual({
      id: "gcal-1",
      event: { description: "Details for Capital One\n\nNotice #101 · Urgent", location: "https://zoom.us/j/9" },
    });
  });

  it("skips other subjects for companies without upcoming events", async () => {
    const t = setup([message(102, "Urgent", "Nobody Corp")], () => { throw new Error("should not be called"); });
    expect(await run(t.deps)).toMatchObject({ skipped: 1, handled: 0 });
  });

  it("doesn't alert 'no event found' for a follow-up with nothing new", async () => {
    const t = setup([message(103, "Schedule", "Google")], () => [event({})]);
    await run(t.deps);
    t.deps.poll = async () => [message(104, "Shortlist", "Google")];
    t.deps.find = async () => [];
    await run(t.deps);
    expect(t.alerts).toEqual([]);
  });

  it("shows a company's own notice the event a CDC schedule already created", async () => {
    const t = setup([message(90, "Schedule", "CDC Placement Schedule")], () => [event({ company: "CAPITAL ONE", kind: "ppt" })]);
    await run(t.deps);
    t.deps.poll = async () => [message(91, "PPT/Workshop/Seminars etc", "CAPITAL ONE SERVICES INDIA PVT. LTD.")];
    t.deps.find = async (input) => {
      t.inputs.push(input);
      return [];
    };
    await run(t.deps);
    expect(t.inputs.at(-1)?.known.map((k) => k.title)).toEqual(["CAPITAL ONE — PPT"]);
  });

  it("marks a cancelled event instead of deleting it", async () => {
    const t = setup([message(30, "Schedule", "Google")], () => [event({})]);
    await run(t.deps);
    const cancel = message(31, "Re-schedule", "Google");
    t.deps.poll = async () => [cancel];
    t.deps.find = async ({ known }) => [event({ action: "cancel", target_event_id: known[0]!.id })];
    const summary = await run(t.deps);
    expect(summary.cancelled).toBe(1);
    expect(t.cal.patches[0]).toEqual({ id: "gcal-1", event: { summary: "[CANCELLED] Google — Test", transparency: "transparent" } });
    expect(t.mem.events[0]?.status).toBe("cancelled");
  });

  it("alerts when the time is unclear", async () => {
    const t = setup([message(40, "Schedule", "Google")], () => [event({ start: null })]);
    await run(t.deps);
    expect(t.cal.inserted[0]?.summary).toBe("⚠ Google — Test (time TBA)");
    expect(t.alerts).toEqual(["Check time: Google"]);
  });

  it("alerts when a schedule has no event in it", async () => {
    const t = setup([message(41, "Schedule", "Google")], () => []);
    await run(t.deps);
    expect(t.alerts).toEqual(["No event found: Google"]);
  });

  it("keeps the cursor on a failed notice and retries it next run", async () => {
    const msgs = [message(50, "Schedule", "Google"), message(51, "Schedule", "Amazon")];
    const t = setup(msgs, () => [event({})]);
    t.cal.failInserts(1);

    const first = await run(t.deps);
    expect(first).toMatchObject({ created: 0, more: true });
    expect(t.mem.state.cursor).toBeNull();
    expect(t.mem.notices.get("50")).toMatchObject({ status: "pending", attempts: 1 });
    expect(t.errors).toEqual(["#50 Google (attempt 1 of 3, retrying in 5 min): calendar down"]);

    const second = await run(t.deps);
    expect(second).toMatchObject({ created: 2, more: false });
    expect(t.mem.notices.get("50")).toMatchObject({ status: "done", attempts: 2 });
    expect(t.mem.state.cursor).toBe(msgs[1]!.id);
  });

  it("doesn't duplicate events when a multi-event notice is retried", async () => {
    const t = setup([message(55, "Schedule", "Google")], () => [event({}), event({ kind: "interview", date: "2026-11-04" })]);
    let calls = 0;
    const insert = t.cal.calendar.insert;
    t.cal.calendar.insert = async (ev) => {
      if (++calls === 2) throw new Error("flaky");
      return insert(ev);
    };
    await run(t.deps);
    await run(t.deps);
    expect(t.cal.inserted.map((e) => e.summary)).toEqual(["Google — Test", "Google — Interview"]);
  });

  it(`gives up after ${MAX_ATTEMPTS} attempts, alerts, and moves on`, async () => {
    const msgs = [message(60, "Schedule", "Google"), message(61, "Schedule", "Amazon")];
    const t = setup(msgs, ({ notice }) => {
      if (notice.company === "Google") throw new Error("LLM exploded");
      return [event({})];
    });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await run(t.deps);
    expect(t.mem.notices.get("60")).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(t.alerts).toEqual(["Bot gave up: Google"]);
    expect(t.cal.inserted.map((e) => e.summary)).toEqual(["Amazon — Test"]);
  });

  it("ignores notices it has already handled", async () => {
    const m = message(70, "Schedule", "Google");
    const t = setup([m], () => [event({})]);
    await run(t.deps);
    t.deps.poll = async () => [{ ...m, id: "zzzz" }]; // ntfy redelivered the same notice
    const summary = await run(t.deps);
    expect(summary.handled).toBe(0);
    expect(t.cal.inserted).toHaveLength(1);
  });

  it("stops at the per-run budget and continues next run", async () => {
    const msgs = [message(80, "Schedule", "A"), message(81, "Schedule", "B"), message(82, "Schedule", "C")];
    const t = setup(msgs, () => [event({})]);
    t.deps.maxNotices = 2;
    expect(await run(t.deps)).toMatchObject({ handled: 2, more: true });
    expect(await run(t.deps)).toMatchObject({ handled: 1, more: false });
    expect(t.cal.inserted).toHaveLength(3);
  });
});
