const api = {
  async createMailbox() {
    const res = await fetch("/api/mailboxes", { method: "POST" });
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
    const res = await fetch(`/api/mailboxes/${mailboxId}/messages`);
    if (!res.ok) throw new Error("Unable to load inbox");
    return res.json();
  },
  async extendMailbox(mailboxId) {
    const res = await fetch(`/api/mailboxes/${mailboxId}/extend`, {
      method: "POST",
    });
    if (!res.ok) throw new Error("Unable to extend mailbox");
    return res.json();
  },
};

const elements = {
  emailAddress: document.getElementById("emailAddress"),
  searchDisplay: document.getElementById("searchDisplay"),
  generateBtn: document.getElementById("generateBtn"),
  generateTopBtn: document.getElementById("generateTopBtn"),
  copyBtn: document.getElementById("copyBtn"),
  extendBtn: document.getElementById("extendBtn"),
  expiryTimer: document.getElementById("expiryTimer"),
  inboxList: document.getElementById("inboxList"),
  refreshBtn: document.getElementById("refreshBtn"),
  template: document.getElementById("messageTemplate"),
  detailPanel: document.getElementById("detailPanel"),
  detailSubject: document.getElementById("detailSubject"),
  detailFrom: document.getElementById("detailFrom"),
  detailTime: document.getElementById("detailTime"),
  detailBody: document.getElementById("detailBody"),
};

const state = {
  mailbox: null,
  countdownInterval: null,
  pollingInterval: null,
  messages: [],
  selectedMessageId: null,
};

const formatRelativeTime = (isoString) => {
  const expiresAt = new Date(isoString);
  const remainingMs = expiresAt.getTime() - Date.now();
  if (remainingMs <= 0) return "expired";
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
};

const setBusy = (isBusy) => {
  // Sidebar generate button
  elements.generateBtn.disabled = isBusy;
  const iconSpan = elements.generateBtn.querySelector("span:first-child");
  const textSpan = elements.generateBtn.querySelector("span:last-child");
  if (isBusy) {
    iconSpan.textContent = "⏳";
    textSpan.textContent = "Working...";
  } else {
    iconSpan.textContent = "🔄";
    textSpan.textContent = "Generate New";
  }

  // Topbar generate button (if present)
  if (elements.generateTopBtn) {
    elements.generateTopBtn.disabled = isBusy;
  }
};

const updateButtonsState = (enabled) => {
  [elements.copyBtn, elements.extendBtn, elements.refreshBtn].forEach(
    (button) => {
      button.disabled = !enabled;
    }
  );
};

const startCountdown = () => {
  clearInterval(state.countdownInterval);
  if (!state.mailbox) {
    elements.expiryTimer.textContent = "--";
    return;
  }
  const tick = () => {
    elements.expiryTimer.textContent = formatRelativeTime(
      state.mailbox.expiresAt
    );
  };
  tick();
  state.countdownInterval = setInterval(tick, 1000);
};

const sanitizeHtml = (html = "") => {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+="[^"]*"/gi, "")
    .replace(/on\w+='[^']*'/gi, "");
};

const enhanceLinks = (container) => {
  container.querySelectorAll("a[href]").forEach((anchor) => {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  });
};

// Convert HTML email content to plain text (no background / layout)
const htmlToPlainText = (html = "") => {
  if (!html) return "";
  // Remove style/head/script blocks completely
  let text = html
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?>[\s\S]*?<\/head>/gi, "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");

  // Replace common block-level endings with newlines so structure stays readable
  text = text.replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n");

  // Strip remaining tags
  text = text.replace(/<\/?[^>]+(>|$)/g, "");

  // Decode a few common entities
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  // Collapse extra blank lines
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
};

// Try to find a "primary" link (e.g. verify button) so we can style it separately
const extractPrimaryLink = (message, plainText) => {
  let candidates = [];

  // 1) If HTML exists, try to read <a href> tags
  if (message.html) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(message.html, "text/html");
      doc.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href");
        if (!href) return;
        const text = (a.textContent || href).trim();
        if (!text) return;
        candidates.push({ href, text });
      });
    } catch {
      // ignore parse errors
    }
  }

  // 2) Fallback: extract URLs from plain text
  if (!candidates.length && plainText) {
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    let match;
    const seen = new Set();
    while ((match = urlRegex.exec(plainText)) !== null) {
      const href = match[1];
      if (!href || seen.has(href)) continue;
      seen.add(href);
      candidates.push({ href, text: href });
    }
  }

  if (!candidates.length) return null;

  // Prefer a link whose text includes "verify", "confirm" etc.
  const important = candidates.find((c) =>
    /verify|confirm/i.test(c.text || "")
  );
  return important || candidates[0];
};

const updateDetailPanel = (message) => {
  if (!message) {
    state.selectedMessageId = null;
    elements.detailPanel.hidden = true;
    elements.detailBody.textContent = "";
    return;
  }
  elements.detailPanel.hidden = false;
  elements.detailSubject.textContent = message.subject;
  elements.detailFrom.textContent = message.from;
  elements.detailTime.textContent = new Date(message.receivedAt).toLocaleString();

  // Render HTML email like Gmail does - preserve styling, buttons, colors
  // But ensure the container stays white and doesn't affect page
  elements.detailBody.style.backgroundColor = "white";
  elements.detailBody.style.color = "#202124";
  
  if (message.html) {
    // Sanitize HTML to remove scripts and event handlers, but keep styling
    const cleaned = sanitizeHtml(message.html);
    elements.detailBody.innerHTML = cleaned;
    enhanceLinks(elements.detailBody);
    
    // Force white background on the container after rendering
    elements.detailBody.style.backgroundColor = "white";
    elements.detailBody.style.color = "#202124";
  } else if (message.body) {
    // Fallback to plain text if no HTML
    elements.detailBody.textContent = message.body;
  } else {
    elements.detailBody.textContent = "(no content)";
  }
};

