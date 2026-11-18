export type Confidence = "high" | "medium" | "low" | "none";

export type LinkType =
  | "action"
  | "unsubscribe"
  | "social"
  | "legal"
  | "tracking"
  | "view_in_browser"
  | "other";

/**
 * Dates are ISO 8601 strings, not Date objects, because everything returned
 * here crosses Cypress's task boundary and is serialized on the way.
 */
export interface Inbox {
  address: string;
  createdAt: string | null;
  expiresAt: string | null;
  lifetimeMinutes: number | null;
  /** Set when the server clamped the requested lifetime to the plan maximum. */
  note: string | null;
}

export interface InboxInfo {
  address: string;
  createdAt: string | null;
  expiresAt: string | null;
  messageCount: number;
}

export interface BulkResult {
  count: number;
  /** One request of quota per inbox, so 25 charges 25. */
  quotaCharged: number;
  lifetimeMinutes: number | null;
  inboxes: Inbox[];
  addresses: string[];
}

export interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  date: string | null;
  hasAttachments: boolean;
}

export interface Attachment {
  /** What the download takes. The server owns this number. */
  index: number;
  filename: string;
  mime: string;
  size: number;
  /** Whether the current plan may fetch the bytes. */
  downloadable: boolean;
  /** The plan needed when downloadable is false, such as "pro". */
  requiresPlan: string | null;
}

export interface Message extends MessageSummary {
  to: string;
  text: string;
  html: string;
  attachments: Attachment[];
}

export interface MessageList {
  address: string;
  messages: MessageSummary[];
  limit: number;
  offset: number;
  returned: number;
  hasMore: boolean;
  /** How many messages were examined to build this page. */
  scanned: number;
  /**
   * True when the search stopped at its ceiling with the page unfilled.
   *
   * Empty with this false means nothing matches, definitively. Empty with it
   * true means the message may exist further back.
   */
  scanLimitReached: boolean;
}

export interface OtpCandidate {
  code: string;
  score: number;
}

export interface Otp {
  messageId: string;
  /** Empty when nothing scored highly enough. A string, so leading zeros survive. */
  code: string;
  confidence: Confidence;
  candidates: OtpCandidate[];
}

export interface Link {
  url: string;
  unwrappedUrl: string | null;
  text: string;
  type: LinkType;
  score: number;
  /** The unwrapped URL where there is one, otherwise the URL. */
  destination: string;
}

export interface Links {
  messageId: string;
  /** Empty when nothing scored highly enough. */
  actionUrl: string;
  confidence: Confidence;
  links: Link[];
}

export interface Usage {
  plan: string;
  paid: boolean;
  hourly: {
    limit: number;
    used: number;
    remaining: number;
    resetsAt: string | null;
    resetsInSeconds: number;
  };
  lifetimeRequests: number;
  key: {
    id: number;
    lastFour: string;
    status: string;
    createdAt: string | null;
    lastUsedAt: string | null;
  } | null;
  subscription: {
    status: string;
    expiresAt: string | null;
    daysRemaining: number;
    inGracePeriod: boolean;
  } | null;
  /** Null means no daily cap applies; zero means the cap applies and none used. */
  inboxesCreatedToday: number | null;
  upgradeUrl: string | null;
}

export interface CreateInboxOptions {
  username?: string;
  domain?: string;
  lifetimeMinutes?: number;
}

export interface BulkCreateOptions {
  count: number;
  domain?: string;
  lifetimeMinutes?: number;
}

export interface ListFilter {
  limit?: number;
  offset?: number;
  from?: string;
  subject?: string;
  q?: string;
  since?: string;
  until?: string;
  hasAttachments?: boolean;
}

export interface WaitOptions {
  /**
   * Narrow which message counts as the one being waited for.
   *
   * Worth setting. Without a filter the first message to arrive wins, and in a
   * real signup a welcome email often beats the verification email.
   */
  from?: string;
  subject?: string;
  q?: string;
  timeoutMs?: number;
}

export declare class ApiError extends Error {
  status: number;
  detail: string;
  requestId: string | null;
  upgrade: string | null;
  retryAfter: number | null;
  readonly isUnauthorized: boolean;
  readonly isPaymentRequired: boolean;
  readonly isNotFound: boolean;
  readonly isRateLimited: boolean;
}

export declare class NoMessageError extends Error {
  address: string;
  waitedMs: number;
}

export interface TempMailClient {
  createInbox(options?: CreateInboxOptions): Promise<Inbox>;
  bulkCreateInboxes(options: BulkCreateOptions | number): Promise<BulkResult>;
  inbox(address: string): Promise<InboxInfo>;
  deleteInbox(
    address: string
  ): Promise<{ address: string; deleted: boolean; alreadyGone?: boolean }>;
  messages(address: string, filter?: ListFilter): Promise<MessageList>;
  message(address: string, messageId: string): Promise<Message>;
  otp(address: string, messageId: string): Promise<Otp>;
  links(address: string, messageId: string): Promise<Links>;
  usage(): Promise<Usage>;
  domains(): Promise<string[]>;
  health(): Promise<{ status: string; version: string }>;
  waitForMessage(address: string, options?: WaitOptions): Promise<MessageSummary>;
  waitForOtp(address: string, options?: WaitOptions): Promise<Otp>;
  waitForCode(address: string, options?: WaitOptions): Promise<string>;
  waitForLinks(address: string, options?: WaitOptions): Promise<Links>;
  waitForActionUrl(address: string, options?: WaitOptions): Promise<string>;
}

export interface BestTempMailPluginOptions {
  /** Overrides both BTM_API_KEY sources. */
  apiKey?: string;
  /** For pointing at a mock. */
  baseUrl?: string;
}

/**
 * Register the tasks. Call this from setupNodeEvents and return its result,
 * which is the Cypress config with the API key stripped out of env so it is
 * not sent to the browser.
 */
export declare function bestTempMail<T>(
  on: (action: "task", handlers: Record<string, unknown>) => void,
  config: T,
  options?: BestTempMailPluginOptions
): T;

export declare function createClient(options?: {
  apiKey?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): TempMailClient;

export declare const DEFAULT_BASE_URL: string;
