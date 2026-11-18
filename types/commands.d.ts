import type {
  BulkCreateOptions,
  BulkResult,
  CreateInboxOptions,
  Inbox,
  InboxInfo,
  Links,
  ListFilter,
  Message,
  MessageList,
  MessageSummary,
  Otp,
  Usage,
  WaitOptions,
} from "./index";

export interface RegisterCommandsOptions {
  /** Delete every inbox the test created, in an afterEach. Default true. */
  autoCleanup?: boolean;
  /**
   * Rename the commands, so "btm" gives cy.btmCreateInbox. For a project that
   * already has a command of one of these names.
   */
  prefix?: string;
}

export declare function registerBestTempMailCommands(
  options?: RegisterCommandsOptions
): void;

declare global {
  namespace Cypress {
    interface Chainable<Subject = any> {
      /** Create a disposable inbox. Deleted automatically after the test. */
      createInbox(options?: CreateInboxOptions): Chainable<Inbox>;

      /** Create up to 50 inboxes in one call. Paid plans. */
      bulkCreateInboxes(options: BulkCreateOptions | number): Chainable<BulkResult>;

      getInbox(address: string): Chainable<InboxInfo>;

      deleteInbox(
        address: string
      ): Chainable<{ address: string; deleted: boolean; alreadyGone?: boolean }>;

      getMessages(address: string, filter?: ListFilter): Chainable<MessageList>;

      getMessage(address: string, messageId: string): Chainable<Message>;

      getOtp(address: string, messageId: string): Chainable<Otp>;

      getLinks(address: string, messageId: string): Chainable<Links>;

      /**
       * Wait for a message. Checks what is already in the inbox before waiting
       * for anything new, which matters because the API's long poll only
       * signals mail arriving and cannot see a message that landed first.
       */
      waitForMessage(
        address: string,
        options?: WaitOptions
      ): Chainable<MessageSummary>;

      waitForOtp(address: string, options?: WaitOptions): Chainable<Otp>;

      /** The verification code as a string. Fails if none was found. */
      waitForCode(address: string, options?: WaitOptions): Chainable<string>;

      waitForLinks(address: string, options?: WaitOptions): Chainable<Links>;

      /** The link the email wants clicked. Fails if none scores highly enough. */
      waitForActionUrl(address: string, options?: WaitOptions): Chainable<string>;

      /** Plan, quota and subscription. Works without an API key. */
      tempMailUsage(): Chainable<Usage>;

      tempMailDomains(): Chainable<string[]>;
    }
  }
}
