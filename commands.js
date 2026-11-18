"use strict";

/*
 * The browser-side entry point. Import this once from your support file:
 *
 *   // cypress/support/e2e.js
 *   require("best-tempmail-cypress/commands");
 *
 * Importing it registers the commands and an afterEach that deletes every
 * inbox the test created.
 *
 * Both settings can be changed from Cypress env, so there is no need to call
 * anything:
 *
 *   // cypress.config.js
 *   env: {
 *     btmAutoCleanup: false,     // keep inboxes after each test
 *     btmCommandPrefix: "btm",   // cy.btmCreateInbox instead of cy.createInbox
 *   }
 *
 * Import this file OR call registerBestTempMailCommands yourself, not both:
 * Cypress refuses to add the same command name twice, so doing both fails
 * loudly rather than quietly.
 */

const { registerBestTempMailCommands } = require("./src/commands");

/* globals Cypress */
const fromEnv = () => {
  const read = (name) =>
    typeof Cypress !== "undefined" && Cypress.env ? Cypress.env(name) : undefined;

  return {
    autoCleanup: read("btmAutoCleanup") !== false,
    prefix: read("btmCommandPrefix") || undefined,
  };
};

registerBestTempMailCommands(fromEnv());

module.exports = { registerBestTempMailCommands };
