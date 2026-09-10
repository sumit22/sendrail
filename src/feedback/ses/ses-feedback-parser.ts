import { timingSafeEqual } from 'node:crypto';
import {
  EmailFeedbackEvent,
  EmailFeedbackResult,
  acknowledged,
  feedbackResult,
} from '../../domain/email-feedback-event';
import { EmailFeedbackType } from '../../domain/email-feedback-type';
import { EmailFeedbackParseError } from '../../domain/errors';
import { EmailLogger, NULL_LOGGER } from '../../ports/logger';
import { EmailFeedbackParser, FeedbackRequest } from '../parser';
import { SnsSignatureVerifier, isSnsSigningUrl } from './sns-signature-verifier';

export interface SesFeedbackParserOptions {
  signatureVerifier: SnsSignatureVerifier;
  /**
   * Interim shared secret, supplied as `?token=` because SNS HTTPS
   * subscriptions cannot set custom headers. Empty/unset disables this fallback
   * entirely (it never treats '' === '' as a match), leaving the SNS signature
   * as the only way in.
   */
  webhookSecret?: string;
  /**
   * Topic ARNs permitted to auto-confirm their own subscription. Empty disables
   * auto-confirm and restores the manual flow — the safe default for any
   * environment that has not opted in.
   *
   * A list rather than a single value because SNS is regional: sending from N
   * SES regions means N topics, each publishing the same event shape to this
   * one endpoint. A single-valued allowlist would silently reject every region
   * but one — and the symptom is the worst kind, an empty suppression list that
   * looks healthy while bounces go unrecorded.
   */
  allowedTopicArns?: readonly string[];
  logger?: EmailLogger;
  /** Override the SubscribeURL fetch (tests, or a host with its own client). */
  confirmSubscriptionUrl?: (url: string) => Promise<void>;
}

/**
 * AWS SES delivery feedback, delivered over an SNS HTTPS subscription.
 *
 * SES → SNS topic → `POST /webhooks/notifications/ses`. The SES payload is
 * itself a JSON string nested inside the SNS envelope's `Message` field.
 *
 * Everything AWS-shaped is confined to this class. It is the first
 * implementation of {@link EmailFeedbackParser}, not a privileged one: a
 * SendGrid adapter sits beside it with no changes anywhere else.
 *
 * ## Authenticity
 *
 * Primary check is the SNS RSA signature over the canonical string. A shared
 * secret remains as a fallback for environments where signature checking is
 * off. Both fail → unauthenticated, fail-closed.
 *
 * ## Subscription handshake
 *
 * `SubscriptionConfirmation` is auto-confirmed only for the allowlisted topic
 * ARN. Signature verification has already run by then, so authenticity is not
 * the question; the allowlist answers *which* topic, so a validly-signed
 * confirmation from a stranger's topic cannot subscribe us to a feed they
 * control. Unconfigured → manual flow.
 *
 * ## What is deliberately dropped
 *
 * - Soft bounces (`bounceType !== 'Permanent'`) — SES retries these itself;
 *   suppressing on them would cut off recipients whose mailbox was briefly
 *   full.
 * - `DeliveryDelay` and anything else informational.
 */
export class SesFeedbackParser implements EmailFeedbackParser {
  readonly providerCode = 'ses';

  private readonly signatureVerifier: SnsSignatureVerifier;
  private readonly webhookSecret: string;
  private readonly allowedTopicArns: readonly string[];
  private readonly logger: EmailLogger;
  private readonly confirmSubscriptionUrl: (url: string) => Promise<void>;

  constructor(options: SesFeedbackParserOptions) {
    this.signatureVerifier = options.signatureVerifier;
    this.webhookSecret = options.webhookSecret ?? '';
    // Blank entries would each match an envelope with no TopicArn, turning a
    // trailing comma in the env var into an open allowlist.
    this.allowedTopicArns = (options.allowedTopicArns ?? []).filter((arn) => arn !== '');
    this.logger = options.logger ?? NULL_LOGGER;
    this.confirmSubscriptionUrl = options.confirmSubscriptionUrl ?? defaultConfirm;
  }

