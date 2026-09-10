import { EmailLogStatus } from '../domain/email-log-status';

/** One outbound attempt, as recorded at send time. */
export interface DeliveryLogEntry {
  recipientEmail: string;
  /** Identifier for the kind of mail sent — template name, notification class, event key. */
  notificationClass: string;
  template?: string | null;
  subject?: string | null;
  status: EmailLogStatus;
  providerMessageId?: string | null;
  errorMessage?: string | null;
}

/** A stored row, as read back by the admin console. */
export interface DeliveryLogRecord extends DeliveryLogEntry {
  id: string | number;
  feedbackAt?: Date | null;
  createdAt: Date;
}

export interface DeliveryLogQuery {
  status?: EmailLogStatus | null;
  recipient?: string | null;
  from?: Date | null;
  to?: Date | null;
  page: number;
  pageSize: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
}

/**
 * Per-recipient outbound email records — the delivery log the admin console
 * lists and searches.
 *
 * Intentionally separate from any generic in-app notification row: that spans a
 * whole notification across channels with no recipient or message id; this is
 * the email-specific, address-level audit.
 *
 * Implementations own their storage. The package ships an in-memory one; a host
 * supplies a database-backed adapter.
 */
export interface DeliveryLogStore {
  append(entry: DeliveryLogEntry): Promise<void>;

  /**
   * Flip a recipient's still-unresolved (SENT) rows to a terminal feedback
   * status with the feedback timestamp. Recipient-scoped correlation, used when
   * the provider gave us no message id to match on.
   *
   * @returns rows updated
   */
  markRecipientFeedback(email: string, status: EmailLogStatus, at: Date): Promise<number>;

  /**
   * Precise correlation — flip the row whose provider message id matches the
   * feedback's message id. Returns 0 when the id is on no row (e.g. sends that
   * went out over plain SMTP, whose RFC Message-ID the provider does not echo).
   */
  markByProviderMessageId(
    providerMessageId: string,
    status: EmailLogStatus,
    at: Date
  ): Promise<number>;

  /** Admin delivery-log list, newest first, filtered + paginated. */
  findPaginated(query: DeliveryLogQuery): Promise<Paginated<DeliveryLogRecord>>;

  /**
   * Count log rows grouped by status since a cutoff — the real delivery stats
   * behind the console.
   */
  countByStatusSince(since: Date): Promise<Record<string, number>>;

  /**
   * Retention prune — delete rows created before the cutoff. The per-send log is
   * an operational audit, not a system of record; the durable per-address
   * tallies live in the reputation store, which is never pruned.
   *
   * @returns rows deleted
   */
  deleteOlderThan(cutoff: Date): Promise<number>;
}
