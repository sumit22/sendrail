import { EmailLogStatus } from './email-log-status';

/**
 * What an email provider told us happened to a message, expressed in our own
 * terms rather than theirs.
 *
 * Deliberately small and provider-neutral. SES says `Bounce`/`Complaint`/
 * `Delivery`; SendGrid says `bounce`/`spamreport`/`delivered`; Postmark says
 * `HardBounce`/`SpamComplaint`/`Delivery`. All of them normalise onto these
 * three, and everything downstream (suppression, reputation, delivery log)
 * only ever sees this enum — so swapping providers cannot reach the domain.
 *
 * Transient events (SES soft bounce, SendGrid `deferred`) are NOT represented:
 * a provider retries those itself, and recording them would over-suppress
 * addresses that are fine. Each parser drops them before this point.
 */
export enum EmailFeedbackType {
  /** The provider confirmed the message reached the recipient's mail server. */
  DELIVERED = 'delivered',

  /**
   * Permanent delivery failure. Suppresses the address — sending again cannot
   * succeed and costs sender reputation.
   */
  BOUNCED = 'bounced',

  /**
   * Recipient marked the message as spam. Suppresses the address; a complaint
   * is the strongest signal to stop sending there.
   */
  COMPLAINED = 'complained',
}

/**
 * Whether this outcome should stop us mailing the address.
 *
 * The single place that decision lives — a new provider adapter cannot
 * accidentally disagree about what suppresses.
 */
export function suppressesRecipient(type: EmailFeedbackType): boolean {
  return type === EmailFeedbackType.BOUNCED || type === EmailFeedbackType.COMPLAINED;
}

/** How this outcome is recorded on the delivery log. */
export function toLogStatus(type: EmailFeedbackType): EmailLogStatus {
  switch (type) {
    case EmailFeedbackType.DELIVERED:
      return EmailLogStatus.DELIVERED;
    case EmailFeedbackType.BOUNCED:
      return EmailLogStatus.BOUNCED;
    case EmailFeedbackType.COMPLAINED:
      return EmailLogStatus.COMPLAINED;
  }
}
