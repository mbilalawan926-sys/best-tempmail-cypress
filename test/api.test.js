"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createClient, ApiError, NoMessageError, escapeAddress } = require("../src/api");
const { startServer, json } = require("./helpers");

const withServer = async (handler, fn, clientOptions = {}) => {
  const server = await startServer(handler);
  try {
    const client = createClient({
      apiKey: "btm_sk_test_abcd",
      baseUrl: server.baseUrl,
      ...clientOptions,
    });
    await fn(client, server);
  } finally {
    await server.close();
  }
};

/* ------------------------------------------------------------------ inboxes */

test("createInbox sends no body when nothing was asked for", async () => {
  await withServer(
    (req, res) =>
      json(res, 200, {
        success: true,
        address: "myprefix@alagen.site",
        created_at: "2026-11-17 14:03:38",
        expires_at: "2026-11-17 16:03:38",
        lifetime_minutes: 120,
      }),
    async (client, server) => {
      const inbox = await client.createInbox();
      assert.equal(inbox.address, "myprefix@alagen.site");
      assert.equal(inbox.lifetimeMinutes, 120);
      // Dates stay strings: everything here crosses Cypress's task boundary
      // and would not survive as a Date.
      assert.equal(inbox.expiresAt, "2026-11-17 16:03:38");
      assert.equal(typeof inbox.expiresAt, "string");
      assert.equal(server.requests[0].body, null);
      assert.equal(server.requests[0].headers["x-api-key"], "btm_sk_test_abcd");
    }
  );
});

test("createInbox sends only the fields that were set", async () => {
  await withServer(
    (req, res) => json(res, 200, { address: "chosen@alagen.site" }),
    async (client, server) => {
      await client.createInbox({ username: "chosen" });
      const body = JSON.parse(server.requests[0].body);
      assert.deepEqual(body, { username: "chosen" });
    }
  );
});

test("createInbox rejects a success response carrying no address", async () => {
  await withServer(
    (req, res) => json(res, 200, { success: true }),
    async (client) => {
      await assert.rejects(() => client.createInbox(), /no address/);
    }
  );
});

test("a keyless client sends no x-api-key header at all", async () => {
  await withServer(
    (req, res) => json(res, 200, { address: "a@b.site" }),
    async (client, server) => {
      await client.createInbox();
      assert.ok(
        !("x-api-key" in server.requests[0].headers),
        "a keyless client must not send the header"
      );
    },
    { apiKey: null }
  );
});

test("bulk create refuses an impossible count without calling the API", async () => {
  await withServer(
    () => assert.fail("the API must not be called"),
    async (client, server) => {
      for (const count of [0, -1, 51, 2.5, "3"]) {
        await assert.rejects(() => client.bulkCreateInboxes({ count }), /between 1 and 50/);
      }
      assert.equal(server.requests.length, 0);
    }
  );
});

test("bulk create reports the quota charged and flattens the addresses", async () => {
  await withServer(
    (req, res) =>
      json(res, 200, {
        success: true,
        count: 2,
        quota_charged: 2,
        lifetime_minutes: 120,
        inboxes: [
          { address: "fosilu8914@simtim.site", created_at: "2026-11-17 14:03:38" },
          { address: "dexihi2407@linsal.site", created_at: "2026-11-17 14:03:38" },
        ],
      }),
    async (client, server) => {
      const batch = await client.bulkCreateInboxes(2);
      assert.equal(batch.quotaCharged, 2);
      assert.deepEqual(batch.addresses, [
        "fosilu8914@simtim.site",
        "dexihi2407@linsal.site",
      ]);
      assert.equal(JSON.parse(server.requests[0].body).count, 2);
    }
  );
});

test("deleteInbox treats an already-absent inbox as success", async () => {
  // Cleanup runs in an afterEach, often after the inbox has expired. Anything
  // that turns a passing test red for tidying up is a bad trade.
  await withServer(
    (req, res) => json(res, 404, { error: "Inbox not found" }),
    async (client) => {
      const result = await client.deleteInbox("gone@alagen.site");
      assert.equal(result.alreadyGone, true);
      assert.equal(result.deleted, false);
    }
  );
});

test("an address keeps its @ and encodes its plus", async () => {
  assert.equal(escapeAddress("user@alagen.site"), "user@alagen.site");
  assert.equal(escapeAddress("user+netflix@alagen.site"), "user%2Bnetflix@alagen.site");
  assert.equal(
    decodeURIComponent(escapeAddress("user+netflix@alagen.site")),
    "user+netflix@alagen.site"
  );
});

/* ----------------------------------------------------------------- listings */

