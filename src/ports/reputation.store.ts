import { Paginated } from './delivery-log.store';

export interface ReputationRecord {
  email: string;
  domain: string;
  sentCount: number;
  deliveredCount: number;
  bounceCount: number;
  complaintCount: number;
  lastSentAt?: Date | null;
  lastEventAt?: Date | null;
}

export interface DomainRollupRow {
  domain: string;
  addresses: number;
  sent: number;
  delivered: number;
  bounce: number;
  complaint: number;
}

/** Which counter an increment targets. */
export type ReputationCounter = 'sent' | 'delivered' | 'bounce' | 'complaint';

/**
 * Per-address delivery reputation — a rollup of sent/delivered/bounced/
 * complained counts, and the durable half of the feedback record (the delivery
 * log is pruned; this is not).
 *
 * Increments MUST be atomic upserts (`INSERT … ON CONFLICT DO UPDATE`), not
 * read-modify-write: sends and feedback webhooks race, and a lost update here
 * silently understates a bad address.
 */
export interface ReputationStore {
  /**
   * Bump one counter for an address, creating the row if absent. Best-effort by
   * contract: an implementation must swallow its own errors rather than break a
   * send or a webhook.
   *
   * `sent` stamps the last-sent timestamp; every other counter stamps
   * last-event.
   */
  increment(email: string, counter: ReputationCounter, at: Date): Promise<void>;

  findPaginated(query: {
    emailSearch?: string | null;
    domain?: string | null;
    page: number;
    pageSize: number;
  }): Promise<Paginated<ReputationRecord>>;

  /**
   * Per-recipient-domain rollup, worst bounce counts first.
   *
   * @param customOnly exclude public mailbox providers, whose aggregate bounce
   *                   rate says nothing about our list and dominates volume
   */
  domainRollup(customOnly: boolean, limit: number): Promise<DomainRollupRow[]>;
}

/**
 * Public mailbox providers excluded from the "custom domains" rollup.
 */
export const PUBLIC_MAILBOX_PROVIDERS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'yahoo.co.in',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
];
