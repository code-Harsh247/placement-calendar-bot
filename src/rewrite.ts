// Regenerates the titles and descriptions of upcoming events (POST /rewrite), e.g. after the
// description prompt changes, or once for events created before the two-step pipeline.
//
// Each event is rewritten from every notice about its company that's still available (its own
// notice plus later ones, e.g. a company's PPT notice with the Zoom link after a CDC schedule),
// not just the notice that created it.

import type { Calendar } from "./calendar";
import type { Describer } from "./describe";
import type { Kind } from "./extract";
import { toNotice, type Notice, type NtfyMessage } from "./naarad";
import { composeDescription } from "./pipeline";
import { companyKey, type Store, type StoredEvent } from "./store";
import { istDate } from "./time";
import { eventTitle } from "./title";

export interface RewriteDeps {
  store: Store;
  describe: Describer;
  calendar: Calendar;
  poll: (since: string) => Promise<NtfyMessage[]>;
  now: () => Date;
  log: (msg: string) => void;
}

export interface RewriteSummary {
  rewritten: number;
  skipped: number;
  errors: string[];
}

// The notices about one event, oldest first, merged into one for the description step.
function combine(notices: Notice[]): Notice {
  const latest = notices[notices.length - 1]!;
  if (notices.length === 1) return latest;
  return {
    ...latest,
    body: notices.map((n) => `Notice #${n.noticeId} (${n.subject}):\n${n.body}`).join("\n\n---\n\n"),
  };
}

export async function rewriteDescriptions(deps: RewriteDeps): Promise<RewriteSummary> {
  const { store } = deps;
  const summary: RewriteSummary = { rewritten: 0, skipped: 0, errors: [] };
  const events = await store.upcomingEvents(istDate(deps.now()));
  if (events.length === 0) return summary;

  const cached = (await deps.poll("all")).map(toNotice).filter((n): n is Notice => n !== null);

  // An event's own notice: Naarad's copy, or the body stored when it was handled.
  async function ownNotice(e: StoredEvent): Promise<Notice | undefined> {
    const fromNaarad = cached.find((n) => n.noticeId === e.notice_id);
    if (fromNaarad) return fromNaarad;
    const [body, record] = [await store.getNoticeBody(e.notice_id), await store.getNotice(e.notice_id)];
    if (!body || !record) return undefined;
    return { ntfyId: record.ntfyId, noticeId: e.notice_id, type: "PLACEMENT", subject: record.subject, company: record.company, body, postedAt: 0 };
  }

  for (const e of events) {
    const own = await ownNotice(e);
    if (!own) {
      deps.log(`rewrite: notice #${e.notice_id} is no longer available, skipping "${e.title}"`);
      summary.skipped++;
      continue;
    }
    const later = cached.filter((n) => n.noticeId !== own.noticeId && n.postedAt >= own.postedAt && companyKey(n.company) === e.company_key);
    const notice = combine([own, ...later.sort((a, b) => a.postedAt - b.postedAt)]);

    let lines: string[];
    try {
      const res = await deps.describe(notice, [{
        ref: e.id,
        company: e.company,
        kind: e.kind as Kind,
        date: e.starts_at?.slice(0, 10) ?? null,
        start: e.starts_at && e.starts_at.length > 10 ? e.starts_at.slice(11, 16) : null,
        end: null,
        venue: null,
        link: null,
        previous_details: [], // regenerated from the notices themselves
      }]);
      lines = res.lines.get(e.id) ?? [];
      for (const r of res.rejected) summary.errors.push(`"${e.title}": ${r.reason}`);
    } catch (err) {
      summary.errors.push(`"${e.title}": ${err instanceof Error ? err.message : err}`);
      summary.skipped++;
      continue;
    }

    const placeholder = e.title.startsWith("⚠");
    // Keep "[MOVED…]" markers; otherwise rebuild the title the current way.
    const title = e.title.startsWith("⚠ [MOVED") ? e.title : e.details === null ? eventTitle(e.company, e.kind as Kind, null, placeholder) : e.title;
    await deps.calendar.patch(e.gcal_event_id, { summary: title, description: composeDescription(lines, placeholder, notice) });
    await store.updateEvent(e.id, { title, details: JSON.stringify(lines) });
    summary.rewritten++;
  }
  return summary;
}
