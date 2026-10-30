import { describe, expect, it } from "vitest";
import { cleanCompany, eventTitle } from "../src/title";

describe("cleanCompany", () => {
  it.each([
    ["CAPITAL ONE SERVICES INDIA PVT. LTD.", "CAPITAL ONE"],
    ["PLUTUS RESEARCH PRIVATE LIMITED", "PLUTUS RESEARCH"],
    ["Goldman Sachs (India) Pvt. Ltd.", "Goldman Sachs"],
    ["TEXAS INSTRUMENTS", "TEXAS INSTRUMENTS"],
    ["DELOITTE USI", "DELOITTE USI"],
    ["QI-CAP", "QI-CAP"],
    ["Acme Inc.", "Acme"],
  ])("%s → %s", (input, expected) => {
    expect(cleanCompany(input)).toBe(expected);
  });

  it("never strips a name to nothing", () => {
    expect(cleanCompany("Services")).toBe("Services");
  });
});

describe("eventTitle", () => {
  it("is company, type and an optional qualifier", () => {
    expect(eventTitle("CAPITAL ONE SERVICES INDIA PVT. LTD.", "ppt", null, false)).toBe("CAPITAL ONE — PPT");
    expect(eventTitle("IXANA", "test", "IC Design", false)).toBe("IXANA — Test (IC Design)");
    expect(eventTitle("SEDEMAC", "gd", null, false)).toBe("SEDEMAC — GD");
  });

  it("marks placeholders", () => {
    expect(eventTitle("ZANSKAR", "ppt", null, true)).toBe("⚠ ZANSKAR — PPT (time TBA)");
  });
});
