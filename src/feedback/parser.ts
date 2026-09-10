import { EmailFeedbackResult } from '../domain/email-feedback-event';

/**
 * The slice of an inbound HTTP request a feedback adapter needs, decoupled from
 * any web framework.
 *
 * `rawBody` is the exact bytes as received, as a string. It MUST NOT be a
 * re-serialised parse of the JSON body: signature verification runs over the
 * literal payload, and `JSON.stringify(JSON.parse(body))` is not byte-identical
 * to it.
 */
export interface FeedbackRequest {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  clientIp?: string;
}

/**
 * Adapter for one email provider's delivery-feedback webhook.
 *
 * **This interface is permanent; the implementations are disposable.** We send
 * on AWS SES, which makes domain reputation our problem rather than a vendor's
 * — but that is a launch decision, not an architectural one. Moving to
 * SendGrid, Postmark or Resend must be a new class implementing this interface
 * plus one line of config, with nothing in the domain changing: suppression,
 * reputation and the delivery log only ever see {@link EmailFeedbackEvent}.
 *
 * An adapter owns exactly two vendor-shaped concerns:
 *
 *  1. **Authenticity** — proving the request really came from the provider.
 *     Every vendor does this differently (SNS: RSA signature over a canonical
 *     string; SendGrid: Ed25519 over timestamp+body; Postmark: HTTP basic).
 *     {@link verify} is fail-closed by contract: return false whenever the
 *     request cannot be positively authenticated, including when the adapter is
 *     unconfigured.
 *
 *  2. **Shape** — turning the payload into normalised events, and dropping the
 *     ones we deliberately do not act on (transient/soft bounces, handshakes,
 *     informational notices).
 */
export interface EmailFeedbackParser {
  /**
   * URL-safe provider slug — the `:provider` segment of the webhook route, e.g.
   * `ses`, `sendgrid`.
   *
   * Must be stable: it is baked into the URL configured at the provider, so
   * renaming it silently stops feedback arriving.
   */
  readonly providerCode: string;

  /**
   * Whether this request is genuinely from the provider.
   *
   * MUST fail closed — return false rather than throwing, and never return true
   * merely because verification is unconfigured. An unauthenticated feedback
   * endpoint lets anyone suppress arbitrary addresses, which is a
   * denial-of-delivery against our own users.
   */
  verify(request: FeedbackRequest): Promise<boolean>;

  /**
   * Normalise an authenticated request into events to apply. Called only after
   * {@link verify} has returned true.
   *
   * @throws EmailFeedbackParseError when the payload is malformed — i.e. it
   *         authenticated but is not shaped like anything this provider should
   *         be sending
   */
  parse(request: FeedbackRequest): Promise<EmailFeedbackResult>;
}
