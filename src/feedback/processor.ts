import { EmailDeliveryStatus } from '../domain/email-delivery-status';
import { EmailFeedbackEvent } from '../domain/email-feedback-event';
import { EmailFeedbackType, suppressesRecipient, toLogStatus } from '../domain/email-feedback-type';
import { EmailLogStatus } from '../domain/email-log-status';
import { DeliveryLogStore } from '../ports/delivery-log.store';
import { EmailLogger, NULL_LOGGER } from '../ports/logger';
import { ReputationCounter, ReputationStore } from '../ports/reputation.store';
import { SuppressionStore } from '../ports/suppression.store';

export interface EmailFeedbackProcessorDeps {
  suppression: SuppressionStore;
  reputation: ReputationStore;
  deliveryLog: DeliveryLogStore;
  logger?: EmailLogger;
}

/**
 * Applies normalised delivery feedback to the domain.
 *
 * The vendor-free half of the feedback loop, and the only place that decides
 * what a bounce or a complaint actually DOES:
 *
 *   - suppression — stop sending to the address (bounce/complaint only)
 *   - reputation  — per-address counters behind the admin email dashboards
 *   - delivery log — flip the message's row so operators can see what happened
 *
 * Keeping this out of the provider adapter means a second provider gets the
 * behaviour for free — and, more usefully, cannot get it subtly *different*.
 *
 * Every step is best-effort and independent: a reputation-counter failure must
 * not stop the suppression write, because suppression is the one with teeth.
 */
export class EmailFeedbackProcessor {
  private readonly suppression: SuppressionStore;
  private readonly reputation: ReputationStore;
  private readonly deliveryLog: DeliveryLogStore;
  private readonly logger: EmailLogger;

  constructor(deps: EmailFeedbackProcessorDeps) {
    this.suppression = deps.suppression;
    this.reputation = deps.reputation;
    this.deliveryLog = deps.deliveryLog;
    this.logger = deps.logger ?? NULL_LOGGER;
  }

  /**
   * Apply a batch, returning how many events were applied.
   *
   * Sequential, not concurrent: several events in one payload routinely target
   * the same address, and the stores' upserts are cheaper uncontended than
   * racing each other on the same row.
   */
  async processAll(events: readonly EmailFeedbackEvent[]): Promise<number> {
    let applied = 0;
    for (const event of events) {
      if (await this.process(event)) {
        applied += 1;
      }
    }
    return applied;
  }

  /**
   * @returns whether the event was applied (false = ignored, e.g. blank address)
   */
  async process(event: EmailFeedbackEvent): Promise<boolean> {
    const email = (event.recipientEmail ?? '').trim();
    if (email === '') {
      return false;
    }

    const at = event.occurredAt ?? new Date();

    // Suppression first — it is the consequential one. If anything below fails
    // we still want to have stopped mailing a dead address.
    if (suppressesRecipient(event.type)) {
      const reason = event.reason ?? event.type;
      const status =
        event.type === EmailFeedbackType.BOUNCED
          ? EmailDeliveryStatus.BOUNCED
          : EmailDeliveryStatus.COMPLAINED;

      await this.attempt('suppression', email, () =>
        this.suppression.record(email, status, reason, at)
      );
    }

    await this.attempt('reputation', email, () =>
      this.reputation.increment(email, REPUTATION_COUNTER[event.type], at)
    );

    await this.markDeliveryLog(event, toLogStatus(event.type), email, at);

    this.logger.log('Email feedback applied', {
      type: event.type,
      recipient: email,
      providerMessageId: event.providerMessageId ?? null,
    });

    return true;
  }

  /**
   * Flip the delivery-log row this outcome belongs to.
   *
   * The provider's message id is tried FIRST and the recipient-scoped update is
   * only a fallback, because the two are not equally precise. Several messages
   * to one address can be in flight at once, and the recipient-scoped update
   * flips every one of them — so running it first both mismarks the siblings and
   * leaves the precise update nothing to match. Under the SES API the message id
   * is always present and this resolves exactly one row; the fallback is for
   * sends that went out over SMTP, which echo no id back.
   */
  private async markDeliveryLog(
    event: EmailFeedbackEvent,
    logStatus: EmailLogStatus,
    email: string,
    at: Date
  ): Promise<void> {
    let correlated = 0;

    if (event.providerMessageId) {
      const messageId = event.providerMessageId;
      correlated = await this.attemptCount('delivery log correlation', email, () =>
        this.deliveryLog.markByProviderMessageId(messageId, logStatus, at)
      );
    }

    if (correlated === 0) {
      await this.attempt('delivery log', email, () =>
        this.deliveryLog.markRecipientFeedback(email, logStatus, at).then(() => undefined)
      );
    }
  }

  /**
   * Run one effect, logging and swallowing its failure. Each of the three
   * effects is independent: the whole point of the ordering above is that a
   * later one failing cannot undo an earlier one.
   */
  private async attempt(what: string, email: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.warn(`Email feedback: ${what} write failed`, {
        recipient: email,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * As {@link attempt}, for an effect whose row count decides what happens next.
   * A failure reports 0 so the caller falls back rather than assuming the write
   * landed.
   */
  private async attemptCount(
    what: string,
    email: string,
    run: () => Promise<number>
  ): Promise<number> {
    try {
      return await run();
    } catch (error) {
      this.logger.warn(`Email feedback: ${what} write failed`, {
        recipient: email,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}

const REPUTATION_COUNTER: Record<EmailFeedbackType, ReputationCounter> = {
  [EmailFeedbackType.DELIVERED]: 'delivered',
  [EmailFeedbackType.BOUNCED]: 'bounce',
  [EmailFeedbackType.COMPLAINED]: 'complaint',
};
