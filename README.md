# placement-calendar-bot

Turns placement notices from [Naarad](https://github.com/metakgp/naarad) (the `kgp-mftp-placement` ntfy topic) into Google Calendar events automatically.

## How it works

```
Cron (every 5 min) → Cloudflare Worker → poll Naarad /json?since=<id>
  → skip Results/Shortlists by title → LLM extracts date/time/venue
  → D1 lookup (new or reschedule?) → Google Calendar insert/patch
  → ntfy ping if a notice is missing details
```

- **Runtime:** Cloudflare Workers + Cron Triggers (free plan)
- **State:** Cloudflare D1, mapping notice ID → calendar event ID
- **Parsing:** LLM with a strict JSON schema (Gemini, or Workers AI as a fallback)
- **Calendar:** a dedicated "Placements" calendar written by a Google service account

## Status

Scaffolding only. The Worker hasn't been written yet.
