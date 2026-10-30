// Calendar titles are built by code, not the LLM, so they look the same every time:
// "CAPITAL ONE — PPT", "IXANA — Test (IC Design)", "⚠ ZANSKAR — PPT (time TBA)".

import type { Kind } from "./extract";

export const KIND_LABELS: Record<Kind, string> = {
  test: "Test",
  interview: "Interview",
  gd: "GD",
  ppt: "PPT",
  other: "Event",
};

const SUFFIX = /[\s,.]+(pvt|private|ltd|limited|llp|inc|llc|corp|corporation|co|india|services)\.?$/i;

// "CAPITAL ONE SERVICES INDIA PVT. LTD." → "CAPITAL ONE". Casing is kept as written.
export function cleanCompany(name: string): string {
  let out = name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim().replace(/[.,]+$/, "");
  for (let prev = ""; prev !== out; ) {
    prev = out;
    const stripped = out.replace(SUFFIX, "").trim();
    if (stripped) out = stripped; // never strip a name down to nothing
  }
  return out;
}

export function eventTitle(company: string, kind: Kind, qualifier: string | null, placeholder: boolean): string {
  const base = `${cleanCompany(company)} — ${KIND_LABELS[kind]}${qualifier ? ` (${qualifier})` : ""}`;
  return placeholder ? `⚠ ${base} (time TBA)` : base;
}
