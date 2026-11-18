# best-tempmail for Cypress

Disposable email inboxes for Cypress tests. Create a throwaway address, wait for the email,
and get the verification code or the link to click.

No dependencies.

```bash
npm install -D best-tempmail-cypress
```

**`cypress.config.js`**

```js
const { defineConfig } = require("cypress");
const { bestTempMail } = require("best-tempmail-cypress");

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      return bestTempMail(on, config);
    },
  },
});
```

**`cypress/support/e2e.js`**

```js
require("best-tempmail-cypress/commands");
```

**Then in a test**

```js
it("a new user can verify their email", () => {
  cy.createInbox().then((inbox) => {
    cy.visit("/signup");
    cy.get("#email").type(inbox.address);
    cy.get("#submit").click();

    cy.waitForCode(inbox.address, { subject: "verify" }).then((code) => {
      cy.get("#code").type(code);
    });

    cy.contains("Welcome").should("be.visible");
  });
});
```

Set `BTM_API_KEY` in your environment. The inbox is deleted after the test automatically.

## Why a plugin rather than cy.request

Three reasons, and the first is the one that matters.

**The API key stays out of the browser.** All the HTTP work happens in Cypress's Node process
as tasks. Anything reachable from the browser context is readable through `Cypress.env()`, and
it shows up in the runner UI, in screenshots and in videos. A key in a task does not.

If you do put `BTM_API_KEY` in Cypress env, the plugin uses it, warns you, and then **deletes it
from the config** before Cypress sends that config to the browser. Prefer the environment
variable.

**`cy.request` cannot hold a long poll.** It is bound by `responseTimeout`, which defaults to
30 seconds. The API holds a wait open for up to 55, so `cy.request` would cut it off mid-wait
and report a timeout that looks like a network fault.

**Errors keep their detail.** A task cannot reject with a real `Error` without losing
everything but the message, so failures come back tagged as data and are rethrown in the
browser with the status, the request id and the upgrade link still attached. A 402 reads as a
402 rather than as `[object Object]`.

## Waiting, and the bug worth knowing about

`cy.waitForMessage` looks at what is already in the inbox **before** it waits for anything new,
and that ordering is the entire point.

The API's long-poll endpoint signals mail **arriving**. A message that landed before the call
started is invisible to it. In a Cypress test that is the normal case rather than the edge
case: you fill the form, submit, and the email is frequently delivered before your next
command runs. A wait that only long-polls then burns its whole timeout while the message it is
waiting for sits there already.

This is not hypothetical. The GitHub Action for this same API shipped with 21 passing tests and
failed on the first real email for exactly this reason, because its mock answered the long poll
whenever asked and so could not express the difference. Two tests here use a mock that
**refuses to answer the long poll at all**, and they have been checked to fail when the fix is
removed.

The strategy also changes depending on whether you filtered:

- **No filter:** the long-poll endpoint. One request covers the whole wait.
- **With a filter:** the message listing, polled, because the long poll cannot filter and would
  return the first message to arrive whether or not it is the one you want.

That second case matters more than it looks. In a real signup a welcome email frequently beats
the verification email by a second, so an unfiltered wait hands you the wrong message and the
test then fails a long way from the cause. Pass `subject` or `from`.

## Commands

| Command | Yields |
|---|---|
| `cy.createInbox(options?)` | an inbox, deleted after the test |
| `cy.bulkCreateInboxes(25)` | up to 50 inboxes in one call. Paid plans |
| `cy.getInbox(address)` | its metadata and message count |
| `cy.deleteInbox(address)` | deletes early, if you need to |
| `cy.getMessages(address, filter?)` | a page of message summaries |
| `cy.getMessage(address, id)` | one full message, body included |
| `cy.getOtp(address, id)` | the code, confidence and candidates |
| `cy.getLinks(address, id)` | every link, typed and scored |
| `cy.waitForMessage(address, opts?)` | a message summary |
| `cy.waitForCode(address, opts?)` | the code as a string |
| `cy.waitForActionUrl(address, opts?)` | the link to click, as a string |
| `cy.waitForOtp(address, opts?)` | the full OTP object |
| `cy.waitForLinks(address, opts?)` | the full links object |
| `cy.tempMailUsage()` | plan, quota, subscription. Works without a key |
| `cy.tempMailDomains()` | the available domains |

