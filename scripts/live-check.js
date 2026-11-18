#!/usr/bin/env node
"use strict";

/* ============================================================================
 *  A check against the real API.
 *
 *      BTM_API_KEY=btm_sk_live_... node scripts/live-check.js
 *
 *  Everything in test/ runs against a mock I wrote, which means it agrees with
 *  whatever I assumed. That is not a hypothetical weakness: the GitHub Action
 *  for this API passed 21 mocked tests and then failed on the first real
 *  email, and the attachment field names in these SDKs were guessed wrong
 *  until a real message was inspected.
 *
 *  This runs the client, not Cypress. Driving a real browser in CI to prove
 *  that an HTTP client works would add a great deal of machinery and test the
 *  wrong layer; the Cypress surface is covered by test/commands.test.js
 *  against a fake Cypress.
 *
 *  WHAT THIS CANNOT COVER, stated rather than left to be discovered: nothing
 *  here receives an email. A CI runner cannot send SMTP to the inbox, so OTP
 *  extraction, link extraction and the already-arrived branch of
 *  waitForMessage are not exercised against real mail. Those response shapes
 *  were captured from the live API by hand and are asserted as verbatim
 *  fixtures in the mocked suite. Real end-to-end delivery is tested from the
 *  mail server itself.
 *
 *  Cost: about a dozen requests and four inboxes of quota.
 * ==========================================================================*/

const assert = require("node:assert/strict");
const { createClient, ApiError, NoMessageError } = require("../src/api");

const key = process.env.BTM_API_KEY;
if (!key) {
  console.error("BTM_API_KEY is not set. Nothing to check against.");
  process.exit(2);
}

const client = createClient({ apiKey: key });

let failures = 0;

