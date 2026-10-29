import { describe, expect, it } from "vitest";
import type { ExtractedEvent, ExtractInput } from "../src/extract";
import type { NtfyMessage } from "../src/naarad";
import { buildEvent, INITIAL_SINCE, MAX_ATTEMPTS, run, type Deps } from "../src/pipeline";
import { event, fakeCalendar, memoryStore, message, NOW } from "./helpers";

function setup(messages: NtfyMessage[], extract: (input: ExtractInput) => ExtractedEvent[] | Promise<ExtractedEvent[]>) {
  const mem = memoryStore();
  const cal = fakeCalendar();
  const alerts: string[] = [];
  const polls: string[] = [];
  const inputs: ExtractInput[] = [];
  const deps: Deps = {
    store: mem.store,
    poll: async (since) => {
      polls.push(since);
      return messages.filter((m) => since === INITIAL_SINCE || m.id > since);
    },
    extract: async (input) => {
      inputs.push(input);
      return extract(input);
    },
    calendar: cal.calendar,
    alert: async (title) => { alerts.push(title); },
    now: () => NOW,
    maxNotices: 10,
    log: () => {},
  };
  return { deps, mem, cal, alerts, polls, inputs };
}

describe("buildEvent", () => {
  const notice = { ntfyId: "m", noticeId: "42", type: "PLACEMENT", subject: "Schedule", company: "Google", body: "Test details", postedAt: 0 };

  it("builds a timed IST event with the company first", () => {
    const built = buildEvent(notice, event({ venue: "Nalanda", link: "https://meet" }), NOW);
    expect(built).toMatchObject({ ok: true, title: "Google — Online Test", startsAt: "2026-11-03T14:00", placeholder: false });
    if (!built.ok) throw new Error();
    expect(built.event.start).toMatchObject({ dateTime: "2026-11-03T14:00:00", timeZone: "Asia/Kolkata" });
    expect(built.event.end).toMatchObject({ dateTime: "2026-11-03T15:30:00" });
    expect(built.event.location).toBe("Nalanda");
    expect(built.event.description).toContain("Link: https://meet");
    expect(built.event.description).toContain("Notice #42");
  });

  it("defaults to one hour when there's no end time", () => {
    const built = buildEvent(notice, event({ start: "23:30", end: null }), NOW);
    if (!built.ok) throw new Error();
    expect(built.event.end).toMatchObject({ dateTime: "2026-11-04T00:30:00" });
  });

  it("makes an all-day placeholder when the time is missing or unsure", () => {
    expect(buildEvent(notice, event({ start: null }), NOW)).toMatchObject({ ok: true, placeholder: true, title: "⚠ Google — Online Test (time TBA)" });
    const unsure = buildEvent(notice, event({ confidence: "low" }), NOW);
    expect(unsure).toMatchObject({ placeholder: true, title: "⚠ Google — Online Test (14:00? check)" });
    if (!unsure.ok) throw new Error();
    expect(unsure.event.start).toMatchObject({ date: "2026-11-03" });
    expect(unsure.event.end).toMatchObject({ date: "2026-11-04" });
  });

  it("skips events that already happened", () => {
    expect(buildEvent(notice, event({ date: "2026-10-29", start: "09:00" }), NOW)).toEqual({ ok: false, reason: "past" });
    expect(buildEvent(notice, event({ date: "2026-10-29", start: "18:00" }), NOW)).toMatchObject({ ok: true });
    expect(buildEvent(notice, event({ date: null }), NOW)).toEqual({ ok: false, reason: "no-date" });
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

  it("creates events for schedules and PPTs", async () => {
    const msgs = [message(10, "Schedule", "Google"), message(11, "PPT/Workshop/Seminars etc", "Amazon")];
    const t = setup(msgs, ({ notice }) =>
      notice.company === "Google" ? [event({})] : [event({ kind: "ppt", title_hint: "Pre-Placement Talk", start: "18:00", end: null })],
    );
    const summary = await run(t.deps);
    expect(summary).toMatchObject({ handled: 2, created: 2 });
    expect(t.cal.inserted.map((e) => e.summary)).toEqual(["Google — Online Test", "Amazon — Pre-Placement Talk"]);
    expect(t.mem.notices.get("10")?.status).toBe("done");
  });

  it("patches the existing event on a reschedule", async () => {
    const first = message(20, "Schedule", "Goldman Sachs (India) Pvt. Ltd.");
    const t = setup([first], () => [event({})]);
    await run(t.deps);

    const second = message(21, "Re-schedule", "Goldman Sachs");
    const t2Messages = [first, second];
    t.deps.poll = async (since) => t2Messages.filter((m) => m.id > since);
    t.deps.extract = async (input) => {
      t.inputs.push(input);
      return [event({ action: "update", target_event_id: input.known[0]!.id, start: "16:00", end: null })];
    };
    const summary = await run(t.deps);

    expect(t.inputs.at(-1)?.known).toEqual([{ id: 1, kind: "test", title: "Goldman Sachs (India) Pvt. Ltd. — Online Test", starts_at: "2026-11-03T14:00" }]);
    expect(summary).toMatchObject({ updated: 1, created: 0 });
    expect(t.cal.patches[0]).toMatchObject({ id: "gcal-1", event: { start: { dateTime: "2026-11-03T16:00:00" } } });
    expect(t.mem.events[0]?.starts_at).toBe("2026-11-03T16:00");
  });

  it("marks a cancelled event instead of deleting it", async () => {
    const t = setup([message(30, "Schedule", "Google")], () => [event({})]);
    await run(t.deps);
    const cancel = message(31, "Re-schedule", "Google");
    t.deps.poll = async () => [cancel];
    t.deps.extract = async ({ known }) => [event({ action: "cancel", target_event_id: known[0]!.id })];
    const summary = await run(t.deps);
    expect(summary.cancelled).toBe(1);
    expect(t.cal.patches[0]).toEqual({ id: "gcal-1", event: { summary: "[CANCELLED] Google — Online Test", transparency: "transparent" } });
    expect(t.mem.events[0]?.status).toBe("cancelled");
  });

  it("alerts when the time is unclear", async () => {
    const t = setup([message(40, "Schedule", "Google")], () => [event({ start: null })]);
    await run(t.deps);
    expect(t.cal.inserted[0]?.summary).toBe("⚠ Google — Online Test (time TBA)");
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

    const second = await run(t.deps);
    expect(second).toMatchObject({ created: 2, more: false });
    expect(t.mem.notices.get("50")).toMatchObject({ status: "done", attempts: 2 });
    expect(t.mem.state.cursor).toBe(msgs[1]!.id);
  });

  it("doesn't duplicate events when a multi-event notice is retried", async () => {
    const t = setup([message(55, "Schedule", "Google")], () => [event({}), event({ title_hint: "Interview", kind: "interview", date: "2026-11-04" })]);
    let calls = 0;
    const insert = t.cal.calendar.insert;
    t.cal.calendar.insert = async (ev) => {
      if (++calls === 2) throw new Error("flaky");
      return insert(ev);
    };
    await run(t.deps);
    await run(t.deps);
    expect(t.cal.inserted.map((e) => e.summary)).toEqual(["Google — Online Test", "Google — Interview"]);
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
    expect(t.cal.inserted.map((e) => e.summary)).toEqual(["Amazon — Online Test"]);
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
