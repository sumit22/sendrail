import { DeliveryLogStore } from '../ports/delivery-log.store';
import { EmailLogger, NULL_LOGGER } from '../ports/logger';

/** Days of per-send delivery log kept by default. */
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * Retention prune for the delivery log.
 *
 * The per-send log is an operational audit, not a system of record, so it is
 * capped at a short window. The durable per-address tallies live in the
 * reputation store, which is never pruned — so "how often has this address
 * bounced" survives long after the individual rows are gone.
 *
 * Run daily.
 */
export class DeliveryLogPruner {
  constructor(
    private readonly deliveryLog: DeliveryLogStore,
    private readonly retentionDays: number = DEFAULT_RETENTION_DAYS,
    private readonly logger: EmailLogger = NULL_LOGGER
  ) {}

  /** @returns rows deleted */
  async prune(retentionDays: number = this.retentionDays): Promise<number> {
    const days = Math.max(1, Math.trunc(retentionDays));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const deleted = await this.deliveryLog.deleteOlderThan(cutoff);

    this.logger.log('Email delivery log pruned', {
      retentionDays: days,
      cutoff: cutoff.toISOString(),
      deleted,
    });

    return deleted;
  }
}
