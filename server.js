import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { v4 as uuid } from "uuid";
import dayjs from "dayjs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Environment configuration
const isProduction = process.env.NODE_ENV === "production";
const isVercel = process.env.VERCEL === "1";
const PORT = process.env.PORT || 3000;
const MAIL_TM_BASE_URL = process.env.MAIL_TM_BASE_URL || "https://api.mail.tm";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// Application constants
const MAILBOX_TTL_MINUTES = 15;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAILBOX_LOCAL_PART_LENGTH = 10;
const PASSWORD_LENGTH = 24;
const DOMAIN_CACHE_TTL_MS = 10 * 60 * 1000;

let domainRotationIndex = 0;
const DEFAULT_PREFERRED_DOMAINS = [
  "comfythings.com",
  "elyxstore.com",
  "ketoblisslabs.com",
  "ekii.de",
  "asia-mail.com",
  "doer.sbs",
  "badfist.com",
  "besenica.com",
  "mail.tm",
];

const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
const letters = "abcdefghijklmnopqrstuvwxyz";

const generateIdentifier = (length) => {
  let output = "";
  for (let i = 0; i < length; i += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
};

const generateLocalPart = () => {
  // First character must be a letter, rest can be letters or numbers
  const firstChar = letters[Math.floor(Math.random() * letters.length)];
  let rest = "";
  for (let i = 0; i < MAILBOX_LOCAL_PART_LENGTH - 1; i += 1) {
    rest += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return firstChar + rest;
};
const generatePassword = () => generateIdentifier(PASSWORD_LENGTH);

let cachedDomains = { expiresAt: 0, items: [] };

const mailboxes = new Map(); // mailboxId -> { address, domain, createdAt, expiresAt, token, tokenExpiresAt, password, accountId, lastMessageCount }

const mailTmRequest = async (
  pathFragment,
  { method = "GET", headers = {}, body, retries = 0, maxRetries = 3 } = {}
) => {
  // Create timeout controller
  const controller = new AbortController();
  // Longer timeout for Vercel serverless functions (60 seconds max)
  const timeoutMs = process.env.VERCEL ? 55000 : 30000; // 55s on Vercel (below 60s limit), 30s locally
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${MAIL_TM_BASE_URL}${pathFragment}`, {
      method,
      headers: {
        Accept: "application/ld+json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId); // Clear timeout on successful response

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      // Retry on 500 errors with exponential backoff
      if (response.status >= 500 && retries < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, retries), 5000); // Exponential backoff, max 5s
        console.log(
          `[mail.tm Retry] ${pathFragment} - Status ${
            response.status
          }, retrying in ${delay}ms (attempt ${retries + 1}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return mailTmRequest(pathFragment, {
          method,
          headers,
          body,
          retries: retries + 1,
          maxRetries,
        });
      }

      // Handle cases where mail.tm returns an HTML "NOT_FOUND" page instead of JSON
      let messageFromRemote =
        data?.detail ||
        data?.message ||
        `mail.tm request failed (${response.status})`;

      const lowerText = (text || "").toLowerCase();

      // Handle structured text errors with Code and ID fields
      if (text && !data) {
        // Check for structured error format like "404: NOT_FOUND\n\nCode: NOT_FOUND\n\nID: ..."
        const codeMatch = text.match(/Code:\s*(\w+)/i);
        const notFoundMatch = text.match(/NOT_FOUND/i);

        if (codeMatch || notFoundMatch || lowerText.includes("not_found")) {
          messageFromRemote =
            "Mailbox provider is temporarily unavailable. Please try again in a few seconds.";
        } else if (response.status === 404) {
          messageFromRemote = "Requested resource not found. Please try again.";
        } else if (response.status >= 500) {
          messageFromRemote =
            "Mailbox provider service error. Please try again in a few moments.";
        }
      } else if (
        lowerText.includes("not_found") ||
        lowerText.includes("the page could not be found") ||
        data?.code === "NOT_FOUND"
      ) {
        // Normalize the message so frontend doesn't see raw HTML / opaque IDs
        messageFromRemote =
          "Mailbox provider is temporarily unavailable. Please try again in a few seconds.";
      } else if (response.status >= 500) {
        messageFromRemote =
          "Mailbox provider service error. Please try again in a few moments.";
      }

      // Log error details for debugging (server-side only)
      console.error(`[mail.tm Error] ${pathFragment}`, {
        status: response.status,
        message: messageFromRemote,
        hasData: !!data,
        textSnippet: text ? text.slice(0, 100) : null,
        retries,
      });

      const error = new Error(messageFromRemote);
      error.status = response.status;
      error.data = data;
      // Preserve a small snippet of the raw body for server-side debugging
      if (!data && text) {
        error.rawBodySnippet = text.slice(0, 200);
      }
      throw error;
    }

    return data;
  } catch (error) {
    clearTimeout(timeoutId); // Clean up timeout
    // Handle timeout and network errors with retry
    if (
      (error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        error.name === "TypeError") &&
      retries < maxRetries
    ) {
      const delay = Math.min(1000 * Math.pow(2, retries), 5000);
      console.log(
        `[mail.tm Retry] ${pathFragment} - Network/timeout error, retrying in ${delay}ms (attempt ${
          retries + 1
        }/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return mailTmRequest(pathFragment, {
        method,
        headers,
        body,
        retries: retries + 1,
        maxRetries,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId); // Ensure cleanup happens
  }
};

const getAvailableDomains = async () => {
  const now = Date.now();
  if (cachedDomains.items.length && cachedDomains.expiresAt > now) {
    return cachedDomains.items;
  }
  try {
    const payload = await mailTmRequest("/domains");
    const domains = payload?.["hydra:member"] || [];
    cachedDomains = {
      items: domains,
      expiresAt: now + DOMAIN_CACHE_TTL_MS,
    };
    return domains;
  } catch (error) {
    // If domain fetch fails but we have cached domains, use those
    if (cachedDomains.items.length > 0) {
      console.warn(
        `[Domain Fetch Error] Using cached domains. Error: ${error.message}`
      );
      return cachedDomains.items;
    }
    // If no cached domains and fetch fails, throw
    throw error;
  }
};

const normalizeDomainEntry = (entry) => {
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  return entry.domain || entry.name || entry.address || null;
};

const listDomainStrings = (entries) =>
  entries
    .map((entry) => normalizeDomainEntry(entry))
    .filter((domain) => typeof domain === "string");

const pickMailTmDomain = async (preferredDomain) => {
  const domains = await getAvailableDomains();
  if (!domains.length) {
    throw new Error("No disposable domains available");
  }
  const domainStrings = listDomainStrings(domains);
  if (!domainStrings.length) {
    throw new Error("Domain list is empty");
  }

  if (preferredDomain) {
    const normalizedPreferred = preferredDomain.toLowerCase();
    const match = domainStrings.find(
      (domain) => domain.toLowerCase() === normalizedPreferred
    );
    if (!match) {
      const error = new Error(
        `Requested domain "${preferredDomain}" is not available. Try one of: ${domainStrings.join(
          ", "
        )}`
      );
      error.status = 422;
      error.availableDomains = domainStrings;
      throw error;
    }
    return match;
  }

  // Find all available preferred domains
  const availablePreferred = domainStrings.filter((domain) =>
    DEFAULT_PREFERRED_DOMAINS.includes(domain.toLowerCase())
  );

  if (availablePreferred.length > 0) {
    // Use round-robin rotation to ensure different domains are used
    const selectedDomain =
      availablePreferred[domainRotationIndex % availablePreferred.length];
    domainRotationIndex = (domainRotationIndex + 1) % availablePreferred.length;
    return selectedDomain;
  }

  // If no preferred domains, rotate through all available domains
  const selectedDomain =
    domainStrings[domainRotationIndex % domainStrings.length];
  domainRotationIndex = (domainRotationIndex + 1) % domainStrings.length;
  return selectedDomain;
};

// Get all available preferred domains for rotation
const getAvailablePreferredDomains = async () => {
  const domains = await getAvailableDomains();
  const domainStrings = listDomainStrings(domains);
  const preferred = domainStrings.filter((domain) =>
    DEFAULT_PREFERRED_DOMAINS.includes(domain.toLowerCase())
  );
  // Sort consistently to maintain order
  return preferred.sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
};

const authenticateMailTm = async (address, password) => {
  const body = JSON.stringify({ address, password });
  const data = await mailTmRequest("/token", { method: "POST", body });
  const expiresIn = Number(data?.expires_in) || 3600;
  return {
    token: data?.token,
    refreshToken: data?.refresh_token || null,
    tokenExpiresAt: dayjs().add(expiresIn, "second").toISOString(),
  };
};

const ensureMailTmToken = async (mailbox) => {
  if (mailbox.token && dayjs().isBefore(mailbox.tokenExpiresAt)) {
    return mailbox.token;
  }
  const auth = await authenticateMailTm(mailbox.address, mailbox.password);
  mailbox.token = auth.token;
  mailbox.refreshToken = auth.refreshToken;
  mailbox.tokenExpiresAt = auth.tokenExpiresAt;
  return mailbox.token;
};

const fetchMailboxMessages = async (mailbox) => {
  const token = await ensureMailTmToken(mailbox);
  const list = await mailTmRequest("/messages?limit=25&sort=-createdAt", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const members = list?.["hydra:member"] || [];
  if (!members.length) {
    mailbox.lastMessageCount = 0;
    return [];
  }
  // Fetch detailed messages, handling individual message errors gracefully
  const detailed = await Promise.allSettled(
    members.map((item) =>
      mailTmRequest(`/messages/${item.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
  );
  // Filter out failed requests and map successful ones
  const successfulMessages = detailed
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);

  const normalized = successfulMessages.map((message) => ({
    id: message.id,
    from: message.from?.address || message.from?.name || "unknown",
    subject: message.subject || "(no subject)",
    body: message.text || message.intro || "",
    html: Array.isArray(message.html)
      ? message.html.join("")
      : message.html || "",
    intro: message.intro,
    seen: message.seen,
    receivedAt: message.createdAt,
  }));
  mailbox.lastMessageCount = normalized.length;
  return normalized;
};

const provisionMailboxWithMailTm = async (preferredDomain) => {
  // If specific domain requested, use it
  if (preferredDomain) {
    const domain = await pickMailTmDomain(preferredDomain);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const localPart = generateLocalPart();
      const address = `${localPart}@${domain}`;
      const password = generatePassword();
      try {
        const account = await mailTmRequest("/accounts", {
          method: "POST",
          body: JSON.stringify({ address, password }),
        });
        const auth = await authenticateMailTm(address, password);
        const actualDomain = address.split("@")[1] || domain;
        return {
          accountId: account.id,
          address,
          domain: actualDomain,
          password,
          token: auth.token,
          tokenExpiresAt: auth.tokenExpiresAt,
          refreshToken: auth.refreshToken,
        };
      } catch (error) {
        if ([400, 409, 422].includes(error.status)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Unable to allocate mailbox at this time");
  }

  // Get available preferred domains
  const availablePreferred = await getAvailablePreferredDomains();
  const allDomains = await getAvailableDomains();
  const allDomainStrings = listDomainStrings(allDomains);

  // Get list of domains to try (preferred first)
  let domainsToTry =
    availablePreferred.length > 0 ? availablePreferred : allDomainStrings;

  // Sort domains consistently to maintain order (alphabetically)
  domainsToTry.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  // Ensure comfythings.com is first in the list if available
  const comfythingsIndex = domainsToTry.findIndex(
    (d) => d.toLowerCase() === "comfythings.com"
  );
  if (comfythingsIndex >= 0) {
    const comfythings = domainsToTry.splice(comfythingsIndex, 1)[0];
    domainsToTry.unshift(comfythings);
  }
  const badfistIndex = domainsToTry.findIndex(
    (d) => d.toLowerCase() === "badfist.com"
  );
  if (badfistIndex >= 0) {
    const badfist = domainsToTry.splice(badfistIndex, 1)[0];
    domainsToTry.unshift(badfist);
  }

  const besenicaIndex = domainsToTry.findIndex(
    (d) => d.toLowerCase() === "besenica.com"
  );
  if (besenicaIndex >= 0) {
    const besenica = domainsToTry.splice(besenicaIndex, 1)[0];
    domainsToTry.unshift(besenica);
  }

  const asiamailIndex = domainsToTry.findIndex(
    (d) => d.toLowerCase() === "asia-mail.com"
  );
  if (asiamailIndex >= 0) {
    const asiamail = domainsToTry.splice(asiamailIndex, 1)[0];
    domainsToTry.unshift(asiamail);
  }

  const doerIndex = domainsToTry.findIndex(
    (d) => d.toLowerCase() === "doer.sbs"
  );
  if (doerIndex >= 0) {
    const doer = domainsToTry.splice(doerIndex, 1)[0];
    domainsToTry.unshift(doer);
  }

  const ekiiIndex = domainsToTry.findIndex(
    (d) => d.toLowerCase() === "ekii.de"
  );
  if (ekiiIndex >= 0) {
    const ekii = domainsToTry.splice(ekiiIndex, 1)[0];
    domainsToTry.unshift(ekii);
  }
  const ketoblisslabsIndex = domainsToTry.findIndex(
    (d) => d.toLowerCase() === "ketoblisslabs.com"
  );
  if (ketoblisslabsIndex >= 0) {
    const ketoblisslabs = domainsToTry.splice(ketoblisslabsIndex, 1)[0];
    domainsToTry.unshift(ketoblisslabs);
  }
  const elyxstoreIndex = domainsToTry.findIndex(
    (d) => d.toLowerCase() === "elyxstore.com"
  );
  if (elyxstoreIndex >= 0) {
    const elyxstore = domainsToTry.splice(elyxstoreIndex, 1)[0];
    domainsToTry.unshift(elyxstore);
  }
  const mailtmIndex = domainsToTry.findIndex(
    (d) => d.toLowerCase() === "mail.tm"
  );
  if (mailtmIndex >= 0) {
    const mailtm = domainsToTry.splice(mailtmIndex, 1)[0];
    domainsToTry.unshift(mailtm);
  }

  if (domainsToTry.length === 0) {
    throw new Error("No domains available");
  }

  // Try domains in rotation order, skipping rate-limited domains
  const maxDomainsToTry = Math.min(domainsToTry.length, 15); // Try up to 15 different domains
  let startIndex = domainRotationIndex % domainsToTry.length;
  let rateLimitedDomains = 0;

  // Log for debugging
  console.log(
    `[Domain Rotation] Starting at index: ${startIndex}, Total domains: ${domainsToTry.length}`
  );

  // Try multiple domains if rate limited
  for (let domainOffset = 0; domainOffset < maxDomainsToTry; domainOffset++) {
    const currentIndex = (startIndex + domainOffset) % domainsToTry.length;
    const domain = domainsToTry[currentIndex];

    console.log(
      `[Domain Rotation] Trying domain ${
        domainOffset + 1
      }/${maxDomainsToTry}: ${domain}`
    );

    // Try this domain up to 2 times (reduced from 3 to fail faster and try next)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const localPart = generateLocalPart();
      const address = `${localPart}@${domain}`;
      const password = generatePassword();

      try {
        const account = await mailTmRequest("/accounts", {
          method: "POST",
          body: JSON.stringify({ address, password }),
        });
        const auth = await authenticateMailTm(address, password);
        const actualDomain = address.split("@")[1] || domain;

        // Increment rotation for next request (so next request gets next domain)
        domainRotationIndex = (domainRotationIndex + 1) % domainsToTry.length;

        console.log(
          `[Domain Rotation] Success with domain: ${domain}, Next index: ${domainRotationIndex}`
        );

        return {
          accountId: account.id,
          address,
          domain: actualDomain,
          password,
          token: auth.token,
          tokenExpiresAt: auth.tokenExpiresAt,
          refreshToken: auth.refreshToken,
        };
      } catch (error) {
        // If server error (500+), try next domain with delay
        if (error.status >= 500) {
          console.log(
            `[Domain Rotation] Server error (${error.status}) on ${domain}, trying next domain...`
          );
          // Add delay before trying next domain for server errors
          if (domainOffset < maxDomainsToTry - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, 200 + Math.random() * 300)
            );
          }
          break; // Break inner loop, try next domain
        }

        // If rate limited (429), add delay and try next domain
        if (error.status === 429) {
          rateLimitedDomains++;
          console.log(
            `[Domain Rotation] Rate limited (429) on ${domain} (${rateLimitedDomains} rate-limited so far), trying next domain...`
          );

          // Add small delay before trying next domain (100-300ms random)
          if (domainOffset < maxDomainsToTry - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, 100 + Math.random() * 200)
            );
          }
          break; // Break inner loop, try next domain
        }

        // If domain-specific error (422 with rate message), try next domain
        if (
          error.status === 422 &&
          (error.data?.detail?.includes("rate") ||
            error.data?.detail?.includes("limit") ||
            error.data?.message?.includes("rate") ||
            error.data?.message?.includes("limit"))
        ) {
          rateLimitedDomains++;
          console.log(
            `[Domain Rotation] Domain limit reached (422) on ${domain} (${rateLimitedDomains} rate-limited so far), trying next domain...`
          );

          // Add small delay before trying next domain
          if (domainOffset < maxDomainsToTry - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, 100 + Math.random() * 200)
            );
          }
          break;
        }

        if ([400, 409].includes(error.status)) {
          if (attempt < 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          continue;
        }

        console.log(
          `[Domain Rotation] Error ${error.status} on ${domain}, trying next domain...`
        );
        break;
      }
    }
  }

  domainRotationIndex = (domainRotationIndex + 1) % domainsToTry.length;

  // Check if we had server errors (500+) vs rate limits
  let errorMessage;
  if (rateLimitedDomains >= maxDomainsToTry - 2) {
    errorMessage =
      "Unable to allocate mailbox. All domains are currently rate-limited. Please wait a few seconds and try again.";
  } else {
    errorMessage =
      "Unable to allocate mailbox at this time. The email service may be temporarily unavailable. Please try again in a few moments.";
  }

  console.error(
    `[Domain Rotation] Failed after trying ${maxDomainsToTry} domains. ${rateLimitedDomains} were rate-limited.`
  );
  throw new Error(errorMessage);
};