async function step(name, body) {
  try {
    await body();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message ? err.message : err}`);
  }
}

/**
 * Inbox timestamps arrive as "2026-11-17 16:03:38" with no timezone, and are
 * UTC. This is how a consumer has to read them, so the check doubles as
 * documentation.
 */
const parseInboxTime = (value) => new Date(value.replace(" ", "T") + "Z");

(async function main() {
  console.log("best-tempmail live check\n");

  await step("health", async () => {
    const health = await client.health();
    assert.equal(health.status, "ok", `status was ${health.status}`);
    console.log(`        api version ${health.version}`);
  });

  let remaining = Infinity;

  await step("usage, and the key is accepted", async () => {
    const usage = await client.usage();
    assert.equal(usage.paid, true, `expected a paid plan, got ${usage.plan}`);
    assert.ok(usage.hourly.limit > 0, "the hourly quota did not parse");
    assert.ok(usage.key, "a keyed call should carry a key block");
    assert.ok(usage.key.lastFour, "key.last_four was empty");
    remaining = usage.hourly.remaining;
    // Never log the key. Four characters is enough to tell keys apart, which
    // is exactly why the API returns only that.
    console.log(
      `        plan ${usage.plan}, key ...${usage.key.lastFour}, ${usage.hourly.remaining} of ${usage.hourly.limit} left this hour`
    );
  });

  if (remaining < 100) {
    console.error(
      `\nOnly ${remaining} requests left this hour. Stopping rather than eating the quota.`
    );
    process.exit(0);
  }

  await step("domains", async () => {
    const domains = await client.domains();
    assert.ok(domains.length > 0, "no domains came back, so no inbox could be created");
    console.log(`        ${domains.length} domains, first is ${domains[0]}`);
  });

  await step("an inbox can be created, read and waited on", async () => {
    const inbox = await client.createInbox();
    try {
      assert.ok(inbox.address, "no address");

      // The no-timezone format is the one a naive parse gets wrong. If it were
      // read as local time the expiry would be hours out and, on a two-hour
      // inbox, in the past.
      const expires = parseInboxTime(inbox.expiresAt);
      assert.ok(
        expires.getTime() > Date.now(),
        `expires_at ${inbox.expiresAt} is not in the future, so it was parsed in the wrong zone`
      );
      console.log(`        ${inbox.address}, expires ${expires.toISOString()}`);

      const info = await client.inbox(inbox.address);
      assert.equal(info.address, inbox.address);

      const list = await client.messages(inbox.address);
      assert.equal(list.messages.length, 0, "a brand new inbox held messages");
      // These six fields were missing from the published docs entirely, so
      // confirm production really sends them.
      assert.ok(list.limit > 0, "limit was absent from the listing response");
      assert.equal(list.scanLimitReached, false, "scan_limit_reached true on an empty inbox");
      console.log(
        `        empty listing: limit ${list.limit} offset ${list.offset} returned ${list.returned} hasMore ${list.hasMore} scanned ${list.scanned}`
      );

      const filtered = await client.messages(inbox.address, { subject: "verify", limit: 5 });
      assert.equal(filtered.limit, 5, `limit 5 was not honoured, got ${filtered.limit}`);

      const startedAt = Date.now();
      await assert.rejects(
        () => client.waitForMessage(inbox.address, { timeoutMs: 8000 }),
        (err) => {
          assert.ok(err instanceof NoMessageError, `expected NoMessageError, got ${err.name}`);

          return true;
        }
      );
      const waited = Date.now() - startedAt;
      assert.ok(
        waited >= 5000,
        `gave up after ${waited}ms, so the long poll is not holding the connection`
      );
      console.log(`        waited ${(waited / 1000).toFixed(1)}s then reported no message`);
    } finally {
      await client.deleteInbox(inbox.address);
    }
  });

  await step("deleting twice is not an error", async () => {
    const inbox = await client.createInbox();
    const first = await client.deleteInbox(inbox.address);
    assert.equal(first.deleted, true);
    // This is what makes the afterEach cleanup safe, so it has to hold against
    // production and not only against the mock.
    const second = await client.deleteInbox(inbox.address);
    assert.equal(second.alreadyGone, true, "a second delete should be a no-op");
  });

  await step("bulk charges one request per inbox", async () => {
    const batch = await client.bulkCreateInboxes(2);
    try {
      assert.equal(batch.count, 2, `asked for 2, got ${batch.count}`);
      assert.equal(batch.quotaCharged, 2, `quota_charged was ${batch.quotaCharged}`);
      assert.equal(batch.addresses.length, 2);
      console.log(`        ${batch.addresses.join(", ")}`);
    } finally {
      for (const address of batch.addresses) {
        await client.deleteInbox(address).catch(() => {});
      }
    }
  });

  await step("a missing inbox is a not-found", async () => {
    await assert.rejects(
      () => client.inbox("definitely-not-a-real-inbox-99999@alagen.site"),
      (err) => {
        assert.ok(err instanceof ApiError, `expected ApiError, got ${err.name}`);
        assert.equal(err.isNotFound, true, `classified as ${err.status}`);

        return true;
      }
    );
  });

  await step("a nonsense key is refused", async () => {
    const bad = createClient({ apiKey: "btm_sk_live_0000000000000000000000000000000" });
    await assert.rejects(
      () => bad.bulkCreateInboxes(1),
      (err) => {
        // Separate "the API refused us" from "we never reached the API", so an
        // outage does not read as a broken error mapping.
        assert.ok(
          err instanceof ApiError,
          `never reached the API, so this proves nothing about error handling: ${err.message}`
        );
        assert.ok(
          err.isUnauthorized || err.isPaymentRequired || err.isRateLimited,
          `a bad key gave HTTP ${err.status}, which none of the helpers classify`
        );
        console.log(`        refused as expected: HTTP ${err.status}`);

        return true;
      }
    );
  });

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check${failures === 1 ? "" : "s"} failed`);
    process.exit(1);
  }
  console.log("all checks passed against the live API");
})().catch((err) => {
  console.error("\nthe live check could not run:", err && err.stack ? err.stack : err);
  process.exit(1);
});
