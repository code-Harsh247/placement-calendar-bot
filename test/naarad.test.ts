import { describe, expect, it } from "vitest";
import { parseTitle, pollNaarad, restoreLinks, stripDisclaimer, toNotice } from "../src/naarad";

describe("parseTitle", () => {
  it("splits an MFTP title", () => {
    expect(parseTitle("#1234 | PLACEMENT | PPT/Workshop/Seminars etc | Goldman Sachs")).toEqual({
      noticeId: "1234",
      type: "PLACEMENT",
      subject: "PPT/Workshop/Seminars etc",
      company: "Goldman Sachs",
    });
  });

  it("keeps pipes in the company name", () => {
    expect(parseTitle("#9 | PLACEMENT | Schedule | A | B")?.company).toBe("A | B");
  });

  it("rejects other titles", () => {
    expect(parseTitle("hello")).toBeNull();
  });
});

describe("notice body", () => {
  it("restores links from ntfy actions", () => {
    const body = "Join at <LINK 1> and test at <LINK 2>. <LINK 4> stays.";
    const actions = [
      { action: "view", label: "Link 1", url: "https://meet.google.com/abc" },
      { action: "view", label: "Link 2", url: "https://hackerrank.com/x" },
    ];
    expect(restoreLinks(body, actions)).toBe(
      "Join at https://meet.google.com/abc and test at https://hackerrank.com/x. <LINK 4> stays.",
    );
  });

  it("strips the MFTP disclaimer", () => {
    const body = `PPT on 3rd Nov at 6 PM.\n29-10-2026 09:12\n--------------\n\n⚠️ DISCLAIMER ⚠️\n\nMFTP is unofficial.\n\n--------------\n            `;
    expect(stripDisclaimer(body)).toBe("PPT on 3rd Nov at 6 PM.\n29-10-2026 09:12");
  });

  it("builds a notice from a message", () => {
    const notice = toNotice({
      id: "abc", time: 100, event: "message",
      title: "#7 | PLACEMENT | Schedule | Google",
      message: "Test at <LINK 1>",
      actions: [{ action: "view", label: "Link 1", url: "https://x.y" }],
    });
    expect(notice).toMatchObject({ noticeId: "7", company: "Google", body: "Test at https://x.y", postedAt: 100, ntfyId: "abc" });
  });
});

describe("pollNaarad", () => {
  it("polls with basic auth and keeps only messages", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("Authorization") };
      return new Response(
        [
          JSON.stringify({ id: "a", time: 1, event: "open" }),
          JSON.stringify({ id: "b", time: 2, event: "message", title: "t" }),
          "",
        ].join("\n"),
      );
    }) as unknown as typeof fetch;

    const msgs = await pollNaarad({ url: "https://naarad.example/", topic: "kgp-mftp-placement", user: "u", pass: "p" }, "3d", fakeFetch);
    expect(msgs.map((m) => m.id)).toEqual(["b"]);
    expect(seen?.url).toBe("https://naarad.example/kgp-mftp-placement/json?poll=1&since=3d");
    expect(seen?.auth).toBe(`Basic ${btoa("u:p")}`);
  });

  it("throws on HTTP errors", async () => {
    const fakeFetch = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    await expect(pollNaarad({ url: "https://n", topic: "t", user: "u", pass: "p" }, "3d", fakeFetch)).rejects.toThrow(/403/);
  });
});
