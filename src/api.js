"use strict";

/* ============================================================================
 *  The HTTP client. Runs in Cypress's NODE process, never in the browser.
 *
 *  That placement is deliberate and is the main reason this plugin exists
 *  rather than people calling cy.request directly:
 *
 *   1. The API key stays in Node. Anything reachable from the browser context
 *      is visible in the Cypress runner, in screenshots and in videos, and
 *      Cypress.env is sent to the browser. A key in a task is not.
 *   2. cy.request is bound by responseTimeout, which defaults to 30 seconds.
 *      A long poll holds the connection for up to 55, so cy.request would cut
 *      it off mid-wait and report a timeout that looks like a network fault.
 *   3. Everything crossing the task boundary is serialized, so this module
 *      returns plain JSON-safe objects: no Date instances, no classes. Dates
 *      stay as ISO strings.
 *
 *  No dependencies.
 * ==========================================================================*/

const DEFAULT_BASE_URL = "https://api.best-tempmail.com/v1";

/** The server caps one wait at 55s; stay under it rather than asking for more. */
const MAX_SERVER_WAIT = 50;

/** Gap between polls when a filter rules out the long-poll endpoint. */
const FILTERED_POLL_INTERVAL_MS = 2000;

class ApiError extends Error {
  constructor(status, detail, extra = {}) {
    let message = `best-tempmail: HTTP ${status}: ${detail}`;
    if (extra.retryAfter) message += ` (retry after ${extra.retryAfter}s)`;
    if (extra.upgrade) message += ` (see ${extra.upgrade})`;
    // The request id belongs in the message: it is the only thing a support
    // email can usefully quote.
    if (extra.requestId) message += ` [request ${extra.requestId}]`;

    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.requestId = extra.requestId ?? null;
    this.upgrade = extra.upgrade ?? null;
    this.retryAfter = extra.retryAfter ?? null;
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isPaymentRequired() {
    return this.status === 402;
  }

  /**
   * The inbox or message does not exist, has expired, or belongs to another
   * key. That last case is deliberate on the server's part: a 403 would confirm
   * the address exists and let someone probe for live addresses.
   */
  get isNotFound() {
    return this.status === 404;
  }

  get isRateLimited() {
    return this.status === 429;
  }
}

class NoMessageError extends Error {
  constructor(address, waitedMs) {
    super(
      `best-tempmail: no matching message arrived at ${address} within ${(waitedMs / 1000).toFixed(1)}s`
    );
    this.name = "NoMessageError";
    this.address = address;
    this.waitedMs = waitedMs;
  }
}

/* ------------------------------------------------------------------ mapping */

/**
 * Addresses contain @ and may contain +. The @ is left literal, which is the
 * form the published examples use, and everything else is encoded so a plus in
 * a plus-addressed inbox cannot be read as an encoded space.
 */
const escapeAddress = (address) =>
  encodeURIComponent(address).replace(/%40/g, "@");

const mapInbox = (raw = {}) => ({
  address: raw.address ?? "",
  createdAt: raw.created_at ?? null,
  expiresAt: raw.expires_at ?? null,
  lifetimeMinutes: raw.lifetime_minutes ?? null,
  // Set when the server clamped the requested lifetime to the plan maximum.
  // It creates the inbox anyway, so this is the only warning that it expires
  // sooner than asked.
  note: raw.note ?? null,
});

const mapSummary = (raw = {}) => ({
  id: raw.id ?? "",
  from: raw.from ?? "",
  subject: raw.subject ?? "",
  date: raw.date ?? null,
  hasAttachments: Boolean(raw.has_attachments),
});

const mapAttachment = (raw = {}) => ({
  index: raw.index ?? 0,
  filename: raw.filename ?? "",
  mime: raw.mime ?? "application/octet-stream",
  size: raw.size ?? 0,
  downloadable: Boolean(raw.downloadable),
  requiresPlan: raw.requires_plan ?? null,
});

const mapMessage = (raw = {}) => ({
  ...mapSummary(raw),
  to: raw.to ?? "",
  text: raw.text ?? "",
  html: raw.html ?? "",
  attachments: (raw.attachments ?? []).map(mapAttachment),
});

const mapList = (raw = {}) => ({
  address: raw.address ?? "",
  messages: (raw.messages ?? []).map(mapSummary),
  limit: raw.limit ?? 0,
  offset: raw.offset ?? 0,
  returned: raw.returned ?? (raw.messages ?? []).length,
  hasMore: Boolean(raw.has_more),
  // scanned and scanLimitReached are what make an empty result interpretable:
  // empty with scanLimitReached false means nothing matches, definitively.
  scanned: raw.scanned ?? 0,
  scanLimitReached: Boolean(raw.scan_limit_reached),
});

const mapOtp = (raw = {}) => ({
  messageId: raw.message_id ?? "",
  // A string, not a number: "004007" is a real code from this API and 4007
  // would fail the form.
  code: typeof raw.code === "string" ? raw.code : "",
  confidence: raw.confidence ?? "none",
  candidates: (raw.candidates ?? []).map((c) => ({
    code: c.code ?? "",
    score: c.score ?? 0,
  })),
});

const mapLinks = (raw = {}) => ({
  messageId: raw.message_id ?? "",
  actionUrl: typeof raw.action_url === "string" ? raw.action_url : "",
  confidence: raw.confidence ?? "none",
  links: (raw.links ?? []).map((l) => ({
    url: l.url ?? "",
    unwrappedUrl: l.unwrapped_url ?? null,
    text: l.text ?? "",
    type: l.type ?? "other",
    score: l.score ?? 0,
    // The real target, so callers do not have to remember the fallback.
    destination: l.unwrapped_url ?? l.url ?? "",
  })),
});

const mapUsage = (raw = {}) => ({
  plan: raw.plan ?? "free",
  paid: Boolean(raw.paid),
  hourly: {
    limit: raw.hourly?.limit ?? 0,
    used: raw.hourly?.used ?? 0,
    remaining: raw.hourly?.remaining ?? 0,
    resetsAt: raw.hourly?.resets_at ?? null,
    resetsInSeconds: raw.hourly?.resets_in_seconds ?? 0,
  },
  lifetimeRequests: raw.lifetime_requests ?? 0,
  key: raw.key
    ? {
        id: raw.key.id ?? 0,
        // The key itself is never returned, only its last four characters.
        lastFour: raw.key.last_four ?? "",
        status: raw.key.status ?? "",
        createdAt: raw.key.created_at ?? null,
        lastUsedAt: raw.key.last_used_at ?? null,
      }
    : null,
  subscription: raw.subscription
    ? {
        status: raw.subscription.status ?? "",
        expiresAt: raw.subscription.expires_at ?? null,
        daysRemaining: raw.subscription.days_remaining ?? 0,
        inGracePeriod: Boolean(raw.subscription.in_grace_period),
      }
    : null,
  // Null means no daily cap applies; zero means the cap applies and none have
  // been used. They are not the same thing.
  inboxesCreatedToday:
    raw.inboxes_created_today === undefined ? null : raw.inboxes_created_today,
  upgradeUrl: raw.upgrade ?? null,
});

/* ------------------------------------------------------------------- client */

function createClient(options = {}) {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = options.apiKey ?? null;
  const defaultTimeoutMs = options.timeoutMs ?? 30000;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error(
      "best-tempmail: no fetch available. Node 18 or newer is required, or pass your own via options.fetch."
    );
  }

