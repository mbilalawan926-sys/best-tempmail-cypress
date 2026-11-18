"use strict";

/* ============================================================================
 *  The Node side: registers the tasks the browser-side commands call.
 * ==========================================================================*/

const { createClient, ApiError, NoMessageError } = require("./api");

/**
 * Work out the API key, and keep it out of the browser.
 *
 * Cypress ships `config.env` to the browser, where it is readable through
 * Cypress.env() and ends up in the runner UI, in screenshots and in videos. So
 * the preferred source is process.env, which never leaves Node.
 *
 * If a key is found in config.env anyway, it is used and then DELETED from the
 * config this function returns, so it is not sent to the browser. That is worth
 * doing silently-but-noisily: a warning, because the key was still exposed to
 * anything else reading cypress.env.json, and a deletion, because there is no
 * reason to make it worse.
 */
function resolveApiKey(config, explicit) {
  if (explicit) return explicit;

  if (process.env.BTM_API_KEY) return process.env.BTM_API_KEY;

  if (config && config.env && config.env.BTM_API_KEY) {
    const key = config.env.BTM_API_KEY;
    delete config.env.BTM_API_KEY;
    // eslint-disable-next-line no-console
    console.warn(
      "[best-tempmail] Found BTM_API_KEY in Cypress env. Using it, and removing it from the\n" +
        "              config so it is not sent to the browser. Prefer the BTM_API_KEY\n" +
        "              environment variable: anything in Cypress env is readable from the\n" +
        "              browser context and appears in screenshots and videos."
    );

    return key;
  }

  return null;
}

/**
 * Errors have to cross the task boundary, where only plain data survives: an
 * Error's name, status and custom fields are lost, leaving an unhelpful
 * "[object Object]" or a bare message.
 *
 * So failures are returned as a tagged plain object and rethrown on the browser
 * side with their detail intact.
 */
function serializeError(err) {
  const base = {
    __btmError: true,
    name: err && err.name ? err.name : "Error",
    message: err && err.message ? err.message : String(err),
  };

  if (err instanceof ApiError) {
    return {
      ...base,
      status: err.status,
      detail: err.detail,
      requestId: err.requestId,
      upgrade: err.upgrade,
      retryAfter: err.retryAfter,
    };
  }

  if (err instanceof NoMessageError) {
    return { ...base, address: err.address, waitedMs: err.waitedMs };
  }

  return base;
}

const wrap = (fn) => async (arg) => {
  try {
    return await fn(arg ?? {});
  } catch (err) {
    return serializeError(err);
  }
};

/**
 * Register the best-tempmail tasks.
 *
 * In cypress.config.js:
 *
 *     const { bestTempMail } = require("best-tempmail-cypress");
 *
 *     module.exports = defineConfig({
 *       e2e: {
 *         setupNodeEvents(on, config) {
 *           return bestTempMail(on, config);
 *         },
 *       },
 *     });
 *
 * Returning the config matters: that is how the API key gets stripped from it,
 * and how any other plugin's changes survive.
 *
 * @param {Function} on      Cypress's `on`
 * @param {object}   config  Cypress's resolved config
 * @param {object}   [options]
 * @param {string}   [options.apiKey]   Overrides both environment sources
 * @param {string}   [options.baseUrl]  For testing against a mock
 */
function bestTempMail(on, config, options = {}) {
  if (typeof on !== "function") {
    throw new Error(
      "best-tempmail: bestTempMail(on, config) needs Cypress's `on`. Call it inside setupNodeEvents."
    );
  }

  const apiKey = resolveApiKey(config, options.apiKey);
  const client = createClient({ apiKey, baseUrl: options.baseUrl });

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      "[best-tempmail] No API key found, so the free tier applies: 3 inboxes per day per IP,\n" +
        "              and no OTP or link extraction. On CI that per-IP quota is shared with\n" +
        "              every other job on the runner and is usually gone already. Set\n" +
        "              BTM_API_KEY in the environment."
    );
  }

  on("task", {
    "btm:createInbox": wrap((arg) => client.createInbox(arg)),
    "btm:bulkCreateInboxes": wrap((arg) => client.bulkCreateInboxes(arg)),
    "btm:inbox": wrap(({ address }) => client.inbox(address)),
    "btm:deleteInbox": wrap(({ address }) => client.deleteInbox(address)),
    "btm:deleteInboxes": wrap(async ({ addresses }) => {
      const results = [];
      for (const address of addresses ?? []) {
        try {
          results.push(await client.deleteInbox(address));
        } catch (err) {
          // Cleanup must not fail a passing run. Record and move on.
          results.push({ address, deleted: false, error: err.message });
        }
      }

      return { results };
    }),
    "btm:messages": wrap(({ address, filter }) => client.messages(address, filter ?? {})),
    "btm:message": wrap(({ address, messageId }) => client.message(address, messageId)),
    "btm:otp": wrap(({ address, messageId }) => client.otp(address, messageId)),
    "btm:links": wrap(({ address, messageId }) => client.links(address, messageId)),
    "btm:waitForMessage": wrap(({ address, options: opts }) =>
      client.waitForMessage(address, opts ?? {})
    ),
    "btm:waitForOtp": wrap(({ address, options: opts }) =>
      client.waitForOtp(address, opts ?? {})
    ),
    "btm:waitForCode": wrap(async ({ address, options: opts }) => ({
      code: await client.waitForCode(address, opts ?? {}),
    })),
    "btm:waitForLinks": wrap(({ address, options: opts }) =>
      client.waitForLinks(address, opts ?? {})
    ),
    "btm:waitForActionUrl": wrap(async ({ address, options: opts }) => ({
      url: await client.waitForActionUrl(address, opts ?? {}),
    })),
    "btm:usage": wrap(() => client.usage()),
    "btm:domains": wrap(async () => ({ domains: await client.domains() })),
    "btm:health": wrap(() => client.health()),
  });

  return config;
}

module.exports = { bestTempMail, serializeError, resolveApiKey };
