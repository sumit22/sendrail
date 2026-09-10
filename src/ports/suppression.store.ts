import { EmailDeliveryStatus } from '../domain/email-delivery-status';
import { Paginated } from './delivery-log.store';

export interface SuppressedAddress {
  email: string;
  status: EmailDeliveryStatus;
  reason?: string | null;
  suppressedAt?: Date | null;
}

/**
 * The suppression list — addresses we must not mail.
 *
 * Keyed by EMAIL ADDRESS, not by an internal user id: provider feedback carries
 * the recipient address and nothing else. Implementations should match
 * case-insensitively; providers normalise addresses to lowercase in feedback
 * events and stored addresses may not be.
 *
 * An address with no corresponding record is not suppressed — recording a
 * bounce for an address we have never heard of is a no-op, not an error.
 */
export interface SuppressionStore {
  isSuppressed(email: string): Promise<boolean>;

  /**
   * Which of `emails` are suppressed, lowercased.
   *
   * The bulk form of {@link isSuppressed}, for screening a whole imported list
   * before anything is sent. Calling the single form per address turns a
   * few-hundred-row import into a few hundred round trips, and the rule for
   * what counts as suppressed should not be restated by the caller to avoid it.
   */
  findSuppressedAmong(emails: string[]): Promise<string[]>;

  /**
   * Record a terminal delivery outcome against an address. Idempotent —
   * repeated events for the same address overwrite the reason and timestamp
   * without changing the status.
   */
  record(email: string, status: EmailDeliveryStatus, reason: string, at: Date): Promise<void>;

  /** Lift a suppression — an operator's "this mailbox is fixed, try again". */
  release(email: string): Promise<void>;

  /** Suppressed addresses, newest suppression first, for the admin console. */
  findSuppressedPaginated(page: number, pageSize: number): Promise<Paginated<SuppressedAddress>>;
}
