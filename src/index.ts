import { ntfyAlert, type Alert } from "./alert";
import { googleCalendar, type Calendar } from "./calendar";
import { errorMessage, errorReporter } from "./errors";
import { llmDescriber } from "./describe";
import { llmExtractor } from "./extract";
import { pollNaarad } from "./naarad";
import { run, type RunSummary } from "./pipeline";
import { rewriteDescriptions, type RewriteSummary } from "./rewrite";
import { d1Store, type Store } from "./store";

export interface Env {
  DB: D1Database;
  AI: Ai;
  NAARAD_URL: string;
  TOPIC: string;
  WORKERS_AI_MODEL: string;
  MAX_NOTICES_PER_RUN: string;
  DRY_RUN: string;
  // secrets
  NAARAD_USER: string;
  NAARAD_PASS: string;
  GOOGLE_SA_EMAIL: string;
  GOOGLE_SA_KEY: string;
  CALENDAR_ID: string;
  ALERT_TOPIC?: string;
  RUN_TOKEN?: string;
}

const log = (msg: string) => console.log(msg);

// Dry run: reads go to D1, writes are dropped, so a later real run starts from scratch.
function readOnly(store: Store): Store {
  let fakeId = 0;
  return {
    ...store,
    async setCursor() {},
    async saveNotice() {},
    async addEvent(e) {
      log(`[dry-run] would record event "${e.title}"`);
      return --fakeId;
    },
    async updateEvent(id, fields) {
      log(`[dry-run] would update event ${id}: ${JSON.stringify(fields)}`);
    },
  };
}

const loggingCalendar: Calendar = {
  async insert(event) {
    log(`[dry-run] would create: ${event.summary} @ ${JSON.stringify(event.start)} | ${event.location ?? "-"}`);
    return "dry-run";
  },
  async patch(id, event) {
    log(`[dry-run] would patch ${id}: ${event.summary ?? ""} ${event.start ? JSON.stringify(event.start) : ""}`);
  },
};

function setup(env: Env) {
  const dryRun = env.DRY_RUN === "true";
  const d1 = d1Store(env.DB);
  const alert: Alert =
    env.ALERT_TOPIC && !dryRun
      ? ntfyAlert(env.ALERT_TOPIC)
      : async (title, message) => log(`[alert] ${title}: ${message}`);
  const reportError = errorReporter(d1, alert, log);
  const ai = { ai: env.AI, model: env.WORKERS_AI_MODEL };
  return {
    dryRun,
    store: dryRun ? readOnly(d1) : d1,
    alert,
    reportError,
    find: llmExtractor(ai),
    describe: llmDescriber(ai),
    calendar: dryRun
      ? loggingCalendar
      : googleCalendar({ email: env.GOOGLE_SA_EMAIL, privateKeyPem: env.GOOGLE_SA_KEY, calendarId: env.CALENDAR_ID }),
    poll: (since: string) =>
      pollNaarad({ url: env.NAARAD_URL, topic: env.TOPIC, user: env.NAARAD_USER, pass: env.NAARAD_PASS }, since),
    now: () => new Date(),
  };
}

// Anything that fails the whole run (Naarad down, bad credentials, D1 errors) is alerted
// and retried on the next cron tick.
async function guardedRun(env: Env): Promise<RunSummary | { error: string }> {
  const ctx = setup(env);
  try {
    const summary = await run({ ...ctx, maxNotices: Number(env.MAX_NOTICES_PER_RUN) || 10, log });
    log(`run${ctx.dryRun ? " (dry run)" : ""}: ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    console.error(`run failed: ${err instanceof Error ? err.stack : err}`);
    await ctx.reportError("run failed, retrying in 5 min", err);
    return { error: errorMessage(err) };
  }
}

async function guardedRewrite(env: Env): Promise<RewriteSummary | { error: string }> {
  const ctx = setup(env);
  try {
    const summary = await rewriteDescriptions({ ...ctx, log });
    log(`rewrite: ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    await ctx.reportError("description rewrite failed", err);
    return { error: errorMessage(err) };
  }
}

export default {
  async scheduled(_controller, env) {
    await guardedRun(env);
  },

  // With `Authorization: Bearer <RUN_TOKEN>`:
  //   POST /run      runs the pipeline now
  //   POST /rewrite  regenerates the descriptions of upcoming events
  async fetch(request, env) {
    const url = new URL(request.url);
    const action = request.method === "POST" ? { "/run": guardedRun, "/rewrite": guardedRewrite }[url.pathname] : undefined;
    if (!action) return new Response("Not found", { status: 404 });
    if (!env.RUN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.RUN_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const result = await action(env);
    return Response.json(result, { status: "error" in result ? 500 : 200 });
  },
} satisfies ExportedHandler<Env>;
