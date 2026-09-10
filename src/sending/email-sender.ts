import { convert } from 'html-to-text';
import { EmailLogStatus } from '../domain/email-log-status';
import { DeliveryLogStore } from '../ports/delivery-log.store';
import { EmailLogger, NULL_LOGGER } from '../ports/logger';
import { ReputationStore } from '../ports/reputation.store';
import { SuppressionStore } from '../ports/suppression.store';
import { EmailAddress, EmailTransport, OutboundEmail } from '../ports/transport';
import { EmailAddressValidator, RejectionReason } from '../validation/email-address-validator';

export interface SendEmailRequest {
  to: string;
  subject: string;
  /**
   * Optional so a message can be sent as plain text alone. Cold outreach reads
   * as a personal note, and an HTML alternative is precisely the tell that
   * marks a message as bulk — so it must be possible to send without one.
   *
   * At least one of `html` and `text` must be present; a request with neither
   * is recorded FAILED rather than mailing an empty body.
   */
  html?: string;
  /** Omit to derive a plain-text alternative from the HTML actually sent. */
  text?: string;
  from?: EmailAddress;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  headers?: Record<string, string>;
  /**
   * What kind of mail this is — a template name or event key. Recorded on the
   * delivery log so operators can see which mail is bouncing, not just that
   * mail is.
   */
  notificationClass?: string;
  /** The template that produced the body, when one did. */
  template?: string;
}

export type SkipReason = 'suppressed' | RejectionReason;

export interface SendOutcome {
  status: EmailLogStatus;
  providerMessageId?: string;
  /** Why it was not sent, when the status is SUPPRESSED. */
  skippedReason?: SkipReason;
  /** The provider or composition failure, when the status is FAILED. */
  error?: Error;
}

export interface EmailSenderDeps {
  transport: EmailTransport;
  validator: EmailAddressValidator;
  suppression: SuppressionStore;
  deliveryLog: DeliveryLogStore;
  reputation: ReputationStore;
  defaultFrom: EmailAddress;
  logger?: EmailLogger;
}

/**
 * The outbound send path: validate → check suppression → send → record.
 *
 * Two gates stand between a message and the provider, and both exist to protect
 * sender reputation rather than the recipient:
 *
 *   1. **Hard address validation**, before any vendor call — a malformed or
 *      tampered address never reaches SES, so it never becomes a bounce.
 *   2. **Suppression** — an address SES has already told us is dead or hostile.
 *      Retrying it damages our sending reputation, and a bad enough rate gets
 *      the whole account put under enforcement.
 *
 * Both refusals are recorded as SUPPRESSED rows rather than dropped silently:
 * "we chose not to send this" is an answer operators need, and a gap in the log
 * is not one.
 *
 * A provider failure is recorded as FAILED and returned, never thrown. The
 * caller decides whether to retry — this class's job is that the reason is
 * durably written down before it hands the decision back.
 */
export class EmailSender {
  private readonly transport: EmailTransport;
  private readonly validator: EmailAddressValidator;
  private readonly suppression: SuppressionStore;
  private readonly deliveryLog: DeliveryLogStore;
  private readonly reputation: ReputationStore;
  private readonly defaultFrom: EmailAddress;
  private readonly logger: EmailLogger;

  constructor(deps: EmailSenderDeps) {
    this.transport = deps.transport;
    this.validator = deps.validator;
    this.suppression = deps.suppression;
    this.deliveryLog = deps.deliveryLog;
    this.reputation = deps.reputation;
    this.defaultFrom = deps.defaultFrom;
    this.logger = deps.logger ?? NULL_LOGGER;
  }

