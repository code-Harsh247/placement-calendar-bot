// Runs the real models (step 1: find events, step 2: write descriptions) against notices,
// outside the Worker.
//
//   npm run eval                 scored test cases from eval/cases/*.json
//   npm run eval -- reschedule   only cases whose file name contains "reschedule"
//   npm run eval:live            every in-scope notice Naarad still has cached, printed for review
//
// Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (and NAARAD_USER / NAARAD_PASS for
// live mode) from .dev.vars.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { llmDescriber, type DescribeItem, type Describer } from "../src/describe";
import { llmExtractor, type AiRunner, type ExtractedEvent, type KnownEvent } from "../src/extract";
import { IN_SCOPE_SUBJECTS, IN_SCOPE_TYPES, parseTitle, pollNaarad, toNotice, type Notice } from "../src/naarad";
import { eventTitle } from "../src/title";

const wranglerConfig = readFileSync("wrangler.jsonc", "utf8");
const configVar = (name: string, fallback: string) =>
  new RegExp(`"${name}":\\s*"([^"]+)"`).exec(wranglerConfig)?.[1] ?? fallback;
const WORKERS_AI_MODEL = configVar("WORKERS_AI_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
const NAARAD_URL = configVar("NAARAD_URL", "https://naarad.metakgp.org");
const TOPIC = configVar("TOPIC", "kgp-mftp");
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 500);

function loadDevVars(): Record<string, string> {
  let text = "";
  try {
    text = readFileSync(".dev.vars", "utf8");
  } catch {
    throw new Error("No .dev.vars file. Copy .dev.vars.example to .dev.vars and fill in the CLOUDFLARE_ lines.");
  }
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return { ...vars, ...process.env } as Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The Worker's `AI` binding, reimplemented over Cloudflare's REST API so the eval
// runs the same model outside the Worker. Needs a token with Workers AI access.
function workersAiRest(vars: Record<string, string>): AiRunner {
  const account = vars.CLOUDFLARE_ACCOUNT_ID;
  const token = vars.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .dev.vars");
  return {
    async run(model, input) {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await res.json()) as { success?: boolean; result?: unknown; errors?: { message: string }[] };
      if (!res.ok || !body.success) {
        throw new Error(`Workers AI HTTP ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "unknown error"}`);
      }
      return body.result;
    },
  };
}

function makeModels(vars: Record<string, string>) {
  const ai = { ai: workersAiRest(vars), model: WORKERS_AI_MODEL };
  return { find: llmExtractor(ai), describe: llmDescriber(ai), label: `Workers AI ${WORKERS_AI_MODEL}` };
}

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const isPlaceholder = (ev: ExtractedEvent) => !ev.start || ev.confidence === "low";
const titleOf = (ev: ExtractedEvent, notice: Notice) =>
  eventTitle(ev.company ?? notice.company, ev.kind, ev.qualifier, isPlaceholder(ev));

function summarize(ev: ExtractedEvent, notice: Notice): string {
  const when = ev.date ? `${ev.date} ${ev.start ?? "--:--"}${ev.end ? `–${ev.end}` : ""}` : "no date";
  const target = ev.target_event_id !== null ? ` → #${ev.target_event_id}` : "";
  const name = ev.action === "info" || ev.action === "cancel" ? "" : titleOf(ev, notice);
  const low = ev.confidence === "low" && ev.action !== "info" && ev.action !== "cancel";
  return `${ev.action}${target}  ${when.padEnd(23)} ${name}` + (low ? c.yellow("  (low confidence)") : "");
}

const showLines = (lines: string[] | undefined) => (lines ?? []).map((l) => c.dim(`      │ ${l}`)).join("\n");

// Runs step 2 on the events of one notice, the way the pipeline does.
async function describeAll(
  describe: Describer,
  notice: Notice,
  events: ExtractedEvent[],
  previous: (ev: ExtractedEvent) => string[],
): Promise<{ lines: Map<number, string[]>; rejected: Map<number, string> }> {
  const items: DescribeItem[] = events.flatMap((ev, ref) =>
    ev.action === "cancel"
      ? []
      : [{
          ref, company: ev.company ?? notice.company, kind: ev.kind, date: ev.date, start: ev.start, end: ev.end,
          venue: ev.venue, link: ev.link, previous_details: previous(ev),
        }],
  );
  const res = await describe(notice, items);
  return { lines: res.lines, rejected: new Map(res.rejected.map((r) => [r.ref, r.reason])) };
}

// ---------- scored cases ----------