// Security middleware
if (isProduction) {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
}

// Compression middleware
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 100 : 1000, // Limit each IP to 100 requests per windowMs in production
  message: {
    error: "Too many requests from this IP, please try again later.",
    status: 429,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/", limiter);

// CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    if (CORS_ORIGIN === "*") {
      callback(null, true);
    } else if (!origin) {
      callback(null, true); // Allow requests with no origin (mobile apps, curl, etc.)
    } else {
      const allowedOrigins = CORS_ORIGIN.split(",").map((o) => o.trim());
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  credentials: false,
  maxAge: 86400, // 24 hours
};

app.use(cors(corsOptions));

// Body parsing middleware
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// Only serve static files in non-serverless environments

if (!isVercel) {
  const staticPath = isProduction
    ? path.join(__dirname, "dist")
    : path.join(__dirname, "public");
  app.use(express.static(staticPath));
}

// Root endpoint
app.get("/", (_req, res) => {
  res.json({
    message: "Temp Mail API",
    status: "running",
    version: "1.0.0",
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    mailboxes: mailboxes.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: isProduction ? "production" : "development",
  });
});

const buildMailboxResponse = (mailbox) => ({
  mailboxId: mailbox.mailboxId,
  address: mailbox.address,
  domain: mailbox.domain,
  createdAt: mailbox.createdAt,
  expiresAt: mailbox.expiresAt,
  messageCount: mailbox.lastMessageCount || 0,
});

