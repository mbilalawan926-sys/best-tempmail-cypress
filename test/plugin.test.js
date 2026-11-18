"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { bestTempMail, serializeError, resolveApiKey } = require("../src/plugin");
const { ApiError, NoMessageError } = require("../src/api");
const { startServer, json } = require("./helpers");

/** Collect the tasks a plugin registers, the way Cypress's `on` would. */
function fakeOn() {
  const tasks = {};
  const on = (event, handlers) => {
    assert.equal(event, "task");
    Object.assign(tasks, handlers);
  };

  return { on, tasks };
}

const quiet = (fn) => {
  // The plugin warns on stderr about a missing key and about a key found in
  // Cypress env. Both are intentional, and neither belongs in test output.
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
};

/* ------------------------------------------------------------- the API key */

test("an explicit key wins over both environment sources", () => {
  const config = { env: { BTM_API_KEY: "from-cypress-env" } };
  process.env.BTM_API_KEY = "from-process-env";
  try {
    assert.equal(resolveApiKey(config, "explicit"), "explicit");
    // Untouched: nothing was consumed from the config.
    assert.equal(config.env.BTM_API_KEY, "from-cypress-env");
  } finally {
    delete process.env.BTM_API_KEY;
  }
});

test("process.env is preferred over Cypress env", () => {
  const config = { env: { BTM_API_KEY: "from-cypress-env" } };
  process.env.BTM_API_KEY = "from-process-env";
  try {
    assert.equal(resolveApiKey(config, undefined), "from-process-env");
  } finally {
    delete process.env.BTM_API_KEY;
  }
});

test("a key in Cypress env is used and then removed, so it never reaches the browser", () => {
  // Cypress ships config.env to the browser, where it is readable through
  // Cypress.env() and ends up in screenshots and videos. Using the key and
  // then deleting it is the least-bad handling of a key that was put somewhere
  // it should not have been.
  const config = { env: { BTM_API_KEY: "from-cypress-env", other: "kept" } };
  const key = quiet(() => resolveApiKey(config, undefined));

  assert.equal(key, "from-cypress-env");
  assert.equal("BTM_API_KEY" in config.env, false, "the key was left in config.env");
  assert.equal(config.env.other, "kept", "unrelated env was disturbed");
});

test("no key anywhere gives null rather than throwing", () => {
  assert.equal(resolveApiKey({ env: {} }, undefined), null);
  assert.equal(resolveApiKey(undefined, undefined), null);
});

/* --------------------------------------------------------------- the plugin */

test("the plugin refuses to run outside setupNodeEvents", () => {
  assert.throws(() => bestTempMail(undefined, {}), /setupNodeEvents/);
});

test("the plugin registers every task the commands call, and returns the config", () => {
  const { on, tasks } = fakeOn();
  const config = { env: {} };

  const returned = quiet(() => bestTempMail(on, config, { apiKey: "k" }));
  assert.equal(returned, config, "the config must be returned so Cypress keeps the changes");

  // Every task name the browser side calls. A missing one fails at runtime
  // inside somebody's test suite with "task not registered", which is a poor
  // place to find out.
  for (const name of [
    "btm:createInbox",
    "btm:bulkCreateInboxes",
    "btm:inbox",
    "btm:deleteInbox",
    "btm:deleteInboxes",
    "btm:messages",
    "btm:message",
    "btm:otp",
    "btm:links",
    "btm:waitForMessage",
    "btm:waitForOtp",
    "btm:waitForCode",
    "btm:waitForLinks",
    "btm:waitForActionUrl",
    "btm:usage",
    "btm:domains",
    "btm:health",
  ]) {
    assert.equal(typeof tasks[name], "function", `missing task ${name}`);
  }
});

/* ----------------------------------------------------------- error crossing */

test("an ApiError survives serialization with its detail intact", () => {
  const serialized = serializeError(
    new ApiError(429, "slow down", {
      requestId: "req-9",
      upgrade: "https://x.test/pricing",
      retryAfter: 42,
    })
  );

  assert.equal(serialized.__btmError, true);
  assert.equal(serialized.name, "ApiError");
  assert.equal(serialized.status, 429);
  assert.equal(serialized.requestId, "req-9");
  assert.equal(serialized.retryAfter, 42);
  assert.equal(serialized.upgrade, "https://x.test/pricing");
  // And the whole thing is plain data, which is the point: a thrown Error
  // crossing the task boundary arrives as an empty object.
  assert.deepEqual(JSON.parse(JSON.stringify(serialized)), serialized);
});

test("a NoMessageError keeps its address and how long it waited", () => {
  const serialized = serializeError(new NoMessageError("a@b.site", 8000));
  assert.equal(serialized.name, "NoMessageError");
  assert.equal(serialized.address, "a@b.site");
  assert.equal(serialized.waitedMs, 8000);
});

test("a task returns a tagged error object rather than rejecting", async () => {
  const server = await startServer((req, res) =>
    json(res, 404, { error: "Inbox not found", request_id: "req-404" })
  );
  try {
    const { on, tasks } = fakeOn();
    quiet(() => bestTempMail(on, { env: {} }, { apiKey: "k", baseUrl: server.baseUrl }));

    const result = await tasks["btm:inbox"]({ address: "nope@alagen.site" });

    assert.equal(result.__btmError, true, "a rejected task loses everything but the message");
    assert.equal(result.status, 404);
    assert.equal(result.requestId, "req-404");
  } finally {
    await server.close();
  }
});

test("a task does the real work when it succeeds", async () => {
  const server = await startServer((req, res) =>
    json(res, 200, { success: true, address: "made@alagen.site", expires_at: "2026-11-17 16:03:38" })
  );
  try {
    const { on, tasks } = fakeOn();
    quiet(() => bestTempMail(on, { env: {} }, { apiKey: "k", baseUrl: server.baseUrl }));

    const inbox = await tasks["btm:createInbox"]({});
    assert.equal(inbox.address, "made@alagen.site");
    assert.equal(inbox.__btmError, undefined);
  } finally {
    await server.close();
  }
});

test("bulk cleanup never throws, even when some deletions fail", async () => {
  // This runs in an afterEach. A cleanup failure must not turn a passing test
  // red, so it reports per-address and carries on.
  const server = await startServer((req, res) => {
    if (req.path.includes("boom")) {
      return json(res, 500, { error: "the server fell over" });
    }

    return json(res, 200, { success: true, deleted: true });
  });
  try {
    const { on, tasks } = fakeOn();
    quiet(() => bestTempMail(on, { env: {} }, { apiKey: "k", baseUrl: server.baseUrl }));

    const result = await tasks["btm:deleteInboxes"]({
      addresses: ["fine@alagen.site", "boom@alagen.site", "alsofine@alagen.site"],
    });

    assert.equal(result.__btmError, undefined, "cleanup must not surface as an error");
    assert.equal(result.results.length, 3);
    assert.equal(result.results[0].deleted, true);
    assert.equal(result.results[1].deleted, false);
    assert.ok(result.results[1].error, "the failure should be recorded");
    assert.equal(result.results[2].deleted, true, "it carried on after the failure");
  } finally {
    await server.close();
  }
});