Wait options: `{ subject, from, q, timeoutMs }`. The default wait is 60 seconds, and each
waiting command raises its own Cypress task timeout above whatever you ask for, so a long wait
cannot be cut short by `taskTimeout`.

`cy.waitForCode` and `cy.waitForActionUrl` **fail** when the message arrives but holds no code
or no clear link, because a test receiving a bare string has nowhere to put that outcome and
would otherwise type an empty string into the form. The structured versions return it as data
so you can inspect the candidates yourself.

## Automatic cleanup

Importing the commands also registers an `afterEach` that deletes every inbox created during
the test. It never asserts and never unwraps a failure, so a cleanup problem cannot turn a
passing test red, and the inboxes expire on their own regardless.

Both settings come from Cypress env, so nothing needs calling:

```js
// cypress.config.js
env: {
  btmAutoCleanup: false,     // keep inboxes after each test
  btmCommandPrefix: "btm",   // cy.btmCreateInbox, for a name clash
}
```

## Clicking the link instead of typing a code

```js
cy.createInbox().then((inbox) => {
  cy.visit("/signup");
  cy.get("#email").type(inbox.address);
  cy.get("#submit").click();

  cy.waitForActionUrl(inbox.address).then((url) => {
    cy.visit(url);
  });

  cy.contains("Email confirmed").should("be.visible");
});
```

`actionUrl` is the link the message is actually asking you to follow, not the first URL in the
body, which is almost always the logo. Links are scored on the wording around them, where they
sit in the message, and whether the URL carries something that looks like a one-time token.
Each is typed, so `unsubscribe`, `social`, `legal`, `tracking` and `view_in_browser` links are
labelled instead of competing to be the answer.

Where a link goes through a click tracker, `destination` holds the real target, so you never
have to remember the fallback.

## Searching a busy inbox

```js
cy.getMessages(address, {
  q: "ORD-48812",
  since: "2026-07-04T00:00:00Z",
  limit: 20,
}).then((list) => {
  if (list.messages.length === 0 && !list.scanLimitReached) {
    // nothing in the inbox matches, definitively
  }
});
```

`scanLimitReached` is what makes an empty result interpretable. Empty with it `false` means
nothing matches, full stop. Empty with it `true` means the search stopped at its ceiling and
the message may exist further back, so narrow the filter or set `since` rather than paging
blindly.

Filters: `limit` (max 200), `offset` (max 5000), `from`, `subject`, `q` (full text over sender,
subject and decoded body), `since`, `until`, `hasAttachments`.

## Plus-addressing

Mail to `user+anything@domain` arrives at `user@domain`, so one inbox covers a test that
registers with several services:

```js
cy.createInbox().then((inbox) => {
  const tagged = inbox.address.replace("@", "+netflix@");

  signUp(tagged);

  cy.waitForMessage(inbox.address, { from: "netflix" });
});
```

Wait on the base address, not the tagged one.

## Parallel runs

```js
before(() => {
  cy.bulkCreateInboxes(8).then((batch) => {
    Cypress.env("inboxes", batch.addresses);
  });
});
```

One request per inbox of quota, so eight charges eight, reported back as `quotaCharged`.
Spreading across domains is the default and usually what you want: eight signups from one
domain inside a minute looks like a single bulk sender to whatever you are signing up to.

## The free tier

Without a key: 3 inboxes per day per IP, and no OTP or link extraction.

That per-IP limit is the catch on CI, where the runner's address is shared with an enormous
number of other jobs, so the quota is usually spent before your workflow starts. The plugin
warns at startup when it finds no key.

`cy.tempMailUsage()` works without one and reports the free tier, including how many of today's
three inboxes the current IP has used.

## Dates are strings

Everything returned crosses Cypress's task boundary and is serialized on the way, so nothing
can be a `Date`. Timestamps come back as the API sent them: ISO 8601 for message dates, and
`2026-11-17 14:03:38` for inbox times, which is UTC.

## Tests

```bash
npm test
```

56 tests against a real local HTTP server and a fake Cypress, no network and no API key needed.

## TypeScript

Types ship with the package. For the `cy.*` commands, add the commands types to your
`tsconfig.json`:

```json
{ "compilerOptions": { "types": ["cypress", "best-tempmail-cypress/commands"] } }
```

## Licence

MIT.
