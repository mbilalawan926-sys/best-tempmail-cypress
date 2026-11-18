/*
 * ESM wrapper for the browser-side commands:
 *
 *   // cypress/support/e2e.js
 *   import "best-tempmail-cypress/commands";
 *
 * Importing registers the commands, exactly as the CommonJS form does.
 */

import commands from "./commands.js";

export const registerBestTempMailCommands = commands.registerBestTempMailCommands;

export default commands;
