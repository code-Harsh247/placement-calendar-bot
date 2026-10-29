// Sends errors to your alert topic, so a broken bot doesn't fail silently.
// The same error repeating (e.g. Naarad down for hours) is sent at most once an hour.

import type { Alert } from "./alert";
import type { Store } from "./store";

export type ReportError = (where: string, err: unknown) => Promise<void>;

export const ERROR_COOLDOWN_MS = 60 * 60 * 1000;
const STATE_KEY = "last_error";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errorReporter(
  store: Pick<Store, "getState" | "setState">,
  alert: Alert,
  log: (msg: string) => void,
  now: () => Date = () => new Date(),
): ReportError {
  return async (where, err) => {
    const message = errorMessage(err);
    log(`error (${where}): ${message}`);
    const at = now().getTime();

    // If D1 itself is what's failing, skip the throttle and just send.
    let previous: { message: string; at: number } | null = null;
    try {
      const raw = await store.getState(STATE_KEY);
      previous = raw ? JSON.parse(raw) : null;
    } catch {}
    if (previous && previous.message === message && at - previous.at < ERROR_COOLDOWN_MS) {
      log("same error alerted within the last hour, not alerting again");
      return;
    }

    try {
      await alert(`Bot error: ${where}`, message.slice(0, 1500));
    } catch (alertErr) {
      log(`couldn't send error alert: ${errorMessage(alertErr)}`);
      return;
    }
    try {
      await store.setState(STATE_KEY, JSON.stringify({ message, at }));
    } catch {}
  };
}
