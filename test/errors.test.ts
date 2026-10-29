import { describe, expect, it } from "vitest";
import { ERROR_COOLDOWN_MS, errorReporter } from "../src/errors";
import { memoryStore } from "./helpers";

function setup(start = Date.parse("2026-10-30T00:00:00Z")) {
  const { store } = memoryStore();
  const sent: { title: string; message: string }[] = [];
  let now = start;
  const report = errorReporter(store, async (title, message) => { sent.push({ title, message }); }, () => {}, () => new Date(now));
  return { report, sent, store, advance: (ms: number) => { now += ms; } };
}

describe("errorReporter", () => {
  it("sends the error to the alert topic", async () => {
    const t = setup();
    await t.report("run failed", new Error("Naarad poll failed: HTTP 502"));
    expect(t.sent).toEqual([{ title: "Bot error: run failed", message: "Naarad poll failed: HTTP 502" }]);
  });

  it("sends a repeated error at most once an hour", async () => {
    const t = setup();
    await t.report("run failed", new Error("HTTP 502"));
    t.advance(5 * 60_000);
    await t.report("run failed", new Error("HTTP 502"));
    expect(t.sent).toHaveLength(1);
    t.advance(ERROR_COOLDOWN_MS);
    await t.report("run failed", new Error("HTTP 502"));
    expect(t.sent).toHaveLength(2);
  });

  it("sends a different error right away", async () => {
    const t = setup();
    await t.report("run failed", new Error("HTTP 502"));
    await t.report("#1 Google", new Error("Calendar POST failed: HTTP 403"));
    expect(t.sent.map((s) => s.message)).toEqual(["HTTP 502", "Calendar POST failed: HTTP 403"]);
  });

  it("still alerts when the database is what's failing", async () => {
    const t = setup();
    t.store.getState = async () => { throw new Error("D1 unavailable"); };
    t.store.setState = async () => { throw new Error("D1 unavailable"); };
    await t.report("run failed", new Error("D1 unavailable"));
    expect(t.sent).toHaveLength(1);
  });

  it("doesn't throw if ntfy itself is down", async () => {
    const { store } = memoryStore();
    const report = errorReporter(store, async () => { throw new Error("ntfy down"); }, () => {});
    await expect(report("run failed", new Error("x"))).resolves.toBeUndefined();
  });
});
