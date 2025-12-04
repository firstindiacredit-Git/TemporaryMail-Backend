const API_BASE =
  (import.meta.env && import.meta.env.VITE_API_BASE_URL
    ? import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, "")
    : "") || "";

export const api = {
  async createMailbox() {
    const res = await fetch(`${API_BASE}/api/mailboxes`, { method: "POST" });
    if (!res.ok) {
      const errorText = await res.text();
      let message = "Unable to create mailbox";
      try {
        const parsed = JSON.parse(errorText);
        message = parsed?.error || parsed?.message || message;
      } catch {
        message = errorText || message;
      }
      throw new Error(message);
    }
    return res.json();
  },
  async getMessages(mailboxId) {
    const res = await fetch(`${API_BASE}/api/mailboxes/${mailboxId}/messages`);
    if (!res.ok) throw new Error("Unable to load inbox");
    return res.json();
  },
  async extendMailbox(mailboxId) {
    const res = await fetch(`${API_BASE}/api/mailboxes/${mailboxId}/extend`, {
      method: "POST",
    });
    if (!res.ok) throw new Error("Unable to extend mailbox");
    return res.json();
  },
};