const highlightSelectedCard = () => {
  const cards = elements.inboxList.querySelectorAll(".message-card");
  cards.forEach((card) => {
    if (card.dataset.messageId === state.selectedMessageId) {
      card.classList.add("active");
    } else {
      card.classList.remove("active");
    }
  });
};

const selectMessage = (messageId) => {
  state.selectedMessageId = messageId;
  const message = state.messages.find((msg) => msg.id === messageId);
  updateDetailPanel(message || null);
  highlightSelectedCard();
};

const renderMessages = (messages) => {
  state.messages = messages;
  elements.inboxList.innerHTML = "";
  if (!messages.length) {
    elements.inboxList.classList.add("empty");
    elements.inboxList.innerHTML =
      "<p>No messages yet. Share the address and refresh after sending an email.</p>";
    updateDetailPanel(null);
    return;
  }
  elements.inboxList.classList.remove("empty");
  messages.forEach((message) => {
    const article = elements.template.content.firstElementChild.cloneNode(true);
    article.dataset.messageId = message.id;
    article.querySelector(".subject").textContent = message.subject;
    article.querySelector(".meta").textContent = `${message.from} • ${new Date(
      message.receivedAt
    ).toLocaleString()}`;
    article.querySelector(".body").textContent = message.body;
    article.addEventListener("click", () => selectMessage(message.id));
    elements.inboxList.appendChild(article);
  });

  if (
    !state.selectedMessageId ||
    !messages.some((msg) => msg.id === state.selectedMessageId)
  ) {
    selectMessage(messages[0].id);
  } else {
    highlightSelectedCard();
  }
};

const refreshInbox = async () => {
  if (!state.mailbox) return;
  elements.refreshBtn.textContent = "Refreshing...";
  elements.refreshBtn.disabled = true;
  try {
    const { messages } = await api.getMessages(state.mailbox.mailboxId);
    renderMessages(messages);
  } catch (error) {
    console.error(error);
    if (error.message.includes("404") || error.message.includes("not found")) {
      alert(
        "Mailbox not found. This usually happens after a server restart. Please generate a new address."
      );
      state.mailbox = null;
      updateButtonsState(false);
      elements.emailAddress.textContent = "Generate an address";
      updateDetailPanel(null);
    } else {
      alert(error.message);
    }
  } finally {
    elements.refreshBtn.textContent = "Refresh";
    elements.refreshBtn.disabled = false;
  }
};

const startPolling = () => {
  clearInterval(state.pollingInterval);
  if (!state.mailbox) return;
  state.pollingInterval = setInterval(refreshInbox, 6000);
};

const handleMailboxCreated = (mailbox) => {
  state.mailbox = mailbox;
  elements.emailAddress.textContent = mailbox.address || "Generate an address";
  if (elements.searchDisplay) {
    elements.searchDisplay.textContent = mailbox.address || "No address generated";
  }
  updateButtonsState(true);
  updateDetailPanel(null);
  startCountdown();
  refreshInbox();
  startPolling();
};

elements.generateBtn.addEventListener("click", async () => {
  setBusy(true);
  try {
    const mailbox = await api.createMailbox();
    handleMailboxCreated(mailbox);
  } catch (error) {
    console.error(error);
    alert(error.message);
  } finally {
    setBusy(false);
  }
});

// Topbar generate button triggers the same flow
if (elements.generateTopBtn) {
  elements.generateTopBtn.addEventListener("click", () => {
    elements.generateBtn.click();
  });
}

elements.copyBtn.addEventListener("click", async () => {
  if (!state.mailbox) return;
  try {
    await navigator.clipboard.writeText(state.mailbox.address);
    const iconSpan = elements.copyBtn.querySelector(".copy-icon");
    const textSpan = elements.copyBtn.querySelector("span:last-child");
    iconSpan.textContent = "✓";
    textSpan.textContent = "Copied!";
    setTimeout(() => {
      iconSpan.textContent = "📋";
      textSpan.textContent = "Copy";
    }, 1500);
  } catch {
    alert("Clipboard copy failed");
  }
});

elements.extendBtn.addEventListener("click", async () => {
  if (!state.mailbox) return;
  elements.extendBtn.textContent = "Extending...";
  elements.extendBtn.disabled = true;
  try {
    const mailbox = await api.extendMailbox(state.mailbox.mailboxId);
    handleMailboxCreated(mailbox);
  } catch (error) {
    console.error(error);
    alert(error.message);
  } finally {
    elements.extendBtn.textContent = "Extend +15m";
    elements.extendBtn.disabled = false;
  }
});

elements.refreshBtn.addEventListener("click", refreshInbox);

window.addEventListener("beforeunload", () => {
  clearInterval(state.countdownInterval);
  clearInterval(state.pollingInterval);
});

elements.detailBody.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link) return;
  event.preventDefault();
  window.open(link.href, "_blank", "noopener");
});
