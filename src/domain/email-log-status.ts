/**
 * Lifecycle of a single outbound email in the delivery log (the console's
 * per-recipient record). Distinct from {@link EmailDeliveryStatus}, which is the
 * per-address suppression flag.
 *
 * SENT = handed to the provider successfully. DELIVERED / BOUNCED / COMPLAINED
 * are set later from the provider's feedback webhook, correlated by provider
 * message id. FAILED = the send threw (provider error, e.g. quota exceeded).
 * SUPPRESSED = skipped before send because the address was on the suppression
 * list or failed pre-send validation.
 */
export enum EmailLogStatus {
  SENT = 'sent',
  DELIVERED = 'delivered',
  BOUNCED = 'bounced',
  COMPLAINED = 'complained',
  FAILED = 'failed',
  SUPPRESSED = 'suppressed',
}

export function isTerminalFailure(status: EmailLogStatus): boolean {
  return (
    status === EmailLogStatus.BOUNCED ||
    status === EmailLogStatus.COMPLAINED ||
    status === EmailLogStatus.FAILED
  );
}