interface Expected {
  action?: ExtractedEvent["action"];
  target_event_id?: number | null;
  kind?: ExtractedEvent["kind"];
  company?: string; // case-insensitive substring of the event's company (or the notice's)
  date?: string | null;
  start?: string | null;
  end?: string | null;
  confidence?: "high" | "low";
  // Checks on the calendar entry: the title (built by code) and the description (step 2).
  title?: string;
  details_contain?: string[];
  details_exclude?: string[]; // case-insensitive; catches invented instructions
  details_max_lines?: number;
}

interface Case {
  name: string;
  title: string;
  posted_at: string; // ISO with offset, e.g. 2026-10-27T12:11:00+05:30
  body: string;
  known?: (KnownEvent & { details?: string[] })[];
  expect: Expected[];
  exact?: boolean; // fail on extra events (default true)
}

function matches(exp: Expected, ev: ExtractedEvent, notice: Notice): string[] {
  const diffs: string[] = [];
  const action = exp.action ?? "create";
  if (ev.action !== action) diffs.push(`action ${ev.action} ≠ ${action}`);
  for (const key of ["target_event_id", "kind", "date", "start", "end", "confidence"] as const) {
    if (exp[key] !== undefined && ev[key] !== exp[key]) diffs.push(`${key} ${ev[key]} ≠ ${exp[key]}`);
  }
  if (exp.company && !(ev.company ?? notice.company).toLowerCase().includes(exp.company.toLowerCase())) {
    diffs.push(`company ${ev.company ?? notice.company} ≠ ${exp.company}`);
  }
  return diffs;
}

function entryProblems(exp: Expected, ev: ExtractedEvent, notice: Notice, lines: string[], rejected?: string): string[] {
  const problems: string[] = [];
  const title = titleOf(ev, notice);
  if (exp.title !== undefined && title !== exp.title) problems.push(`title "${title}" ≠ "${exp.title}"`);
  const text = lines.join("\n");
  for (const s of exp.details_contain ?? []) if (!text.includes(s)) problems.push(`details missing "${s}"`);
  for (const s of exp.details_exclude ?? []) {
    if (text.toLowerCase().includes(s.toLowerCase())) problems.push(`details shouldn't say "${s}"`);
  }
  if (exp.details_max_lines !== undefined && lines.length > exp.details_max_lines) {
    problems.push(`${lines.length} detail lines > ${exp.details_max_lines}`);
  }
  if (rejected) problems.push(`step 2 output rejected (${rejected})`);
  return problems;
}

function describeExpected(exp: Expected): string {
  return Object.entries({ action: "create", ...exp })
    .map(([k, v]) => `${k}=${Array.isArray(v) ? JSON.stringify(v) : v}`)
    .join(" ");
}

async function runCases(filter: string | undefined, vars: Record<string, string>): Promise<boolean> {
  const { find, describe, label } = makeModels(vars);
  console.log(c.dim(`Model: ${label}`));
  const dir = "eval/cases";
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && (!filter || f.includes(filter))).sort();
  let passed = 0;
  let checks = 0;
  let checksPassed = 0;

  for (const [i, file] of files.entries()) {
    if (i > 0) await sleep(DELAY_MS);
    const tc = JSON.parse(readFileSync(join(dir, file), "utf8")) as Case;
    const parsed = parseTitle(tc.title);
    if (!parsed) throw new Error(`${file}: title isn't in MFTP format`);
    const notice: Notice = { ...parsed, ntfyId: file, body: tc.body, postedAt: Date.parse(tc.posted_at) / 1000 };
    const known = (tc.known ?? []).map(({ details: _details, ...k }) => k);
    const followUp = !IN_SCOPE_SUBJECTS.has(notice.subject);

    console.log(`\n${c.bold(tc.name)} ${c.dim(`(${file})`)}`);
    let events: ExtractedEvent[];
    let described: Awaited<ReturnType<typeof describeAll>>;
    try {
      events = await find({ notice, known, followUp });
      described = await describeAll(describe, notice, events, (ev) =>
        tc.known?.find((k) => k.id === ev.target_event_id)?.details ?? []);
    } catch (err) {
      console.log(c.red(`  ✗ failed: ${err instanceof Error ? err.message : err}`));
      checks += tc.expect.length;
      continue;
    }

    const unused = new Set(events.map((_, idx) => idx));
    let ok = true;
    for (const exp of tc.expect) {
      checks++;
      // Pick the unused event closest to what's expected.
      let best: { idx: number; diffs: string[] } | null = null;
      for (const idx of unused) {
        const diffs = matches(exp, events[idx]!, notice);
        if (!best || diffs.length < best.diffs.length) best = { idx, diffs };
      }
      if (!best || best.diffs.length > 0) {
        ok = false;
        console.log(c.red(`  ✗ expected ${describeExpected(exp)}`));
        if (best) console.log(c.red(`      closest: ${best.diffs.join(", ")}`));
        continue;
      }
      unused.delete(best.idx);
      const ev = events[best.idx]!;
      const lines = described.lines.get(best.idx) ?? [];
      const problems = entryProblems(exp, ev, notice, lines, described.rejected.get(best.idx));
      if (problems.length === 0) {
        checksPassed++;
        console.log(c.green(`  ✓ ${summarize(ev, notice)}`));
      } else {
        ok = false;
        console.log(c.red(`  ✗ ${summarize(ev, notice)}`));
        console.log(c.red(`      ${problems.join("; ")}`));
      }
      if (lines.length) console.log(showLines(lines));
    }
    if (tc.exact !== false && unused.size > 0) {
      ok = false;
      for (const idx of unused) console.log(c.red(`  ✗ unexpected: ${summarize(events[idx]!, notice)}`));
    }
    if (ok) passed++;
  }

  console.log(`\n${c.bold(`${passed}/${files.length} cases passed`)} (${checksPassed}/${checks} expected events correct) · ${label}`);
  return passed === files.length;
}

