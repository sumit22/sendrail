/** A sender identity — address plus the display name that shows in the inbox. */
export interface EmailAddress {
  email: string;
  name?: string | null;
}

/** A fully-rendered message, ready to hand to a provider. */
export interface OutboundEmail {
  to: string;
  from: EmailAddress;
  subject: string;
  /** Omitted for a text-only message, which composes as a single `text/plain` part. */
  html?: string;
  /** Plain-text alternative. Derived from the HTML when the caller omits it. */
  text?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  /** Extra headers, e.g. `List-Unsubscribe`. */
  headers?: Record<string, string>;
}

export interface SendResult {
  /**
   * The provider's message id, when it returns one.
   *
   * Under the SES API this is the SES message id, which matches the
   * `mail.messageId` on the SES→SNS feedback event — an exact correlation.
   * Under plain SMTP it is the RFC Message-ID, which the provider does not echo
   * back, so it is recorded but not correlatable.
   */
  providerMessageId?: string;
}

/**
 * One way of physically sending a message.
 *
 * Implementations throw {@link EmailTransportError} on failure — the send path
 * treats a throw as retryable and records the reason on the delivery log.
 */
export interface EmailTransport {
  /** Short slug for logs and diagnostics, e.g. `ses`, `smtp`, `logging`. */
  readonly name: string;
  send(message: OutboundEmail): Promise<SendResult>;
}
