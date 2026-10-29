// Alerts to you, on a private topic of the public ntfy.sh server (Naarad itself is read-only for users).

export type Alert = (title: string, message: string) => Promise<void>;

export function ntfyAlert(topic: string, fetchFn: typeof fetch = fetch): Alert {
  return async (title, message) => {
    // Publishing as JSON keeps non-ASCII titles intact (ntfy headers are latin-1 only).
    const res = await fetchFn("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title, message, tags: ["calendar"], priority: 4 }),
    });
    if (!res.ok) throw new Error(`ntfy alert failed: HTTP ${res.status}`);
  };
}