  async verify(request: FeedbackRequest): Promise<boolean> {
    if (!(await this.isAuthentic(request))) {
      return false;
    }

    // A valid SNS signature proves AWS sent this — NOT that it came from our
    // feed. Anyone can create their own SNS topic, publish a payload shaped like
    // an SES bounce, and point it here; AWS signs it for them. Without this
    // check that is a denial-of-delivery primitive: a stranger could suppress
    // any address they like. Enforced whenever a topic is configured; unset
    // keeps the previous behaviour rather than failing every environment that
    // has not set one yet.
    return this.isAllowedTopic(request.rawBody);
  }

  private async isAuthentic(request: FeedbackRequest): Promise<boolean> {
    if (await this.signatureVerifier.hasValidSignature(request.rawBody)) {
      return true;
    }

    if (this.webhookSecret === '') {
      return false;
    }

    const supplied =
      firstValue(request.headers['x-webhook-token']) ?? firstValue(request.query.token) ?? '';
    if (supplied === '') {
      return false;
    }

    return constantTimeEquals(this.webhookSecret, supplied);
  }

  /** True when no topic is configured, or the envelope names one of them. */
  private isAllowedTopic(rawBody: string): boolean {
    if (this.allowedTopicArns.length === 0) {
      return true;
    }

    let topicArn = '';
    try {
      const envelope: unknown = JSON.parse(rawBody);
      if (isRecord(envelope) && typeof envelope.TopicArn === 'string') {
        topicArn = envelope.TopicArn;
      }
    } catch {
      // Unparseable here means parse() will reject it as malformed anyway.
      return false;
    }

    if (!this.isTrustedTopicArn(topicArn)) {
      this.logger.warn('Email feedback rejected — envelope is from an unexpected SNS topic', {
        topicArn,
      });
      return false;
    }

    return true;
  }

  /**
   * Constant-time membership test. Every entry is compared even after a match,
   * so the time taken does not reveal which region's topic matched, nor how
   * many are configured.
   */
  private isTrustedTopicArn(topicArn: string): boolean {
    let matched = false;
    for (const allowed of this.allowedTopicArns) {
      if (constantTimeEquals(allowed, topicArn)) {
        matched = true;
      }
    }

    return matched;
  }

  async parse(request: FeedbackRequest): Promise<EmailFeedbackResult> {
    let envelope: unknown;
    try {
      envelope = JSON.parse(request.rawBody);
    } catch {
      throw new EmailFeedbackParseError('Invalid SNS envelope.');
    }
    if (!isRecord(envelope)) {
      throw new EmailFeedbackParseError('Invalid SNS envelope.');
    }

    const type = envelope.Type;

    if (type === 'SubscriptionConfirmation') {
      return this.confirmSubscription(envelope);
    }

    if (type !== 'Notification') {
      throw new EmailFeedbackParseError(
        `Unsupported SNS envelope type "${typeof type === 'string' ? type : 'null'}".`
      );
    }

    const messageJson = envelope.Message;
    if (typeof messageJson !== 'string') {
      throw new EmailFeedbackParseError('SNS envelope has no Message field.');
    }

    let sesEvent: unknown;
    try {
      sesEvent = JSON.parse(messageJson);
    } catch {
      throw new EmailFeedbackParseError('SNS Message is not valid SES JSON.');
    }
    if (!isRecord(sesEvent)) {
      throw new EmailFeedbackParseError('SNS Message is not valid SES JSON.');
    }

    const mail = isRecord(sesEvent.mail) ? sesEvent.mail : {};
    const at = parseTimestamp(mail.timestamp);
    const messageId =
      typeof mail.messageId === 'string' && mail.messageId !== '' ? mail.messageId : null;

    // SES emits TWO payload shapes with the same body but a different
    // discriminator key, and which one you get depends on how the feed was
    // wired:
    //
    //   - identity-level "Feedback notifications" → `notificationType`
    //   - configuration-set event publishing      → `eventType`
    //
    // Publishing via a configuration set is what makes SMTP sends emit events
    // at all, so production sends `eventType`. Reading only `notificationType`
    // means every real bounce falls through to the `ignored` branch and is
    // silently dropped — the endpoint answers 200 and does nothing.
    //
    // Accept both: the values (`Bounce`/`Complaint`/`Delivery`) are identical,
    // and supporting either keeps us working if the wiring changes.
    const eventType = sesEvent.eventType ?? sesEvent.notificationType ?? null;

    switch (eventType) {
      case 'Bounce':
        return parseBounce(sesEvent, at, messageId);
      case 'Complaint':
        return parseComplaint(sesEvent, at, messageId);
      case 'Delivery':
        return parseDelivery(sesEvent, at, messageId);
      default:
        return acknowledged('ignored');
    }
  }