  async function call(method, path, { query, body, timeoutMs } = {}) {
    let url = baseUrl + path;
    if (query) {
      const params = new URLSearchParams(query);
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers = { Accept: "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    if (body) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const limit = timeoutMs ?? defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), limit);

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      // An aborted request and a DNS failure are both "we never reached the
      // API", which is a different thing from the API refusing us.
      const reason =
        err && err.name === "AbortError"
          ? `no response within ${limit}ms`
          : (err && err.message) || String(err);
      throw new Error(`best-tempmail: could not reach ${url}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = null;
    }

    if (!res.ok) {
      const retryAfterHeader = res.headers.get("retry-after");
      let detail =
        (json && (json.error || json.message)) ||
        (text ? text.slice(0, 200) : "the response carried no explanation");

      throw new ApiError(res.status, detail, {
        requestId: (json && json.request_id) || res.headers.get("x-request-id"),
        upgrade: json && json.upgrade,
        retryAfter:
          retryAfterHeader && /^\d+$/.test(retryAfterHeader)
            ? Number(retryAfterHeader)
            : null,
      });
    }

    return json ?? {};
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Build the query for a message listing, validating what the server would reject. */
  function listQuery(filter = {}) {
    const query = {};
    if (filter.limit !== undefined && filter.limit !== null) {
      if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 200) {
        throw new Error(
          `best-tempmail: limit must be a whole number between 1 and 200, got ${filter.limit}`
        );
      }
      query.limit = String(filter.limit);
    }
    if (filter.offset !== undefined && filter.offset !== null) {
      if (!Number.isInteger(filter.offset) || filter.offset < 0 || filter.offset > 5000) {
        throw new Error(
          `best-tempmail: offset must be a whole number between 0 and 5000, got ${filter.offset}`
        );
      }
      query.offset = String(filter.offset);
    }
    if (filter.from) query.from = filter.from;
    if (filter.subject) query.subject = filter.subject;
    if (filter.q) query.q = filter.q;
    if (filter.since) query.since = filter.since;
    if (filter.until) query.until = filter.until;
    if (filter.hasAttachments !== undefined && filter.hasAttachments !== null) {
      query.has_attachments = filter.hasAttachments ? "true" : "false";
    }

    return query;
  }

  const isFiltering = (filter = {}) =>
    Boolean(
      filter.from ||
        filter.subject ||
        filter.q ||
        filter.since ||
        filter.until ||
        filter.hasAttachments !== undefined && filter.hasAttachments !== null
    );

  async function longPollOnce(address, seconds) {
    const data = await call("GET", `/inboxes/${escapeAddress(address)}/wait`, {
      query: { timeout: String(seconds) },
      // Above the wait itself: an HTTP timeout below the long poll would cut
      // it off mid-flight and look like a network fault.
      timeoutMs: seconds * 1000 + 15000,
    });

    if (data.timed_out === true) return null;

    return data.message ? mapSummary(data.message) : null;
  }

  return {
    ApiError,
    NoMessageError,

    async createInbox(options = {}) {
      const body = {};
      if (options.username) body.username = options.username;
      if (options.domain) body.domain = options.domain;
      if (options.lifetimeMinutes) body.lifetime_minutes = options.lifetimeMinutes;

      const data = await call("POST", "/inboxes", {
        body: Object.keys(body).length ? body : undefined,
      });

      const inbox = mapInbox(data);
      if (!inbox.address) {
        throw new Error(
          "best-tempmail: an inbox was created but the response carried no address"
        );
      }

      return inbox;
    },

    async bulkCreateInboxes(options = {}) {
      const count = typeof options === "number" ? options : options.count;
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        throw new Error(
          `best-tempmail: count must be a whole number between 1 and 50, got ${count}`
        );
      }

      const body = { count };
      if (options.domain) body.domain = options.domain;
      if (options.lifetimeMinutes) body.lifetime_minutes = options.lifetimeMinutes;

      const data = await call("POST", "/inboxes/bulk", { body });

      return {
        count: data.count ?? 0,
        // Each inbox costs one request of quota, so 25 charges 25.
        quotaCharged: data.quota_charged ?? 0,
        lifetimeMinutes: data.lifetime_minutes ?? null,
        inboxes: (data.inboxes ?? []).map(mapInbox),
        addresses: (data.inboxes ?? []).map((i) => i.address),
      };
    },

    async inbox(address) {
      const data = await call("GET", `/inboxes/${escapeAddress(address)}`);

      return {
        address: data.address ?? "",
        createdAt: data.created_at ?? null,
        expiresAt: data.expires_at ?? null,
        messageCount: data.message_count ?? 0,
      };
    },

    /**
     * Delete an inbox. A missing inbox is not an error, so cleanup can run
     * unconditionally: anything that turns a passing test red for tidying up
     * after itself is a bad trade.
     */
    async deleteInbox(address) {
      try {
        await call("DELETE", `/inboxes/${escapeAddress(address)}`);

        return { address, deleted: true };
      } catch (err) {
        if (err instanceof ApiError && err.isNotFound) {
          return { address, deleted: false, alreadyGone: true };
        }
        throw err;
      }
    },

    async messages(address, filter = {}) {
      const data = await call("GET", `/inboxes/${escapeAddress(address)}/messages`, {
        query: listQuery(filter),
      });

      return mapList(data);
    },

    async message(address, messageId) {
      const data = await call(
        "GET",
        `/inboxes/${escapeAddress(address)}/messages/${encodeURIComponent(messageId)}`
      );

      return mapMessage(data.message ?? data);
    },

    async otp(address, messageId) {
      return mapOtp(
        await call(
          "GET",
          `/inboxes/${escapeAddress(address)}/messages/${encodeURIComponent(messageId)}/otp`
        )
      );
    },

    async links(address, messageId) {
      return mapLinks(
        await call(
          "GET",
          `/inboxes/${escapeAddress(address)}/messages/${encodeURIComponent(messageId)}/links`
        )
      );
    },

    async usage() {
      return mapUsage(await call("GET", "/usage"));
    },

    async domains() {
      const data = await call("GET", "/domains");

      return data.domains ?? [];
    },

    async health() {
      const data = await call("GET", "/health");

      return { status: data.status ?? "", version: data.version ?? "" };
    },

    /**
     * Wait for a message to be in the inbox.
     *
     * It checks what is ALREADY there before waiting for anything new, and that
     * ordering is the whole point.
     *
     * The long-poll endpoint signals mail ARRIVING. A message that landed
     * before the call started is invisible to it, and in a Cypress test that is
     * the normal case: cy.visit, fill the form, submit, and the email is often
     * delivered before the next command runs. A wait that only long-polls then
     * burns its whole timeout while the message sits there already.
     *
     * Not hypothetical: the GitHub Action for this API shipped with 21 passing
     * tests and failed on the first real email for exactly this reason.
     *
     * With a filter it polls the listing instead, because the long poll cannot
     * filter and would return the first message to arrive whether or not it is
     * the one wanted. In a real signup a welcome email often beats the
     * verification email by a second.
     */
    async waitForMessage(address, options = {}) {
      const timeoutMs = options.timeoutMs ?? 60000;
      const filter = {
        limit: 1,
        from: options.from,
        subject: options.subject,
        q: options.q,
      };

      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;

      const existing = await this.messages(address, filter);
      if (existing.messages.length) return existing.messages[0];

      const filtered = isFiltering(filter);

      while (Date.now() < deadline) {
        if (filtered) {
          await sleep(Math.min(FILTERED_POLL_INTERVAL_MS, deadline - Date.now()));
          const found = await this.messages(address, filter);
          if (found.messages.length) return found.messages[0];
          continue;
        }

        const remaining = Math.ceil((deadline - Date.now()) / 1000);
        const seconds = Math.max(1, Math.min(MAX_SERVER_WAIT, remaining));
        const message = await longPollOnce(address, seconds);
        if (message) return message;
      }

      throw new NoMessageError(address, Date.now() - startedAt);
    },

    async waitForOtp(address, options = {}) {
      const message = await this.waitForMessage(address, options);

      return this.otp(address, message.id);
    },

    /**
     * The one-liner most tests want. Throws when the message arrives with no
     * recognisable code, because a caller asking for a bare string has nowhere
     * to put that and would otherwise type an empty string into the form.
     */
    async waitForCode(address, options = {}) {
      const otp = await this.waitForOtp(address, options);
      if (!otp.code) {
        throw new Error(
          `best-tempmail: message ${otp.messageId} arrived but no verification code could be extracted from it (confidence ${otp.confidence})`
        );
      }

      return otp.code;
    },

    async waitForLinks(address, options = {}) {
      const message = await this.waitForMessage(address, options);

      return this.links(address, message.id);
    },

    async waitForActionUrl(address, options = {}) {
      const links = await this.waitForLinks(address, options);
      if (!links.actionUrl) {
        throw new Error(
          `best-tempmail: message ${links.messageId} arrived but no clear call-to-action link was found in it (confidence ${links.confidence})`
        );
      }

      return links.actionUrl;
    },
  };
}

module.exports = {
  createClient,
  ApiError,
  NoMessageError,
  DEFAULT_BASE_URL,
  escapeAddress,
};