  async send(request: SendEmailRequest): Promise<SendOutcome> {
    const recipient = (request.to ?? '').trim();
    const notificationClass = request.notificationClass ?? request.template ?? 'email';

    const skipReason = await this.shouldSkip(recipient);
    if (skipReason) {
      this.logger.warn('Email not sent — recipient failed a pre-send gate', {
        recipient,
        reason: skipReason,
        notificationClass,
      });

      await this.record(recipient, request, EmailLogStatus.SUPPRESSED, {
        errorMessage: skipReason,
      });

      return { status: EmailLogStatus.SUPPRESSED, skippedReason: skipReason };
    }

    // A message with no body at all is a caller bug, and mailing it would spend
    // sending reputation on a blank email. Recorded FAILED like any other
    // composition failure, so it shows up in the delivery log rather than
    // vanishing.
    if (!hasBody(request)) {
      const failure = new Error('Email has neither an html nor a text body');

      await this.record(recipient, request, EmailLogStatus.FAILED, {
        errorMessage: failure.message,
      });

      this.logger.warn('Email not sent — no body', { recipient, notificationClass });

      return { status: EmailLogStatus.FAILED, error: failure };
    }

    const message = this.compose(recipient, request);

    try {
      const result = await this.transport.send(message);

      await this.record(recipient, request, EmailLogStatus.SENT, {
        providerMessageId: result.providerMessageId,
      });

      this.logger.log('Email sent', {
        recipient,
        notificationClass,
        transport: this.transport.name,
        providerMessageId: result.providerMessageId ?? null,
      });

      return { status: EmailLogStatus.SENT, providerMessageId: result.providerMessageId };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));

      await this.record(recipient, request, EmailLogStatus.FAILED, {
        errorMessage: failure.message,
      });

      // WARN, not ERROR, deliberately: a transport failure is usually transient
      // (an SMTP timeout, a throttle) and the caller's retry succeeds seconds
      // later. Paging on a condition that heals itself buries the signal. The
      // terminal failure — retries exhausted — is the caller's to report, and
      // that is the one worth alerting on.
      this.logger.warn('Email send failed', {
        recipient,
        notificationClass,
        transport: this.transport.name,
        error: failure.message,
      });

      return { status: EmailLogStatus.FAILED, error: failure };
    }
  }

  /**
   * Whether either pre-send gate refuses this address, and which one. Validation
   * runs first: it is a local computation, while suppression is a store read.
   */
  private async shouldSkip(recipient: string): Promise<SkipReason | null> {
    if (recipient === '') {
      return 'invalid_syntax';
    }

    const rejection = await this.validator.rejectionReason(recipient);
    if (rejection) {
      return rejection;
    }

    return (await this.suppression.isSuppressed(recipient)) ? 'suppressed' : null;
  }

  private compose(recipient: string, request: SendEmailRequest): OutboundEmail {
    return {
      to: recipient,
      from: request.from ?? this.defaultFrom,
      subject: request.subject,
      html: request.html,
      // Derived from the HTML actually sent, so the two parts can never drift
      // and there is no separate text template to maintain. Left undefined for
      // a text-only message so no HTML alternative is attached at all.
      text: request.text ?? (request.html === undefined ? undefined : toPlainText(request.html)),
      replyTo: request.replyTo,
      cc: request.cc,
      bcc: request.bcc,
      headers: request.headers,
    };
  }

  /**
   * Append the delivery-log row and bump the sent counter.
   *
   * Best-effort: a bookkeeping failure must never break the send path, or turn
   * a successful send into a failure.
   */
  private async record(
    recipient: string,
    request: SendEmailRequest,
    status: EmailLogStatus,
    extra: { providerMessageId?: string; errorMessage?: string }
  ): Promise<void> {
    if (recipient === '') {
      return;
    }

    try {
      await this.deliveryLog.append({
        recipientEmail: recipient,
        notificationClass: request.notificationClass ?? request.template ?? 'email',
        template: request.template ?? null,
        subject: request.subject ?? null,
        status,
        providerMessageId: extra.providerMessageId ?? null,
        errorMessage: extra.errorMessage ?? null,
      });

      if (status === EmailLogStatus.SENT) {
        await this.reputation.increment(recipient, 'sent', new Date());
      }
    } catch (error) {
      this.logger.warn('Email delivery log write failed', {
        recipient,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Whether the request carries anything to actually put in the message body. */
function hasBody(request: SendEmailRequest): boolean {
  return (request.html ?? '').trim() !== '' || (request.text ?? '').trim() !== '';
}

/**
 * Plain-text alternative for the multipart message. Links are kept inline as
 * "text [url]" so text clients keep the call to action.
 */
function toPlainText(html: string): string {
  try {
    return convert(html, { wordwrap: 100 });
  } catch {
    return '';
  }
}
