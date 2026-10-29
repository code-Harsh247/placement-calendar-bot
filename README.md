# placement-calendar-bot

Turns placement notices from [Naarad](https://github.com/metakgp/naarad) (MFTP's ntfy server) into events on a Google Calendar. It handles reschedules and cancellations, and alerts you on your phone when a notice is unclear.

```
Cron (every 5 min) → Cloudflare Worker → poll Naarad /<topic>/json?since=<cursor>
  → skip everything except Schedule / Re-schedule / PPT notices (by title, no LLM call)
  → Gemini extracts date, time, venue and link (Workers AI if Gemini is unavailable)
  → D1: is this new, or a change to an event we already created?
  → Google Calendar insert / patch → ntfy alert if a time is missing or unclear
```

## What ends up on the calendar

| Notice | Calendar |
|---|---|
| Schedule / PPT with a clear time | `Google — Online Test`, 14:00–15:30 IST, venue or link as the location, full notice in the description |
| No end time | 1 hour long |
| Time missing, "TBA", or details in a PDF | All-day `⚠ Google — Online Test (time TBA)`, plus an alert |
| Re-schedule | The existing event is moved (it isn't duplicated) |
| Cancellation | The event is renamed `[CANCELLED] …` and marked free, but kept |
| Results, shortlists, CV deadlines, etc. | Ignored |

Colours: tests are red, interviews orange, GDs yellow, PPTs blue.

## Setup

You need Node 20+, a Cloudflare account (free plan), and a Google account.

### 1. Google Calendar and service account

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
2. Go to **IAM & Admin → Service Accounts**, create a service account (it needs no roles), then go to **Keys → Add key → JSON**. Keep that file private. `.gitignore` already blocks `service-account*.json`.
3. In [Google Calendar](https://calendar.google.com/), create a new calendar called **Placements**.
4. In that calendar's settings:
   - **Share with specific people:** add the service account's email (`…@….iam.gserviceaccount.com`) with **Make changes to events**.
   - **Event notifications:** add your reminders, e.g. 1 day, 1 hour and 15 minutes before. Reminders come from here, not from the bot.
   - **Integrate calendar:** copy the **Calendar ID**.

### 2. Gemini

Create an API key at [Google AI Studio](https://aistudio.google.com/apikey). If `gemini-2.5-flash` has been retired by the time you set this up, change `GEMINI_MODEL` in `wrangler.jsonc` to the current Flash model.

### 3. Alerts

Choose a long random topic name, e.g. `harsh-placement-bot-7f3k9q2x`, and subscribe to it on **ntfy.sh** in the ntfy app. Anyone who knows the name can read it, so keep it random.

### 4. Cloudflare

```bash
npm install
npx wrangler login
npx wrangler d1 create placement-bot
```

Paste the printed `database_id` into `wrangler.jsonc`. Check that `TOPIC` matches the placement topic you're subscribed to on Naarad. Then:

```bash
npm run db:migrate
npx wrangler secret put NAARAD_USER
npx wrangler secret put NAARAD_PASS
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GOOGLE_SA_EMAIL
npx wrangler secret put GOOGLE_SA_KEY
npx wrangler secret put CALENDAR_ID
npx wrangler secret put ALERT_TOPIC
npx wrangler secret put RUN_TOKEN
```

- `GOOGLE_SA_EMAIL` is `client_email` from the JSON key.
- `GOOGLE_SA_KEY` is `private_key`, the whole `-----BEGIN PRIVATE KEY-----…` string. The `\n` escapes are fine.
- `RUN_TOKEN` is any random string. It protects the manual `POST /run` endpoint.

### 5. Dry run first

`DRY_RUN` is `"true"` in `wrangler.jsonc`. In that mode the bot polls Naarad and calls Gemini for real, but it only **logs** what it would do to the calendar, and it saves no state.

```bash
npm run deploy
npm run tail
```

In a second terminal:

```bash
curl -X POST https://placement-calendar-bot.<your-subdomain>.workers.dev/run -H "Authorization: Bearer <RUN_TOKEN>"
```

Check the `[dry-run] would create: …` lines against the notices in your ntfy app. If they look right, set `DRY_RUN` to `"false"` and run `npm run deploy` again. From then on the cron trigger runs every 5 minutes. On its first real run, the bot backfills the last 3 days of notices that Naarad still has cached. Events in the past are skipped.

To run locally instead, put the secrets in `.dev.vars` (see `.dev.vars.example`), then run `npm run db:migrate:local`, then `npm run dev`, then `curl http://localhost:8787/__scheduled`.

## Day to day

- `npm run tail` streams the logs.
- To see what the bot has done:
  ```bash
  npx wrangler d1 execute placement-bot --remote --command "select * from events order by id desc limit 20"
  ```
- To see notices it gave up on:
  ```bash
  npx wrangler d1 execute placement-bot --remote --command "select * from notices where status = 'failed'"
  ```

If a notice fails 3 runs in a row, the bot alerts you and moves on, so one bad notice can't block the rest. If Naarad is down, nothing is lost as long as it's back within 3 days, which is how long Naarad caches messages.

## Development

```bash
npm test
npm run typecheck
```

The source is in `src/`:

| File | What it does |
|---|---|
| `naarad.ts` | Polling and MFTP title/body parsing |
| `extract.ts` | LLM prompt, schema and output validation |
| `calendar.ts` | Service-account JWT and Calendar API |
| `store.ts` | D1 |
| `pipeline.ts` | Ties everything together |
| `index.ts` | Worker entry point |

To tune the prompt (`SYSTEM_PROMPT` in `src/extract.ts`), paste real notices from the ntfy app into tests.
