import { ntfyAlert, type Alert } from "./alert";
import { googleCalendar, type Calendar } from "./calendar";
import { llmExtractor } from "./extract";
import { pollNaarad } from "./naarad";
import { run, type RunSummary } from "./pipeline";
import { d1Store, type Store } from "./store";

export interface Env {
  DB: D1Database;
  AI: Ai;
  NAARAD_URL: string;
  TOPIC: string;
  GEMINI_MODEL: string;
  WORKERS_AI_MODEL: string;
  MAX_NOTICES_PER_RUN: string;
  DRY_RUN: string;
  // secrets
  NAARAD_USER: string;
  NAARAD_PASS: string;
  GEMINI_API_KEY: string;
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

async function runOnce(env: Env): Promise<RunSummary> {
  const dryRun = env.DRY_RUN === "true";
  const store = d1Store(env.DB);
  const alert: Alert =
    env.ALERT_TOPIC && !dryRun
      ? ntfyAlert(env.ALERT_TOPIC)
      : async (title, message) => log(`[alert] ${title}: ${message}`);

  const summary = await run({
    store: dryRun ? readOnly(store) : store,
    poll: (since) =>
      pollNaarad({ url: env.NAARAD_URL, topic: env.TOPIC, user: env.NAARAD_USER, pass: env.NAARAD_PASS }, since),
    extract: llmExtractor({
      geminiApiKey: env.GEMINI_API_KEY,
      geminiModel: env.GEMINI_MODEL,
      ai: env.AI,
      workersAiModel: env.WORKERS_AI_MODEL,
      log,
    }),
    calendar: dryRun
      ? loggingCalendar
      : googleCalendar({ email: env.GOOGLE_SA_EMAIL, privateKeyPem: env.GOOGLE_SA_KEY, calendarId: env.CALENDAR_ID }),
    alert,
    now: () => new Date(),
    maxNotices: Number(env.MAX_NOTICES_PER_RUN) || 10,
    log,
  });
  log(`run${dryRun ? " (dry run)" : ""}: ${JSON.stringify(summary)}`);
  return summary;
}

export default {
  async scheduled(_controller, env) {
    try {
      await runOnce(env);
    } catch (err) {
      // Naarad or D1 being down: log it and try again on the next cron tick.
      console.error(`run failed: ${err instanceof Error ? err.stack : err}`);
    }
  },

  // POST /run with `Authorization: Bearer <RUN_TOKEN>` triggers a run by hand.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/run") return new Response("Not found", { status: 404 });
    if (!env.RUN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.RUN_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      return Response.json(await runOnce(env));
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
