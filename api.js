const API_BASE =
  (import.meta.env && import.meta.env.VITE_API_BASE_URL
    ? import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, "")
    : "") || "";

export const api = {
  async createMailbox() {
    try {
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
        const error = new Error(message);
        error.status = res.status;
        throw error;
      }
      return res.json();
    } catch (error) {
      // Re-throw if it's already an Error with message
      if (error instanceof Error) {
        throw error;
      }
      // Handle network errors
      throw new Error("Network error. Please check your connection and try again.");
    }
  },
  async getMessages(mailboxId) {
    try {
      const res = await fetch(`${API_BASE}/api/mailboxes/${mailboxId}/messages`);
      if (!res.ok) {
        const errorText = await res.text();
        let message = "Unable to load inbox";
        try {
          const parsed = JSON.parse(errorText);
          message = parsed?.error || parsed?.message || message;
        } catch {
          message = errorText || message;
        }
        const error = new Error(message);
        error.status = res.status;
        throw error;
      }
      return res.json();
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Network error. Please check your connection and try again.");
    }
  },
  async extendMailbox(mailboxId) {
    try {
      const res = await fetch(`${API_BASE}/api/mailboxes/${mailboxId}/extend`, {
        method: "POST",
      });
      if (!res.ok) {
        const errorText = await res.text();
        let message = "Unable to extend mailbox";
        try {
          const parsed = JSON.parse(errorText);
          message = parsed?.error || parsed?.message || message;
        } catch {
          message = errorText || message;
        }
        const error = new Error(message);
        error.status = res.status;
        throw error;
      }
      return res.json();
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Network error. Please check your connection and try again.");
    }
  },
};
