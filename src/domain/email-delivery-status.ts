/**
 * Per-recipient email delivery status — tracks whether an address has bounced
 * or generated a complaint via the provider feedback loop.
 *
 * Populated by the feedback webhook and read by the send path to suppress
 * further sends to that address. Default `ACTIVE` for every recipient.
 *
 * Three states, intentionally minimal — the bounce-reason taxonomy is stored
 * alongside as free text for ops triage; the enum is for routing decisions:
 *
 *   - ACTIVE: deliverable. The default.
 *   - BOUNCED: the provider classified the most recent send as a hard bounce
 *     (mailbox doesn't exist, address rejected at SMTP). Suppress until manual
 *     review.
 *   - COMPLAINED: recipient marked the message as spam (feedback loop).
 *     Suppress permanently — treat as an opt-out.
 *
 * Future states (deferred until ops asks): WARMING (greylist back-off),
 * SOFT_BOUNCED (transient, auto-recovers after N days), MAILBOX_FULL.
 */
export enum EmailDeliveryStatus {
  ACTIVE = 'active',
  BOUNCED = 'bounced',
  COMPLAINED = 'complained',
}

/** Whether this status suppresses outbound mail. */
export function suppressesDelivery(status: EmailDeliveryStatus): boolean {
  return status !== EmailDeliveryStatus.ACTIVE;
}