const ensureMailbox = (mailboxId) => {
  const mailbox = mailboxes.get(mailboxId);
  if (!mailbox) {
    console.warn(
      `[Mailbox Not Found] ${mailboxId} (total mailboxes: ${mailboxes.size})`
    );
    const error = new Error("Mailbox not found or expired");
    error.status = 404;
    throw error;
  }
  if (dayjs().isAfter(mailbox.expiresAt)) {
    mailboxes.delete(mailboxId);
    console.log(`[Mailbox Expired] ${mailboxId}`);
    const error = new Error("Mailbox expired");
    error.status = 410;
    throw error;
  }
  return mailbox;
};

const createMailbox = async (preferredDomain) => {
  const remote = await provisionMailboxWithMailTm(preferredDomain);
  const mailboxId = uuid();
  const createdAt = dayjs().toISOString();
  const expiresAt = dayjs(createdAt)
    .add(MAILBOX_TTL_MINUTES, "minute")
    .toISOString();
  const mailbox = {
    mailboxId,
    address: remote.address,
    domain: remote.domain,
    createdAt,
    expiresAt,
    password: remote.password,
    accountId: remote.accountId,
    token: remote.token,
    tokenExpiresAt: remote.tokenExpiresAt,
    refreshToken: remote.refreshToken,
    lastMessageCount: 0,
  };
  mailboxes.set(mailboxId, mailbox);
  return mailbox;
};

