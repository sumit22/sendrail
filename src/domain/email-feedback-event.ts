import { EmailFeedbackType } from './email-feedback-type';

/**
 * One normalised delivery outcome for one recipient.
 *
 * The boundary object between "some vendor's webhook shape" and our domain.
 * A provider adapter's whole job is to turn its payload into a list of these;
 * nothing downstream knows which vendor produced it.
 *
 * Note it is per-RECIPIENT, not per-message: SES reports a bounce for several
 * addresses in one payload, SendGrid posts an array of single-recipient events.
 * Flattening to one-event-per-recipient here means the processor handles both
 * without caring.
 */
export interface EmailFeedbackEvent {
  readonly type: EmailFeedbackType;
  /** The address the outcome applies to. */
  readonly recipientEmail: string;
  /** Provider diagnostic (bounce code, complaint type) — stored for operators, never parsed. */
  readonly reason?: string | null;
  /** When the provider says it happened; null falls back to receipt time. */
  readonly occurredAt?: Date | null;
  /**
   * The provider's own message id, when supplied — lets the delivery log
   * correlate the exact row instead of the recipient's most recent one.
   */
  readonly providerMessageId?: string | null;
}

/**
 * What a provider adapter made of one webhook request.
 *
 * Not every valid webhook carries feedback. SNS opens with a
 * `SubscriptionConfirmation` handshake; SES emits informational
 * `DeliveryDelay`; SendGrid batches can contain event types we do not act on.
 * Those are successful, uninteresting requests — not errors — so the result
 * carries a short machine-readable `status` alongside the events, and the
 * controller echoes it back for operator visibility without needing to know
 * which vendor produced it.
 */
export interface EmailFeedbackResult {
  /** Events to apply, possibly empty. */
  readonly events: EmailFeedbackEvent[];
  /** Short outcome slug, e.g. `processed`, `soft_bounce_ignored`. */
  readonly status: string;
}

export function feedbackResult(
  events: EmailFeedbackEvent[],
  status = 'processed'
): EmailFeedbackResult {
  return { events, status };
}

/**
 * A well-formed request that carries nothing to apply — a handshake, or an
 * event type we deliberately ignore. Distinct from a parse failure, which the
 * adapter signals by throwing {@link EmailFeedbackParseError}.
 */
export function acknowledged(status: string): EmailFeedbackResult {
  return { events: [], status };
}
