// Reading MFTP notices from Naarad (metakgp's ntfy server).
//
// MFTP publishes every notice with a title like `#1234 | PLACEMENT | Schedule | Google`,
// swaps URLs in the body for `<LINK n>` placeholders (the real URLs go in the ntfy actions),
// and appends a disclaimer block. See metakgp/mftp: mftp/ntfy.py.

export interface NtfyAction {
  action: string;
  label?: string;
  url?: string;
}

export interface NtfyMessage {
  id: string;
  time: number; // unix seconds
  event: string;
  topic?: string;
  title?: string;
  message?: string;
  actions?: NtfyAction[];
}

export interface Notice {
  ntfyId: string;
  noticeId: string;
  type: string;
  subject: string;
  company: string;
  body: string;
  postedAt: number; // unix seconds
}

// kgp-mftp carries internship notices too; only placement ones go on the calendar.
export const IN_SCOPE_TYPES = new Set(["PLACEMENT"]);

// The MFTP subjects that describe something you attend.
export const IN_SCOPE_SUBJECTS = new Set(["Schedule", "Re-schedule", "PPT/Workshop/Seminars etc"]);

export interface NaaradConfig {
  url: string;
  topic: string;
  user: string;
  pass: string;
}

export async function pollNaarad(
  cfg: NaaradConfig,
  since: string,
  fetchFn: typeof fetch = fetch,
): Promise<NtfyMessage[]> {
  const url = `${cfg.url.replace(/\/$/, "")}/${encodeURIComponent(cfg.topic)}/json?poll=1&since=${encodeURIComponent(since)}`;
  const res = await fetchFn(url, {
    headers: { Authorization: `Basic ${btoa(`${cfg.user}:${cfg.pass}`)}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Naarad poll failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as NtfyMessage)
    .filter((m) => m.event === "message");
}

export function parseTitle(title: string): Pick<Notice, "noticeId" | "type" | "subject" | "company"> | null {
  const m = /^#(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/.exec(title.trim());
  if (!m) return null;
  return { noticeId: m[1]!, type: m[2]!, subject: m[3]!, company: m[4]! };
}

export function restoreLinks(body: string, actions: NtfyAction[] = []): string {
  return body.replace(/<LINK (\d+)>/g, (placeholder, n: string) => {
    const byLabel = actions.find((a) => a.label === `Link ${n}`);
    const url = (byLabel ?? actions[Number(n) - 1])?.url;
    return url ?? placeholder;
  });
}

export function stripDisclaimer(body: string): string {
  return body.replace(/\s*-{5,}\s*⚠️\s*DISCLAIMER[\s\S]*$/u, "").trimEnd();
}

// Returns null for messages that aren't MFTP notices (e.g. a test message on the topic).
export function toNotice(msg: NtfyMessage): Notice | null {
  const parsed = parseTitle(msg.title ?? "");
  if (!parsed) return null;
  return {
    ...parsed,
    ntfyId: msg.id,
    body: stripDisclaimer(restoreLinks(msg.message ?? "", msg.actions)),
    postedAt: msg.time,
  };
}
