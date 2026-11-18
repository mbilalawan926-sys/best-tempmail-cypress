"use strict";

/* ============================================================================
 *  The browser side: custom commands wrapping the tasks.
 * ==========================================================================*/

/** Default wait, matching the Node side. */
const DEFAULT_WAIT_MS = 60000;

/**
 * Cypress's own task timeout defaults to 60 seconds, so a 60-second wait would
 * race it and fail for the wrong reason. Every waiting command therefore asks
 * for its own timeout, with headroom above the wait itself.
 */
const taskTimeout = (waitMs) => waitMs + 20000;

/**
 * Rethrow an error the Node side sent back as plain data.
 *
 * Tasks cannot reject with a real Error without losing everything except the
 * message, so failures come back tagged and are turned back into throws here,
 * with the status, request id and upgrade link still attached.
 */
function unwrap(result) {
  if (result && result.__btmError) {
    const error = new Error(result.message);
    error.name = result.name;
    for (const field of [
      "status",
      "detail",
      "requestId",
      "upgrade",
      "retryAfter",
      "address",
      "waitedMs",
    ]) {
      if (result[field] !== undefined) error[field] = result[field];
    }
    throw error;
  }

  return result;
}

/**
 * Register the commands, and by default an afterEach that deletes every inbox
 * the test created.
 *
 * In cypress/support/e2e.js:
 *
 *     require("best-tempmail-cypress/commands");
 *
 * or, to configure it:
 *
 *     const { registerBestTempMailCommands } = require("best-tempmail-cypress/commands");
 *     registerBestTempMailCommands({ prefix: "btm" });
 *
 * @param {object}  [options]
 * @param {boolean} [options.autoCleanup=true]  Delete created inboxes after each test
 * @param {string}  [options.prefix]            Rename the commands, e.g. "btm" gives
 *                                              cy.btmCreateInbox. For a project that
 *                                              already has a command of the same name.
 */
function registerBestTempMailCommands(options = {}) {
  const { autoCleanup = true, prefix } = options;

  /* globals Cypress, cy, afterEach */
  if (typeof Cypress === "undefined" || typeof cy === "undefined") {
    throw new Error(
      "best-tempmail: the commands must be registered from a Cypress support file, " +
        "where `cy` and `Cypress` exist. In cypress.config.js you want bestTempMail(on, config) instead."
    );
  }

  /**
   * Inboxes created during the current test, so they can be cleaned up.
   *
   * Deliberately not a module variable: Cypress reloads the spec bundle
   * between specs, and a module variable would quietly leak addresses across
   * them. Cypress.env is per-run state the framework itself manages.
   */
  const created = () => {
    if (!Cypress.env("__btmCreatedInboxes")) Cypress.env("__btmCreatedInboxes", []);

    return Cypress.env("__btmCreatedInboxes");
  };

  const remember = (address) => {
    if (address) created().push(address);
  };

  const name = (base) => {
    if (!prefix) return base;

    return prefix + base.charAt(0).toUpperCase() + base.slice(1);
  };

  const add = (base, fn, commandOptions) =>
    Cypress.Commands.add(name(base), commandOptions ?? {}, fn);

  /* -------------------------------------------------------------- inboxes */

  add("createInbox", (createOptions = {}) =>
    cy
      .task("btm:createInbox", createOptions, { log: false })
      .then(unwrap)
      .then((inbox) => {
        remember(inbox.address);
        Cypress.log({
          name: "createInbox",
          message: inbox.address,
          consoleProps: () => ({ inbox }),
        });

        return inbox;
      })
  );

  add("bulkCreateInboxes", (bulkOptions) =>
    cy
      .task("btm:bulkCreateInboxes", bulkOptions, { log: false })
      .then(unwrap)
      .then((batch) => {
        for (const address of batch.addresses ?? []) remember(address);
        Cypress.log({
          name: "bulkCreateInboxes",
          message: `${batch.count} inboxes, ${batch.quotaCharged} requests of quota`,
          consoleProps: () => ({ batch }),
        });

        return batch;
      })
  );

  add("getInbox", (address) =>
    cy.task("btm:inbox", { address }, { log: false }).then(unwrap)
  );

  add("deleteInbox", (address) =>
    cy.task("btm:deleteInbox", { address }, { log: false }).then(unwrap)
  );

  /* ------------------------------------------------------------- messages */

  add("getMessages", (address, filter = {}) =>
    cy.task("btm:messages", { address, filter }, { log: false }).then(unwrap)
  );

  add("getMessage", (address, messageId) =>
    cy.task("btm:message", { address, messageId }, { log: false }).then(unwrap)
  );

  add("getOtp", (address, messageId) =>
    cy.task("btm:otp", { address, messageId }, { log: false }).then(unwrap)
  );

  add("getLinks", (address, messageId) =>
    cy.task("btm:links", { address, messageId }, { log: false }).then(unwrap)
  );

  /* ---------------------------------------------------------------- waits */

  const waitCommand = (base, task, pick) =>
    add(base, (address, waitOptions = {}) => {
      const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_WAIT_MS;

      return cy
        .task(
          task,
          { address, options: { ...waitOptions, timeoutMs } },
          { log: false, timeout: taskTimeout(timeoutMs) }
        )
        .then(unwrap)
        .then((result) => {
          const value = pick ? pick(result) : result;
          Cypress.log({
            name: base,
            message: typeof value === "string" ? value : value.subject || address,
            consoleProps: () => ({ address, result }),
          });

          return value;
        });
    });

  waitCommand("waitForMessage", "btm:waitForMessage");
  waitCommand("waitForOtp", "btm:waitForOtp");
  waitCommand("waitForCode", "btm:waitForCode", (r) => r.code);
  waitCommand("waitForLinks", "btm:waitForLinks");
  waitCommand("waitForActionUrl", "btm:waitForActionUrl", (r) => r.url);

  /* -------------------------------------------------------------- account */

  add("tempMailUsage", () => cy.task("btm:usage", {}, { log: false }).then(unwrap));

  add("tempMailDomains", () =>
    cy.task("btm:domains", {}, { log: false }).then(unwrap).then((r) => r.domains)
  );

  /* -------------------------------------------------------------- cleanup */

  if (autoCleanup) {
    afterEach(function cleanUpBestTempMailInboxes() {
      const addresses = created();
      if (!addresses.length) return;

      Cypress.env("__btmCreatedInboxes", []);

      // No unwrap and no assertion: a cleanup failure must never turn a
      // passing test red, and these inboxes expire on their own anyway.
      cy.task("btm:deleteInboxes", { addresses }, { log: false });
    });
  }
}

module.exports = { registerBestTempMailCommands, unwrap, taskTimeout };