test("every filter reaches the query string", async () => {
  await withServer(
    (req, res) => json(res, 200, { success: true, messages: [] }),
    async (client, server) => {
      await client.messages("a@b.site", {
        limit: 20,
        offset: 40,
        from: "service.com",
        subject: "verify",
        q: "ORD-48812",
        since: "2026-07-04T00:00:00Z",
        until: "2026-07-05T00:00:00Z",
        hasAttachments: true,
      });

      const q = server.requests[0].query;
      assert.equal(q.get("limit"), "20");
      assert.equal(q.get("offset"), "40");
      assert.equal(q.get("from"), "service.com");
      assert.equal(q.get("subject"), "verify");
      assert.equal(q.get("q"), "ORD-48812");
      assert.equal(q.get("since"), "2026-07-04T00:00:00Z");
      assert.equal(q.get("until"), "2026-07-05T00:00:00Z");
      assert.equal(q.get("has_attachments"), "true");
    }
  );
});

test("no filter means no query string", async () => {
  await withServer(
    (req, res) => json(res, 200, { success: true, messages: [] }),
    async (client, server) => {
      await client.messages("a@b.site");
      assert.equal(server.requests[0].url.includes("?"), false);
    }
  );
});

test("hasAttachments false is sent and is not the same as unset", async () => {
  await withServer(
    (req, res) => json(res, 200, { success: true, messages: [] }),
    async (client, server) => {
      await client.messages("a@b.site", { hasAttachments: false });
      assert.equal(server.requests[0].query.get("has_attachments"), "false");
    }
  );
});

test("out-of-range paging is refused before any request", async () => {
  await withServer(
    () => assert.fail("the API must not be called"),
    async (client, server) => {
      await assert.rejects(() => client.messages("a@b.site", { limit: 201 }));
      await assert.rejects(() => client.messages("a@b.site", { limit: 0 }));
      await assert.rejects(() => client.messages("a@b.site", { offset: 5001 }));
      await assert.rejects(() => client.messages("a@b.site", { offset: -1 }));
      assert.equal(server.requests.length, 0);
    }
  );
});

test("the paging and scan fields come through", async () => {
  await withServer(
    (req, res) =>
      json(res, 200, {
        success: true,
        address: "a@b.site",
        messages: [{ id: "m1", subject: "hi", has_attachments: false }],
        limit: 100,
        offset: 0,
        returned: 1,
        has_more: true,
        scanned: 250,
        scan_limit_reached: true,
      }),
    async (client) => {
      const list = await client.messages("a@b.site");
      assert.equal(list.hasMore, true);
      assert.equal(list.scanned, 250);
      assert.equal(list.scanLimitReached, true);
      assert.equal(list.returned, 1);
    }
  );
});

test("a full message maps its attachments to the real field names", async () => {
  // Verbatim from a real message on 18 November 2026. The names were guessed
  // wrong first time: content_type instead of mime, with index, downloadable
  // and requires_plan missed entirely.
  await withServer(
    (req, res) =>
      json(res, 200, {
        success: true,
        message: {
          id: "fdf1ed83d063fb5e",
          from: '"Billing" <billing@example.com>',
          to: "wexugo9519@alagen.site",
          subject: "Your invoice is attached",
          date: "2026-11-18T12:27:32.000Z",
          text: "Verification code: 558219\n",
          attachments: [
            {
              index: 0,
              filename: "invoice.pdf",
              mime: "application/pdf",
              size: 69,
              downloadable: false,
              requires_plan: "pro",
            },
          ],
        },
      }),
    async (client) => {
      const message = await client.message("wexugo9519@alagen.site", "fdf1ed83d063fb5e");
      assert.equal(message.to, "wexugo9519@alagen.site");
      assert.equal(message.attachments.length, 1);
      assert.deepEqual(message.attachments[0], {
        index: 0,
        filename: "invoice.pdf",
        mime: "application/pdf",
        size: 69,
        downloadable: false,
        requiresPlan: "pro",
      });
    }
  );
});

test("a code keeps its leading zero, and a null code becomes an empty string", async () => {
  await withServer(
    (req, res) =>
      json(res, 200, {
        success: true,
        message_id: "m1",
        code: "004007",
        confidence: "high",
        candidates: [{ code: "004007", score: 6 }],
      }),
    async (client) => {
      const otp = await client.otp("a@b.site", "m1");
      assert.equal(otp.code, "004007", "a leading zero is why this is a string");
      assert.equal(otp.confidence, "high");
    }
  );

  await withServer(
    (req, res) => json(res, 200, { success: true, message_id: "m1", code: null, confidence: "none" }),
    async (client) => {
      const otp = await client.otp("a@b.site", "m1");
      assert.equal(otp.code, "");
      assert.equal(otp.confidence, "none");
    }
  );
});