  /**
   * Complete the SNS subscription handshake.
   *
   * Auto-confirms ONLY when the envelope's `TopicArn` matches the configured
   * allowlist. Three independent conditions must hold before we fetch a
   * SubscribeURL:
   *
   *   1. the SNS signature already verified (the caller runs `verify()` before
   *      `parse()`, so authenticity is established by AWS's own crypto — this
   *      is what makes auto-confirming safe at all);
   *   2. the topic is one we expect — otherwise a validly-signed confirmation
   *      from someone else's topic could subscribe us to a feed they control;
   *   3. the URL is an `sns.<region>.amazonaws.com` host — defence in depth so
   *      a malformed envelope can never turn this into an SSRF primitive.
   *
   * Anything unmet falls back to logging it and leaving the subscription
   * pending for an operator.
   */
  private async confirmSubscription(
    envelope: Record<string, unknown>
  ): Promise<EmailFeedbackResult> {
    const topicArn = typeof envelope.TopicArn === 'string' ? envelope.TopicArn : '';
    const subscribeUrl = typeof envelope.SubscribeURL === 'string' ? envelope.SubscribeURL : '';

    if (!this.mayAutoConfirm(topicArn, subscribeUrl)) {
      this.logger.warn(
        'SES SNS SubscriptionConfirmation received — an operator must GET the SubscribeURL',
        {
          topicArn,
          subscribeUrl,
          reason:
            this.allowedTopicArns.length === 0
              ? 'no allowlisted topic configured'
              : 'topic or SubscribeURL not allowlisted',
        }
      );

      return acknowledged('subscription_pending_manual_confirm');
    }

    try {
      await this.confirmSubscriptionUrl(subscribeUrl);
    } catch (error) {
      this.logger.error('SES SNS subscription auto-confirm failed', {
        topicArn,
        error: error instanceof Error ? error.message : String(error),
      });

      return acknowledged('subscription_confirm_failed');
    }

    this.logger.log('SES SNS subscription confirmed', { topicArn });

    return acknowledged('subscription_confirmed');
  }

  /**
   * All preconditions for auto-confirming, evaluated together so the decision
   * is in one place.
   */
  private mayAutoConfirm(topicArn: string, subscribeUrl: string): boolean {
    // Duplicates the topic check `verify()` now performs. Kept so `parse()` is
    // safe on its own terms: fetching a SubscribeURL is the one side effect in
    // here, and it must not depend on a caller having run verify() first.
    if (this.allowedTopicArns.length === 0) {
      return false;
    }
    if (!this.isTrustedTopicArn(topicArn)) {
      return false;
    }

    return isSnsSigningUrl(subscribeUrl);
  }
}

