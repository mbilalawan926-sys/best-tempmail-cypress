"use strict";

/*
 * The Node-side entry point, for cypress.config.js.
 *
 *   const { bestTempMail } = require("best-tempmail-cypress");
 *
 * The browser-side commands live at "best-tempmail-cypress/commands" and must
 * be imported from a support file, not from here: they need `cy`, which does
 * not exist in the config process.
 */

const { bestTempMail } = require("./src/plugin");
const {
  createClient,
  ApiError,
  NoMessageError,
  DEFAULT_BASE_URL,
} = require("./src/api");

module.exports = {
  bestTempMail,
  // Exported for the occasional case of wanting the client directly inside
  // another task of your own, or in a Node script outside Cypress.
  createClient,
  ApiError,
  NoMessageError,
  DEFAULT_BASE_URL,
};