test("links are typed and a tracker is unwrapped into destination", async () => {
  await withServer(
    (req, res) =>
      json(res, 200, {
        success: true,
        message_id: "m1",
        action_url: "https://example.com/verify?token=abc",
        confidence: "high",
        links: [
          {
            url: "https://click.tracker/xyz",
            unwrapped_url: "https://example.com/verify?token=abc",
            text: "Confirm",
            type: "action",
            score: 9,
          },
          {
            url: "https://example.com/unsubscribe",
            unwrapped_url: null,
            text: "Unsubscribe",
            type: "unsubscribe",
            score: 0,
          },
        ],
      }),
    async (client) => {
      const links = await client.links("a@b.site", "m1");
      assert.equal(links.actionUrl, "https://example.com/verify?token=abc");
      assert.equal(links.links[0].destination, "https://example.com/verify?token=abc");
      assert.equal(links.links[1].destination, "https://example.com/unsubscribe");
      assert.equal(links.links[1].type, "unsubscribe");
    }
  );
});

/* ------------------------------------------------------------- THE REGRESSION
 *
 * These mocks refuse to answer the long poll. If the client stops checking the
 * inbox first, they fail.
 * -------------------------------------------------------------------------- */

test("waitForMessage finds a message that had already arrived", async () => {
  await withServer(
    (req, res) => {
      if (req.path.endsWith("/wait")) {
        assert.fail("the client long-polled instead of checking the inbox first");
      }

      return json(res, 200, {
        success: true,
        messages: [{ id: "already-here", subject: "Please confirm" }],
        returned: 1,
      });
    },
    async (client, server) => {
      const message = await client.waitForMessage("a@b.site");
      assert.equal(message.id, "already-here");
      assert.equal(server.called("/wait"), false);
    }
  );
});

test("waitForCode finds a code in mail that had already arrived", async () => {
  await withServer(
    (req, res) => {
      if (req.path.endsWith("/wait")) {
        assert.fail("the client long-polled instead of checking the inbox first");
      }
      if (req.path.endsWith("/otp")) {
        return json(res, 200, { success: true, message_id: "m1", code: "004007", confidence: "high" });
      }

      return json(res, 200, { success: true, messages: [{ id: "m1" }] });
    },
    async (client, server) => {
      assert.equal(await client.waitForCode("a@b.site"), "004007");
      assert.equal(server.called("/wait"), false);
    }
  );
});

/* ------------------------------------------------------------------- waiting */

test("waitForMessage long-polls when the inbox is empty and goes round after a timeout", async () => {
  let waits = 0;
  await withServer(
    (req, res) => {
      if (!req.path.endsWith("/wait")) {
        return json(res, 200, { success: true, messages: [] });
      }
      waits += 1;

      // A server-side timeout is a 200 with timed_out true, not a failure.
      if (waits === 1) {
        return json(res, 200, { success: true, message: null, timed_out: true });
      }

      return json(res, 200, { success: true, message: { id: "arrived", subject: "Verify" } });
    },
    async (client, server) => {
      const message = await client.waitForMessage("a@b.site", { timeoutMs: 10000 });
      assert.equal(message.id, "arrived");
      assert.equal(server.countCalls("/wait"), 2);
    }
  );
});

test("waitForMessage never long-polls when a filter is set", async () => {
  // The long poll cannot filter. It would return the first message to arrive,
  // which in a real signup is often the welcome email.
  let polls = 0;
  await withServer(
    (req, res) => {
      if (req.path.endsWith("/wait")) {
        assert.fail("the long poll cannot filter and must not be used here");
      }
      assert.equal(req.query.get("subject"), "verify", "the filter was dropped");
      polls += 1;

      return polls < 2
        ? json(res, 200, { success: true, messages: [] })
        : json(res, 200, { success: true, messages: [{ id: "filtered" }] });
    },
    async (client, server) => {
      const message = await client.waitForMessage("a@b.site", {
        subject: "verify",
        timeoutMs: 8000,
      });
      assert.equal(message.id, "filtered");
      assert.equal(server.called("/wait"), false);
    }
  );
});

test("a wait that finds nothing throws NoMessageError naming the inbox", async () => {
  await withServer(
    (req, res) => {
      if (req.path.endsWith("/wait")) {
        return json(res, 200, { success: true, message: null, timed_out: true });
      }

      return json(res, 200, { success: true, messages: [] });
    },
    async (client) => {
      await assert.rejects(
        () => client.waitForMessage("watched@alagen.site", { timeoutMs: 300 }),
        (err) => {
          assert.ok(err instanceof NoMessageError, `got ${err.name}`);
          assert.match(err.message, /watched@alagen\.site/);

          return true;
        }
      );
    }
  );
});

