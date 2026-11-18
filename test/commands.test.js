"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  registerBestTempMailCommands,
  unwrap,
  taskTimeout,
} = require("../src/commands");

/* ===========================================================================
 *  A fake Cypress.
 *
 *  Cypress chains are not promises, so a promise-based stub would not exercise
 *  the code as written. This mimics the part that matters: .then() receives the
 *  previous value and yields a new link in the chain, synchronously.
 * ========================================================================= */

function chain(value) {
  return {
    value,
    then(fn) {
      return chain(fn(value));
    },
  };
}

function fakeCypress({ taskResult } = {}) {
  const commands = {};
  const taskCalls = [];
  const logs = [];
  const hooks = { afterEach: [] };
  const env = {};

  const cy = {
    task(name, arg, options) {
      taskCalls.push({ name, arg, options });
      const result =
        typeof taskResult === "function" ? taskResult(name, arg) : (taskResult ?? {});

      return chain(result);
    },
  };

  const Cypress = {
    Commands: {
      add(name, options, fn) {
        if (commands[name]) {
          throw new Error(`Cypress would refuse to add ${name} twice`);
        }
        commands[name] = typeof options === "function" ? options : fn;
      },
    },
    env(name, value) {
      if (arguments.length === 0) return env;
      if (value === undefined) return env[name];
      env[name] = value;

      return value;
    },
    log(entry) {
      logs.push(entry);
    },
  };

  return { cy, Cypress, commands, taskCalls, logs, hooks, env };
}

/**
 * Install the fake globals, register the commands, run the body, and always
 * tidy up: leaking a global `cy` into the next test file would be its own kind
 * of bug.
 */
function withFakeCypress(options, fakeOptions, body) {
  const fake = fakeCypress(fakeOptions);

  const saved = {
    cy: global.cy,
    Cypress: global.Cypress,
    afterEach: global.afterEach,
  };

  global.cy = fake.cy;
  global.Cypress = fake.Cypress;
  global.afterEach = (fn) => fake.hooks.afterEach.push(fn);

  try {
    registerBestTempMailCommands(options);

    return body(fake);
  } finally {
    global.cy = saved.cy;
    global.Cypress = saved.Cypress;
    global.afterEach = saved.afterEach;
  }
}

/* ------------------------------------------------------------------- unwrap */

test("unwrap passes a normal value straight through", () => {
  const value = { address: "a@b.site" };
  assert.equal(unwrap(value), value);
  assert.equal(unwrap(null), null);
});

test("unwrap turns a tagged error back into a throw with its fields", () => {
  // Without this, a 402 arrives in the browser as a plain object and the test
  // fails somewhere later with a confusing message about undefined.
  assert.throws(
    () =>
      unwrap({
        __btmError: true,
        name: "ApiError",
        message: "best-tempmail: HTTP 402: needs a paid plan",
        status: 402,
        upgrade: "https://x.test/pricing",
        requestId: "req-7",
      }),
    (err) => {
      assert.equal(err.name, "ApiError");
      assert.equal(err.status, 402);
      assert.equal(err.upgrade, "https://x.test/pricing");
      assert.equal(err.requestId, "req-7");
      assert.match(err.message, /402/);

      return true;
    }
  );
});

test("the task timeout leaves headroom above the wait itself", () => {
  // Cypress's own taskTimeout defaults to 60s, so a 60s wait would race it and
  // fail for the wrong reason.
  assert.ok(taskTimeout(60000) > 60000);
  assert.equal(taskTimeout(30000), 50000);
});

/* --------------------------------------------------------------- the commands */

test("registering adds the whole command surface", () => {
  withFakeCypress({}, {}, ({ commands }) => {
    for (const name of [
      "createInbox",
      "bulkCreateInboxes",
      "getInbox",
      "deleteInbox",
      "getMessages",
      "getMessage",
      "getOtp",
      "getLinks",
      "waitForMessage",
      "waitForOtp",
      "waitForCode",
      "waitForLinks",
      "waitForActionUrl",
      "tempMailUsage",
      "tempMailDomains",
    ]) {
      assert.equal(typeof commands[name], "function", `missing cy.${name}`);
    }
  });
});

test("a prefix renames every command, for a project that already has one of these names", () => {
  withFakeCypress({ prefix: "btm" }, {}, ({ commands }) => {
    assert.equal(typeof commands.btmCreateInbox, "function");
    assert.equal(typeof commands.btmWaitForCode, "function");
    assert.equal(commands.createInbox, undefined, "the unprefixed name should not exist");
  });
});

test("registering outside a support file fails with a useful message", () => {
  const saved = { cy: global.cy, Cypress: global.Cypress };
  delete global.cy;
  delete global.Cypress;
  try {
    assert.throws(() => registerBestTempMailCommands(), /support file/);
  } finally {
    global.cy = saved.cy;
    global.Cypress = saved.Cypress;
  }
});