// ---------- live notices ----------

async function runLive(vars: Record<string, string>): Promise<void> {
  for (const key of ["NAARAD_USER", "NAARAD_PASS"]) {
    if (!vars[key]) throw new Error(`${key} is missing from .dev.vars`);
  }
  const { find, describe, label } = makeModels(vars);
  console.log(c.dim(`Model: ${label}`));
  const messages = await pollNaarad({ url: NAARAD_URL, topic: TOPIC, user: vars.NAARAD_USER!, pass: vars.NAARAD_PASS! }, "all");
  const notices = messages.map(toNotice).filter((n): n is Notice => n !== null);
  const inScope = notices.filter((n) => IN_SCOPE_TYPES.has(n.type) && IN_SCOPE_SUBJECTS.has(n.subject));

  const skipped = new Map<string, number>();
  for (const n of notices) {
    if (!inScope.includes(n)) skipped.set(`${n.type} / ${n.subject}`, (skipped.get(`${n.type} / ${n.subject}`) ?? 0) + 1);
  }
  console.log(`${notices.length} notices cached on ${TOPIC}; ${inScope.length} in scope.`);
  console.log(c.dim(`Skipped by title (follow-ups for known companies aren't simulated here): ${[...skipped].map(([k, v]) => `${k} ×${v}`).join(", ") || "none"}`));

  const results: unknown[] = [];
  for (const [i, notice] of inScope.entries()) {
    if (i > 0) await sleep(DELAY_MS);
    console.log(`\n${c.bold(`#${notice.noticeId} ${notice.company}`)} ${c.dim(`(${notice.subject}, posted ${new Date(notice.postedAt * 1000).toISOString()})`)}`);
    console.log(c.dim(notice.body.split("\n").map((l) => `  │ ${l}`).join("\n")));
    try {
      const events = await find({ notice, known: [] });
      const { lines, rejected } = await describeAll(describe, notice, events, () => []);
      if (events.length === 0) console.log(c.yellow("  → no events"));
      for (const [ref, ev] of events.entries()) {
        const why = rejected.get(ref);
        console.log(`  → ${summarize(ev, notice)}${why ? c.red(`  (step 2 rejected: ${why})`) : ""}`);
        if (lines.get(ref)?.length) console.log(showLines(lines.get(ref)));
      }
      results.push({ notice, events, details: Object.fromEntries(lines) });
    } catch (err) {
      console.log(c.red(`  ✗ failed: ${err instanceof Error ? err.message : err}`));
      results.push({ notice, error: String(err) });
    }
  }

  mkdirSync("eval/out", { recursive: true });
  const out = `eval/out/live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nSaved to ${out}. Turn any notice that came out wrong into a case in eval/cases/.`);
}

const vars = loadDevVars();
const args = process.argv.slice(2);
const arg = args.find((a) => !a.startsWith("--"));
if (arg === "live") {
  await runLive(vars);
} else {
  const ok = await runCases(arg, vars);
  process.exitCode = ok ? 0 : 1;
}