function parseBounce(
  sesEvent: Record<string, unknown>,
  at: Date | null,
  messageId: string | null
): EmailFeedbackResult {
  const bounce = sesEvent.bounce;
  if (!isRecord(bounce)) {
    throw new EmailFeedbackParseError('Malformed SES bounce payload.');
  }

  // Only HARD bounces suppress. Soft bounces are transient (mailbox full,
  // throttled) and SES retries them; suppressing would over-block.
  if (bounce.bounceType !== 'Permanent') {
    return acknowledged('soft_bounce_ignored');
  }

  const reason = `${String(bounce.bounceType)}/${
    typeof bounce.bounceSubType === 'string' ? bounce.bounceSubType : 'unknown'
  }`;

  const recipients = bounce.bouncedRecipients;
  if (!Array.isArray(recipients)) {
    throw new EmailFeedbackParseError('Malformed SES bouncedRecipients.');
  }

  const events: EmailFeedbackEvent[] = [];
  for (const recipient of recipients) {
    const email = isRecord(recipient) ? recipient.emailAddress : null;
    if (typeof email !== 'string' || email === '') {
      continue;
    }

    const diagnostic =
      isRecord(recipient) && typeof recipient.diagnosticCode === 'string'
        ? `${recipient.diagnosticCode} | ${reason}`
        : reason;

    events.push({
      type: EmailFeedbackType.BOUNCED,
      recipientEmail: email,
      reason: diagnostic,
      occurredAt: at,
      providerMessageId: messageId,
    });
  }

  return feedbackResult(events, 'bounce_recorded');
}

function parseComplaint(
  sesEvent: Record<string, unknown>,
  at: Date | null,
  messageId: string | null
): EmailFeedbackResult {
  const complaint = sesEvent.complaint;
  if (!isRecord(complaint)) {
    throw new EmailFeedbackParseError('Malformed SES complaint payload.');
  }

  const reason = `feedbackId=${
    typeof complaint.feedbackId === 'string' ? complaint.feedbackId : 'unknown'
  }; type=${
    typeof complaint.complaintFeedbackType === 'string'
      ? complaint.complaintFeedbackType
      : 'unknown'
  }`;

  const recipients = complaint.complainedRecipients;
  if (!Array.isArray(recipients)) {
    throw new EmailFeedbackParseError('Malformed SES complainedRecipients.');
  }

  const events: EmailFeedbackEvent[] = [];
  for (const recipient of recipients) {
    const email = isRecord(recipient) ? recipient.emailAddress : null;
    if (typeof email === 'string' && email !== '') {
      events.push({
        type: EmailFeedbackType.COMPLAINED,
        recipientEmail: email,
        reason,
        occurredAt: at,
        providerMessageId: messageId,
      });
    }
  }

  return feedbackResult(events, 'complaint_recorded');
}

/**
 * `delivery.recipients` is a list of plain address strings, unlike the
 * bounce/complaint shapes which nest them in objects.
 */
function parseDelivery(
  sesEvent: Record<string, unknown>,
  at: Date | null,
  messageId: string | null
): EmailFeedbackResult {
  const delivery = sesEvent.delivery;
  const recipients = isRecord(delivery) ? delivery.recipients : [];
  if (!Array.isArray(recipients)) {
    throw new EmailFeedbackParseError('Malformed SES delivery.recipients.');
  }

  const events: EmailFeedbackEvent[] = [];
  for (const email of recipients) {
    if (typeof email === 'string' && email !== '') {
      events.push({
        type: EmailFeedbackType.DELIVERED,
        recipientEmail: email,
        reason: null,
        occurredAt: at,
        providerMessageId: messageId,
      });
    }
  }

  return feedbackResult(events, 'delivery_recorded');
}

async function defaultConfirm(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`SubscribeURL returned HTTP ${response.status}`);
  }
}

function parseTimestamp(iso: unknown): Date | null {
  if (typeof iso !== 'string' || iso === '') {
    return null;
  }
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

/**
 * Length-independent comparison. `timingSafeEqual` throws on unequal lengths,
 * which would itself leak the secret's length, so unequal lengths short-circuit
 * to false before it is called.
 */
function constantTimeEquals(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