test("createInbox yields the inbox and remembers it for cleanup", () => {
  withFakeCypress(
    {},
    { taskResult: () => ({ address: "made@alagen.site", expiresAt: "2026-11-17 16:03:38" }) },
    ({ commands, Cypress, taskCalls }) => {
      const result = commands.createInbox({});
      assert.equal(result.value.address, "made@alagen.site");
      assert.deepEqual(Cypress.env("__btmCreatedInboxes"), ["made@alagen.site"]);
      assert.equal(taskCalls[0].name, "btm:createInbox");
    }
  );
});

test("a failing task throws in the browser rather than yielding an error object", () => {
  withFakeCypress(
    {},
    {
      taskResult: () => ({
        __btmError: true,
        name: "ApiError",
        message: "best-tempmail: HTTP 429: out of quota",
        status: 429,
      }),
    },
    ({ commands }) => {
      assert.throws(() => commands.createInbox({}), /429/);
    }
  );
});

test("waitForCode yields the bare string, not the wrapper object", () => {
  withFakeCypress({}, { taskResult: () => ({ code: "004007" }) }, ({ commands, taskCalls }) => {
    const result = commands.waitForCode("a@b.site", { subject: "verify" });
    assert.equal(result.value, "004007");

    const call = taskCalls[0];
    assert.equal(call.name, "btm:waitForCode");
    assert.equal(call.arg.options.subject, "verify");
    // The default wait has to be passed down, not left for the Node side to
    // guess, because the task timeout is derived from it.
    assert.equal(call.arg.options.timeoutMs, 60000);
    assert.ok(call.options.timeout > 60000, "the task needs more time than the wait");
  });
});

test("waitForActionUrl yields the bare URL", () => {
  withFakeCypress(
    {},
    { taskResult: () => ({ url: "https://example.com/verify?token=abc" }) },
    ({ commands }) => {
      assert.equal(
        commands.waitForActionUrl("a@b.site").value,
        "https://example.com/verify?token=abc"
      );
    }
  );
});

test("a custom timeout flows through to both the wait and the task", () => {
  withFakeCypress({}, { taskResult: () => ({ id: "m1" }) }, ({ commands, taskCalls }) => {
    commands.waitForMessage("a@b.site", { timeoutMs: 5000 });
    assert.equal(taskCalls[0].arg.options.timeoutMs, 5000);
    assert.equal(taskCalls[0].options.timeout, 25000);
  });
});

test("bulkCreateInboxes remembers every address it created", () => {
  withFakeCypress(
    {},
    {
      taskResult: () => ({
        count: 2,
        quotaCharged: 2,
        addresses: ["one@alagen.site", "two@alagen.site"],
        inboxes: [],
      }),
    },
    ({ commands, Cypress }) => {
      commands.bulkCreateInboxes(2);
      assert.deepEqual(Cypress.env("__btmCreatedInboxes"), [
        "one@alagen.site",
        "two@alagen.site",
      ]);
    }
  );
});

/* ------------------------------------------------------------------ cleanup */

test("the afterEach deletes what the test created and clears the list", () => {
  withFakeCypress(
    {},
    { taskResult: (name) => (name === "btm:createInbox" ? { address: "x@alagen.site" } : {}) },
    ({ commands, hooks, taskCalls, Cypress }) => {
      commands.createInbox({});
      assert.equal(hooks.afterEach.length, 1, "no cleanup hook was registered");

      hooks.afterEach[0]();

      const cleanup = taskCalls.find((c) => c.name === "btm:deleteInboxes");
      assert.ok(cleanup, "cleanup did not run");
      assert.deepEqual(cleanup.arg.addresses, ["x@alagen.site"]);
      // Cleared, so the next test does not try to delete it again.
      assert.deepEqual(Cypress.env("__btmCreatedInboxes"), []);
    }
  );
});

test("the afterEach does nothing when the test created no inboxes", () => {
  withFakeCypress({}, {}, ({ hooks, taskCalls }) => {
    hooks.afterEach[0]();
    assert.equal(
      taskCalls.filter((c) => c.name === "btm:deleteInboxes").length,
      0,
      "a test that created nothing should make no cleanup call"
    );
  });
});

test("cleanup does not unwrap, so a cleanup failure cannot fail a passing test", () => {
  withFakeCypress(
    {},
    {
      taskResult: (name) =>
        name === "btm:createInbox"
          ? { address: "x@alagen.site" }
          : { __btmError: true, name: "ApiError", message: "cleanup exploded", status: 500 },
    },
    ({ commands, hooks }) => {
      commands.createInbox({});
      // The whole point: this must not throw.
      hooks.afterEach[0]();
    }
  );
});

test("autoCleanup false registers no hook at all", () => {
  withFakeCypress({ autoCleanup: false }, {}, ({ hooks }) => {
    assert.equal(hooks.afterEach.length, 0);
  });
});