setInterval(() => {
  const now = dayjs();
  mailboxes.forEach((mailbox, mailboxId) => {
    if (now.isAfter(mailbox.expiresAt)) {
      mailboxes.delete(mailboxId);
    }
  });
}, CLEANUP_INTERVAL_MS).unref();

app.post("/api/mailboxes", async (req, res, next) => {
  try {
    const preferredDomain = req.body?.domain || null;
    console.log(
      `[Mailbox Creation Request] domain: ${preferredDomain || "none"}`
    );
    const mailbox = await createMailbox(preferredDomain);
    console.log(`[Mailbox Created] ${mailbox.mailboxId} -> ${mailbox.address}`);
    res.status(201).json(buildMailboxResponse(mailbox));
  } catch (error) {
    console.error("[Mailbox Creation Error]", {
      message: error.message,
      status: error.status,
      stack: error.stack?.split("\n").slice(0, 5).join("\n"),
    });
    next(error);
  }
});

app.get("/api/mailboxes/:mailboxId", (req, res, next) => {
  try {
    const mailbox = ensureMailbox(req.params.mailboxId);
    res.json(buildMailboxResponse(mailbox));
  } catch (error) {
    next(error);
  }
});

app.get("/api/mailboxes/:mailboxId/messages", async (req, res, next) => {
  try {
    const mailbox = ensureMailbox(req.params.mailboxId);
    const messages = await fetchMailboxMessages(mailbox);
    res.json({
      mailbox: buildMailboxResponse(mailbox),
      messages,
    });
  } catch (error) {
    console.error(
      `[Messages Fetch Error] ${req.params.mailboxId}:`,
      error.message,
      error.status
    );
    next(error);
  }
});

