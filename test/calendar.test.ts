import { describe, expect, it } from "vitest";
import { googleCalendar, signJwt } from "../src/calendar";

async function testKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  // Written with literal "\n" escapes, the way it appears in the service-account JSON file.
  const pem = `-----BEGIN PRIVATE KEY-----\\n${b64.match(/.{1,64}/g)!.join("\\n")}\\n-----END PRIVATE KEY-----\\n`;
  return { pem, publicKey: pair.publicKey };
}

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

describe("service account auth", () => {
  it("signs a verifiable RS256 JWT", async () => {
    const { pem, publicKey } = await testKey();
    const jwt = await signJwt({ email: "bot@p.iam.gserviceaccount.com", privateKeyPem: pem, calendarId: "c" }, 1000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(fromB64url(c!)))).toMatchObject({
      iss: "bot@p.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/calendar.events",
      iat: 1000,
      exp: 4600,
    });
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, fromB64url(s!), new TextEncoder().encode(`${h}.${c}`));
    expect(valid).toBe(true);
  });

  it("fetches a token once and reuses it", async () => {
    const { pem } = await testKey();
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (url.includes("oauth2")) return Response.json({ access_token: "tok", expires_in: 3600 });
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
      return Response.json({ id: "ev1" });
    }) as unknown as typeof fetch;

    const cal = googleCalendar({ email: "e", privateKeyPem: pem, calendarId: "abc@group.calendar.google.com" }, fakeFetch);
    const ev = { summary: "x", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } };
    expect(await cal.insert(ev)).toBe("ev1");
    await cal.patch("ev1", { summary: "y" });
    expect(calls).toEqual([
      "POST https://oauth2.googleapis.com/token",
      "POST https://www.googleapis.com/calendar/v3/calendars/abc%40group.calendar.google.com/events",
      "PATCH https://www.googleapis.com/calendar/v3/calendars/abc%40group.calendar.google.com/events/ev1",
    ]);
  });
});
