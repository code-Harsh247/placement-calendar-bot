// Google Calendar via a service account. The googleapis package doesn't run on Workers,
// so this signs the service-account JWT itself with WebCrypto (RS256).

export type EventTime = { dateTime: string; timeZone: string; date?: null } | { date: string; dateTime?: null; timeZone?: null };

export interface CalendarEvent {
  summary: string;
  description?: string;
  location?: string | null;
  start: EventTime;
  end: EventTime;
  colorId?: string;
  transparency?: "opaque" | "transparent";
  extendedProperties?: { private: Record<string, string> };
}

export interface Calendar {
  insert(event: CalendarEvent): Promise<string>;
  patch(eventId: string, event: Partial<CalendarEvent>): Promise<void>;
}

export interface ServiceAccountConfig {
  email: string;
  privateKeyPem: string;
  calendarId: string;
}

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function base64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Keys pasted from the JSON key file often keep their "\n" escapes.
  const b64 = pem
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function signJwt(cfg: ServiceAccountConfig, nowSeconds: number): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: cfg.email, scope: SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }),
  );
  const key = await importPrivateKey(cfg.privateKeyPem);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64url(sig)}`;
}

export function googleCalendar(cfg: ServiceAccountConfig, fetchFn: typeof fetch = fetch): Calendar {
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (token && token.expiresAt - 60 > now) return token.value;
    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: await signJwt(cfg, now),
      }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`Google token request failed: HTTP ${res.status} ${body.error_description ?? ""}`);
    }
    token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) };
    return token.value;
  }

  const eventsUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId)}/events`;

  async function request(method: string, url: string, body: unknown): Promise<{ id?: string }> {
    const res = await fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Calendar ${method} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as { id?: string };
  }

  return {
    async insert(event) {
      const created = await request("POST", eventsUrl, event);
      if (!created.id) throw new Error("Calendar insert returned no event id");
      return created.id;
    },
    async patch(eventId, event) {
      await request("PATCH", `${eventsUrl}/${encodeURIComponent(eventId)}`, event);
    },
  };
}