app.post("/api/mailboxes/:mailboxId/messages", (req, res, next) => {
  try {
    ensureMailbox(req.params.mailboxId);
    res.status(501).json({
      error:
        "Sending emails via API is not supported. Send from any email client to this address.",
      status: 501,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mailboxes/:mailboxId/extend", (req, res, next) => {
  try {
    const mailbox = ensureMailbox(req.params.mailboxId);
    mailbox.expiresAt = dayjs()
      .add(MAILBOX_TTL_MINUTES, "minute")
      .toISOString();
    res.json(buildMailboxResponse(mailbox));
  } catch (error) {
    next(error);
  }
});

// 404 handler for non-API routes (must come before error handler)
app.use((req, res) => {
  // In serverless environment, return JSON 404 for all non-matched routes
  res.status(404).json({
    error: "Not found",
    status: 404,
    message: "This is an API-only backend. Use /api/* endpoints.",
    path: req.path,
    availableEndpoints: [
      "GET /api/health",
      "POST /api/mailboxes",
      "GET /api/mailboxes/:mailboxId",
      "GET /api/mailboxes/:mailboxId/messages",
      "POST /api/mailboxes/:mailboxId/extend",
    ],
  });
});

// Error handler (must be last, has 4 parameters)
app.use((err, req, res, _next) => {
  const status = err.status || 500;

  // Sanitize error messages to remove technical details like IDs
  let errorMessage = err.message || "Unexpected error";

  // Handle mail.tm specific error messages
  if (errorMessage.includes("mail.tm request failed")) {
    const statusMatch = errorMessage.match(/\((\d+)\)/);
    const errorStatus = statusMatch ? parseInt(statusMatch[1]) : status;

    if (errorStatus >= 500) {
      errorMessage =
        "Mailbox provider service error. Please try again in a few moments.";
    } else if (errorStatus === 404) {
      errorMessage =
        "Mailbox provider is temporarily unavailable. Please try again in a few seconds.";
    } else {
      errorMessage = "Unable to create mailbox at this time. Please try again.";
    }
  }

  // Remove technical error IDs and codes from error messages
  if (errorMessage.includes("ID:") || errorMessage.includes("Code:")) {
    // If error contains structured format like "404: NOT_FOUND\n\nCode: NOT_FOUND\n\nID: ..."
    if (errorMessage.includes("NOT_FOUND") || status === 404) {
      errorMessage = "The requested resource was not found. Please try again.";
    } else if (errorMessage.toLowerCase().includes("not_found")) {
      errorMessage =
        "Mailbox provider is temporarily unavailable. Please try again in a few seconds.";
    } else {
      // Extract just the main error message, remove ID and Code lines
      errorMessage = errorMessage.split("\n")[0].replace(/^\d+:\s*/, "");
    }
  }

  // Log full error details server-side for debugging
  if (status >= 500) {
    console.error("[Server Error]", {
      path: req.path,
      method: req.method,
      message: err.message,
      status: err.status,
      stack: err.stack?.split("\n").slice(0, 10).join("\n"),
    });
  }

  res.status(status).json({
    error: errorMessage,
    status,
  });
});

// Only add catch-all route for static file serving in non-serverless production
if (isProduction && !isVercel) {
  // In Express 5 / path-to-regexp v6, bare "*" is not a valid path pattern.
  // Use a catch-all pattern compatible with the newer matcher instead.
  app.get("/*", (_req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

// Export for Vercel serverless functions
export default app;

// Start server only if not in serverless environment (local development)
if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`Temp mail service listening on http://localhost:${PORT}`);
    console.log(`Environment: ${isProduction ? "production" : "development"}`);
    if (isProduction) {
      console.log(
        `CORS Origin: ${
          CORS_ORIGIN === "*" ? "All origins allowed" : CORS_ORIGIN
        }`
      );
    }
  });
}