test("the long poll asks for a timeout the server will honour", async () => {
  await withServer(
    (req, res) => {
      if (req.path.endsWith("/wait")) {
        const asked = Number(req.query.get("timeout"));
        assert.ok(asked <= 50, `asked for ${asked}s, which the server would clamp`);

        return json(res, 200, { success: true, message: { id: "m1" } });
      }

      return json(res, 200, { success: true, messages: [] });
    },
    async (client) => {
      const message = await client.waitForMessage("a@b.site", { timeoutMs: 600000 });
      assert.equal(message.id, "m1");
    }
  );
});

test("waitForCode errors when the message holds no code", async () => {
  await withServer(
    (req, res) => {
      if (req.path.endsWith("/otp")) {
        return json(res, 200, { success: true, message_id: "m1", code: null, confidence: "none" });
      }

      return json(res, 200, { success: true, messages: [{ id: "m1" }] });
    },
    async (client) => {
      await assert.rejects(() => client.waitForCode("a@b.site"), /no verification code/);
    }
  );
});

test("waitForOtp does not error when there was no code, because the mail arrived", async () => {
  await withServer(
    (req, res) => {
      if (req.path.endsWith("/otp")) {
        return json(res, 200, { success: true, message_id: "m1", code: null, confidence: "none" });
      }

      return json(res, 200, { success: true, messages: [{ id: "m1" }] });
    },
    async (client) => {
      const otp = await client.waitForOtp("a@b.site");
      assert.equal(otp.code, "");
      assert.equal(otp.confidence, "none");
    }
  );
});

/* -------------------------------------------------------------------- errors */

test("each status is classified, and the request id reaches the message", async () => {
  for (const [status, flag] of [
    [401, "isUnauthorized"],
    [402, "isPaymentRequired"],
    [404, "isNotFound"],
    [429, "isRateLimited"],
  ]) {
    await withServer(
      (req, res) => json(res, status, { error: "nope", request_id: "req-123" }),
      async (client) => {
        await assert.rejects(
          () => client.inbox("a@b.site"),
          (err) => {
            assert.ok(err instanceof ApiError, `${status}: got ${err.name}`);
            assert.equal(err.status, status);
            assert.equal(err[flag], true, `${status}: ${flag}`);
            assert.equal(err.requestId, "req-123");
            // The id has to be in the message: it is the only thing a support
            // email can quote.
            assert.match(err.message, /req-123/);

            return true;
          }
        );
      }
    );
  }
});

test("retry-after and the upgrade link survive", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "42" });
      res.end(JSON.stringify({ error: "slow down", upgrade: "https://best-tempmail.com/api/pricing" }));
    },
    async (client) => {
      await assert.rejects(
        () => client.inbox("a@b.site"),
        (err) => {
          assert.equal(err.retryAfter, 42);
          assert.match(err.message, /pricing/);

          return true;
        }
      );
    }
  );
});

test("a non-JSON error body still produces a useful message", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html><body>Bad Gateway</body></html>");
    },
    async (client) => {
      await assert.rejects(() => client.inbox("a@b.site"), /502.*Bad Gateway/s);
    }
  );
});

test("an unreachable host is reported as unreachable, not as an API error", async () => {
  // "We never got there" and "it refused us" need different responses.
  const client = createClient({ baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 1000 });
  await assert.rejects(
    () => client.health(),
    (err) => {
      assert.ok(!(err instanceof ApiError), "should not be an ApiError");
      assert.match(err.message, /could not reach/);

      return true;
    }
  );
});

/* --------------------------------------------------------------------- usage */

test("usage maps both the keyed and the keyless shape", async () => {
  await withServer(
    (req, res) =>
      json(res, 200, {
        success: true,
        plan: "founders",
        paid: true,
        hourly: { limit: 2000, used: 15, remaining: 1985, resets_in_seconds: 927 },
        lifetime_requests: 9766,
        key: { id: 3, last_four: "4cf2", status: "active" },
        subscription: { status: "active", days_remaining: 273, in_grace_period: false },
      }),
    async (client) => {
      const usage = await client.usage();
      assert.equal(usage.paid, true);
      assert.equal(usage.hourly.remaining, 1985);
      assert.equal(usage.key.lastFour, "4cf2");
      assert.equal(usage.subscription.daysRemaining, 273);
      // A paid plan has no daily cap, which is null rather than zero.
      assert.equal(usage.inboxesCreatedToday, null);
    }
  );

  await withServer(
    (req, res) =>
      json(res, 200, {
        success: true,
        plan: "free",
        paid: false,
        hourly: { limit: 150, used: 1, remaining: 149, resets_in_seconds: 3600 },
        inboxes_created_today: 0,
        upgrade: "https://best-tempmail.com/api/pricing",
      }),
    async (client) => {
      const usage = await client.usage();
      assert.equal(usage.paid, false);
      assert.equal(usage.key, null);
      // Zero is "the cap applies and none used", not "no cap".
      assert.equal(usage.inboxesCreatedToday, 0);
    }
  );
});
