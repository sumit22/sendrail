import { EmailDeliveryStatus } from '../domain/email-delivery-status';
import { EmailLogStatus } from '../domain/email-log-status';
import {
  DeliveryLogEntry,
  DeliveryLogQuery,
  DeliveryLogRecord,
  DeliveryLogStore,
  Paginated,
} from '../ports/delivery-log.store';
import {
  DomainRollupRow,
  PUBLIC_MAILBOX_PROVIDERS,
  ReputationCounter,
  ReputationRecord,
  ReputationStore,
} from '../ports/reputation.store';
import { SuppressedAddress, SuppressionStore } from '../ports/suppression.store';

/**
 * Process-local implementations of the three storage ports.
 *
 * For tests, and for a host that wants the send path working before it has
 * decided where the tables live. Everything is lost on restart — a suppression
 * list that forgets is worse than useless in production, so wire real stores
 * before sending real mail.
 */

export class InMemoryDeliveryLogStore implements DeliveryLogStore {
  private readonly rows: DeliveryLogRecord[] = [];
  private nextId = 1;

  async append(entry: DeliveryLogEntry): Promise<void> {
    this.rows.push({ ...entry, id: this.nextId++, createdAt: new Date(), feedbackAt: null });
  }

  async markRecipientFeedback(email: string, status: EmailLogStatus, at: Date): Promise<number> {
    return this.mark((row) => row.recipientEmail.toLowerCase() === email.toLowerCase(), status, at);
  }

  async markByProviderMessageId(
    providerMessageId: string,
    status: EmailLogStatus,
    at: Date
  ): Promise<number> {
    return this.mark((row) => row.providerMessageId === providerMessageId, status, at);
  }

  async findPaginated(query: DeliveryLogQuery): Promise<Paginated<DeliveryLogRecord>> {
    const matches = this.rows
      .filter((row) => !query.status || row.status === query.status)
      .filter(
        (row) =>
          !query.recipient ||
          row.recipientEmail.toLowerCase().includes(query.recipient.toLowerCase())
      )
      .filter((row) => !query.from || row.createdAt >= query.from)
      .filter((row) => !query.to || row.createdAt <= query.to)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const start = Math.max(0, (query.page - 1) * query.pageSize);

    return { items: matches.slice(start, start + query.pageSize), total: matches.length };
  }

  async countByStatusSince(since: Date): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of this.rows) {
      if (row.createdAt < since) {
        continue;
      }
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    return counts;
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    let deleted = 0;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i].createdAt < cutoff) {
        this.rows.splice(i, 1);
        deleted += 1;
      }
    }
    return deleted;
  }

  /**
   * Only rows still awaiting feedback are flipped. A row already marked
   * DELIVERED must not be rewritten by a later complaint for the same address —
   * that is a different message, and recipient-scoped correlation cannot tell
   * them apart.
   */
  private mark(
    matches: (row: DeliveryLogRecord) => boolean,
    status: EmailLogStatus,
    at: Date
  ): number {
    let updated = 0;
    for (const row of this.rows) {
      if (row.status === EmailLogStatus.SENT && matches(row)) {
        row.status = status;
        row.feedbackAt = at;
        updated += 1;
      }
    }
    return updated;
  }
}

export class InMemoryReputationStore implements ReputationStore {
  private readonly byEmail = new Map<string, ReputationRecord>();

  async increment(email: string, counter: ReputationCounter, at: Date): Promise<void> {
    const key = email.trim().toLowerCase();
    if (key === '') {
      return;
    }

    const record = this.byEmail.get(key) ?? {
      email: key,
      domain: key.slice(key.lastIndexOf('@') + 1),
      sentCount: 0,
      deliveredCount: 0,
      bounceCount: 0,
      complaintCount: 0,
      lastSentAt: null,
      lastEventAt: null,
    };

    switch (counter) {
      case 'sent':
        record.sentCount += 1;
        record.lastSentAt = at;
        break;
      case 'delivered':
        record.deliveredCount += 1;
        record.lastEventAt = at;
        break;
      case 'bounce':
        record.bounceCount += 1;
        record.lastEventAt = at;
        break;
      case 'complaint':
        record.complaintCount += 1;
        record.lastEventAt = at;
        break;
    }

    this.byEmail.set(key, record);
  }

  async findPaginated(query: {
    emailSearch?: string | null;
    domain?: string | null;
    page: number;
    pageSize: number;
  }): Promise<Paginated<ReputationRecord>> {
    const matches = [...this.byEmail.values()]
      .filter((row) => !query.emailSearch || row.email.includes(query.emailSearch.toLowerCase()))
      .filter((row) => !query.domain || row.domain === query.domain.toLowerCase())
      .sort((a, b) => b.bounceCount - a.bounceCount || b.complaintCount - a.complaintCount);

    const start = Math.max(0, (query.page - 1) * query.pageSize);

    return { items: matches.slice(start, start + query.pageSize), total: matches.length };
  }

  async domainRollup(customOnly: boolean, limit: number): Promise<DomainRollupRow[]> {
    const byDomain = new Map<string, DomainRollupRow>();

    for (const record of this.byEmail.values()) {
      if (customOnly && PUBLIC_MAILBOX_PROVIDERS.includes(record.domain)) {
        continue;
      }

      const row = byDomain.get(record.domain) ?? {
        domain: record.domain,
        addresses: 0,
        sent: 0,
        delivered: 0,
        bounce: 0,
        complaint: 0,
      };

      row.addresses += 1;
      row.sent += record.sentCount;
      row.delivered += record.deliveredCount;
      row.bounce += record.bounceCount;
      row.complaint += record.complaintCount;

      byDomain.set(record.domain, row);
    }

    return [...byDomain.values()]
      .sort((a, b) => b.bounce - a.bounce || b.sent - a.sent)
      .slice(0, limit);
  }
}

export class InMemorySuppressionStore implements SuppressionStore {
  private readonly byEmail = new Map<string, SuppressedAddress>();

  async isSuppressed(email: string): Promise<boolean> {
    const record = this.byEmail.get(email.trim().toLowerCase());
    return record !== undefined && record.status !== EmailDeliveryStatus.ACTIVE;
  }

  async findSuppressedAmong(emails: string[]): Promise<string[]> {
    const suppressed: string[] = [];

    for (const email of new Set(emails.map((value) => value.trim().toLowerCase()))) {
      if (email !== '' && (await this.isSuppressed(email))) {
        suppressed.push(email);
      }
    }

    return suppressed;
  }

  async record(
    email: string,
    status: EmailDeliveryStatus,
    reason: string,
    at: Date
  ): Promise<void> {
    const key = email.trim().toLowerCase();
    if (key === '') {
      return;
    }
    this.byEmail.set(key, { email: key, status, reason, suppressedAt: at });
  }

  async release(email: string): Promise<void> {
    this.byEmail.delete(email.trim().toLowerCase());
  }

  async findSuppressedPaginated(
    page: number,
    pageSize: number
  ): Promise<Paginated<SuppressedAddress>> {
    const matches = [...this.byEmail.values()]
      .filter((row) => row.status !== EmailDeliveryStatus.ACTIVE)
      .sort((a, b) => (b.suppressedAt?.getTime() ?? 0) - (a.suppressedAt?.getTime() ?? 0));

    const start = Math.max(0, (page - 1) * pageSize);

    return { items: matches.slice(start, start + pageSize), total: matches.length };
  }
}
