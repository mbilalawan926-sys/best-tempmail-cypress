/*
 * Example specs. Not published with the package and not run in CI: they need a
 * real application to sign up to. They are here as the documentation someone
 * copies from.
 *
 * To run them against your own app, set BTM_API_KEY and point baseUrl at it.
 */

describe("email verification", () => {
  it("accepts the code from the verification email", () => {
    cy.createInbox().then((inbox) => {
      cy.visit("/signup");
      cy.get("#email").type(inbox.address);
      cy.get("#submit").click();

      // subject is worth passing. Without a filter the first message to
      // arrive wins, and a welcome email often beats the verification email
      // by a second.
      cy.waitForCode(inbox.address, { subject: "verify" }).then((code) => {
        cy.get("#code").type(code);
        cy.get("#confirm").click();
      });

      cy.contains("Welcome").should("be.visible");
    });

    // No cleanup here: the afterEach that comes with the commands deletes the
    // inbox for you.
  });

  it("follows the link when the email wants a click instead", () => {
    cy.createInbox().then((inbox) => {
      cy.visit("/signup");
      cy.get("#email").type(inbox.address);
      cy.get("#submit").click();

      // actionUrl is the link the message is asking you to follow, not the
      // first URL in the body, which is almost always the logo.
      cy.waitForActionUrl(inbox.address).then((url) => {
        cy.visit(url);
      });

      cy.contains("Email confirmed").should("be.visible");
    });
  });

  it("reads the whole message when an assertion needs the body", () => {
    cy.createInbox().then((inbox) => {
      triggerPasswordReset(inbox.address);

      cy.waitForMessage(inbox.address, { subject: "reset" })
        .then((summary) => cy.getMessage(inbox.address, summary.id))
        .then((message) => {
          expect(message.text).to.contain("expires in 30 minutes");
          expect(message.from).to.contain("no-reply@");
        });
    });
  });

  it("gives every parallel worker its own address", () => {
    // One request of quota per inbox, so this charges 4. Paid plans only.
    cy.bulkCreateInboxes(4).then((batch) => {
      expect(batch.quotaCharged).to.equal(4);

      batch.addresses.forEach((address) => {
        signUp(address);
      });
    });
  });

  it("uses one inbox for several services with plus-addressing", () => {
    cy.createInbox().then((inbox) => {
      // Mail to user+anything@domain arrives at user@domain.
      signUp(inbox.address.replace("@", "+netflix@"));
      signUp(inbox.address.replace("@", "+spotify@"));

      // Wait on the BASE address, not the tagged one, and filter by sender.
      cy.waitForMessage(inbox.address, { from: "netflix" });
      cy.waitForMessage(inbox.address, { from: "spotify" });
    });
  });

  it("tells a definite empty apart from an exhausted search", () => {
    cy.createInbox().then((inbox) => {
      cy.getMessages(inbox.address, { q: "ORD-48812" }).then((list) => {
        if (list.messages.length === 0 && list.scanLimitReached) {
          throw new Error("the search hit its ceiling: narrow it or set since");
        }

        expect(list.messages).to.have.length(0);
      });
    });
  });
});

/* Stand-ins for your own application's helpers. */
function triggerPasswordReset(address) {
  cy.request("POST", "/api/password-reset", { email: address });
}

function signUp(address) {
  cy.request("POST", "/api/signup", { email: address });
}
