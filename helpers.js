export const formatRelativeTime = (isoString) => {
  const expiresAt = new Date(isoString);
  const remainingMs = expiresAt.getTime() - Date.now();
  if (remainingMs <= 0) return "expired";
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
};

export const sanitizeHtml = (html = "") => {
  if (!html) return "";
  let cleaned = html
    // Remove scripts
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    // Remove event handlers
    .replace(/on\w+="[^"]*"/gi, "")
    .replace(/on\w+='[^']*'/gi, "")
    // Remove all style tags
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    // Remove inline styles
    .replace(/\s*style\s*=\s*["'][^"']*["']/gi, "")
    // Remove background colors/styles from tags
    .replace(/\s*bgcolor\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\s*background\s*=\s*["'][^"']*["']/gi, "");
  
  return cleaned;
};

export const enhanceLinks = (container) => {
  if (!container) return;
  container.querySelectorAll("a[href]").forEach((anchor) => {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  });
};

export const extractVerifyLinks = (html = "", body = "") => {
  const links = [];
  
  // Extract from HTML
  if (html) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      doc.querySelectorAll("a[href]").forEach((anchor) => {
        const href = anchor.getAttribute("href");
        if (!href) return;
        const text = (anchor.textContent || href).trim();
        if (!text) return;
        // Check if link text contains verify, confirm, activate, etc.
        if (/verify|confirm|activate|validate|click here|get started/i.test(text)) {
          links.push({ href, text });
        }
      });
    } catch {
      // ignore parse errors
    }
  }
  
  // Extract from plain text if no HTML links found
  if (!links.length && body) {
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const verifyRegex = /verify|confirm|activate|validate/i;
    let match;
    const seen = new Set();
    while ((match = urlRegex.exec(body)) !== null) {
      const href = match[1];
      if (href && !seen.has(href) && verifyRegex.test(href)) {
        seen.add(href);
        links.push({ href, text: "Verify Email" });
      }
    }
  }
  
  return links;
};

