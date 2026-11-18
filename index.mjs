/*
 * ESM wrapper, so an ESM cypress.config.mjs can use named imports:
 *
 *   import { bestTempMail } from "best-tempmail-cypress";
 *
 * The implementation is CommonJS because Cypress config files are still
 * commonly CJS and a dual build would be more machinery than this package
 * needs.
 */

import plugin from "./index.js";

export const bestTempMail = plugin.bestTempMail;
export const createClient = plugin.createClient;
export const ApiError = plugin.ApiError;
export const NoMessageError = plugin.NoMessageError;
export const DEFAULT_BASE_URL = plugin.DEFAULT_BASE_URL;

export default plugin;
