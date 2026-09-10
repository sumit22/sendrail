import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailFeedbackType } from '../../domain/email-feedback-type';
import { EmailFeedbackParseError } from '../../domain/errors';
import { FeedbackRequest } from '../parser';
import { SesFeedbackParser } from './ses-feedback-parser';
import { SnsSignatureVerifier } from './sns-signature-verifier';

const TOPIC_ARN = 'arn:aws:sns:ap-south-1:1234:ses-feedback';
const SUBSCRIBE_URL = 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=x';

/** A verifier that never positively verifies — as if signature checking is off. */
function unverified(): SnsSignatureVerifier {
  return { hasValidSignature: async () => false } as unknown as SnsSignatureVerifier;
}

function verified(): SnsSignatureVerifier {
  return { hasValidSignature: async () => true } as unknown as SnsSignatureVerifier;
}

function request(body: unknown, extra: Partial<FeedbackRequest> = {}): FeedbackRequest {
  return {
    rawBody: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {},
    query: {},
    ...extra,
  };
}

function snsNotification(sesEvent: unknown): FeedbackRequest {
  return request({
    Type: 'Notification',
    TopicArn: TOPIC_ARN,
    Message: JSON.stringify(sesEvent),
  });
}

describe('SesFeedbackParser.verify', () => {
  it('accepts a validly signed request', async () => {
    const parser = new SesFeedbackParser({ signatureVerifier: verified() });

    await expect(parser.verify(request({}))).resolves.toBe(true);
  });

  it('fails closed when the signature fails and no shared secret is configured', async () => {
    const parser = new SesFeedbackParser({ signatureVerifier: unverified() });

    await expect(parser.verify(request({}))).resolves.toBe(false);
  });

  it('never treats an empty configured secret as matching an empty token', async () => {
    const parser = new SesFeedbackParser({ signatureVerifier: unverified(), webhookSecret: '' });

    await expect(parser.verify(request({}, { query: { token: '' } }))).resolves.toBe(false);
  });

  it('accepts the shared secret as a query token', async () => {
    const parser = new SesFeedbackParser({
      signatureVerifier: unverified(),
      webhookSecret: 's3cret',
    });

    await expect(parser.verify(request({}, { query: { token: 's3cret' } }))).resolves.toBe(true);
    await expect(parser.verify(request({}, { query: { token: 'wrong' } }))).resolves.toBe(false);
  });

  it('accepts the shared secret as a header', async () => {
    const parser = new SesFeedbackParser({
      signatureVerifier: unverified(),
      webhookSecret: 's3cret',
    });

    await expect(
      parser.verify(request({}, { headers: { 'x-webhook-token': 's3cret' } }))
    ).resolves.toBe(true);
  });
});

describe('SesFeedbackParser.verify — topic allowlist', () => {
  const foreign = request({
    Type: 'Notification',
    TopicArn: 'arn:aws:sns:ap-south-1:9999:attacker-topic',
    Message: '{}',
  });

  it('rejects a validly signed notification from an unexpected topic', async () => {
    // A valid SNS signature proves AWS sent it, NOT that it came from our feed.
    // Anyone can publish an SES-shaped payload from their own topic and have AWS
    // sign it — without this check that suppresses any address they name.
    const parser = new SesFeedbackParser({
      signatureVerifier: verified(),
      allowedTopicArns: [TOPIC_ARN],
    });

    await expect(parser.verify(foreign)).resolves.toBe(false);
  });

  it('accepts a validly signed notification from the configured topic', async () => {
    const parser = new SesFeedbackParser({
      signatureVerifier: verified(),
      allowedTopicArns: [TOPIC_ARN],
    });

    await expect(
      parser.verify(request({ Type: 'Notification', TopicArn: TOPIC_ARN, Message: '{}' }))
    ).resolves.toBe(true);
  });

  it('enforces the topic on the shared-secret path too', async () => {
    const parser = new SesFeedbackParser({
      signatureVerifier: unverified(),
      webhookSecret: 's3cret',
      allowedTopicArns: [TOPIC_ARN],
    });

    await expect(parser.verify({ ...foreign, query: { token: 's3cret' } })).resolves.toBe(false);
  });

  it('does not enforce a topic when none is configured', async () => {
    // Unset keeps the previous behaviour rather than failing every environment
    // that has not set one yet.
    const parser = new SesFeedbackParser({ signatureVerifier: verified() });

    await expect(parser.verify(foreign)).resolves.toBe(true);
  });

  it('rejects an unparseable body when a topic is configured', async () => {
    const parser = new SesFeedbackParser({
      signatureVerifier: verified(),
      allowedTopicArns: [TOPIC_ARN],
    });

    await expect(parser.verify(request('not json'))).resolves.toBe(false);
  });

  describe('multi-region allowlist', () => {
    // SNS topics are regional, so sending from N SES regions means N topics all
    // publishing to this one endpoint. Every one of them must be trusted.
    const APSE1 = 'arn:aws:sns:ap-southeast-1:1234:example-email-feedback';
    const MEC1 = 'arn:aws:sns:me-central-1:1234:example-email-feedback';

    const multiRegion = () =>
      new SesFeedbackParser({
        signatureVerifier: verified(),
        allowedTopicArns: [TOPIC_ARN, APSE1, MEC1],
      });

    it.each([
      ['first', TOPIC_ARN],
      ['middle', APSE1],
      ['last', MEC1],
    ])('accepts a notification from the %s configured region', async (_position, arn) => {
      await expect(
        multiRegion().verify(request({ Type: 'Notification', TopicArn: arn, Message: '{}' }))
      ).resolves.toBe(true);
    });

    it('still rejects a topic outside the allowlist', async () => {
      await expect(multiRegion().verify(foreign)).resolves.toBe(false);
    });

    it('rejects an envelope with no TopicArn at all', async () => {
      // Guards the empty-string case: a blank allowlist entry would otherwise
      // match this, and a trailing comma in the env var produces exactly that.
      await expect(
        multiRegion().verify(request({ Type: 'Notification', Message: '{}' }))
      ).resolves.toBe(false);
    });

    it('treats an allowlist of only blank entries as unconfigured', async () => {
      const parser = new SesFeedbackParser({
        signatureVerifier: verified(),
        allowedTopicArns: ['', ''],
      });

      // Blanks are stripped, so this is the "no topic configured" path — it does
      // not become an allowlist that matches a missing TopicArn.
      await expect(parser.verify(foreign)).resolves.toBe(true);
    });

    it('auto-confirms a subscription from any configured region', async () => {
      const confirmSubscriptionUrl = vi.fn(async () => undefined);
      const parser = new SesFeedbackParser({
        signatureVerifier: verified(),
        allowedTopicArns: [TOPIC_ARN, APSE1, MEC1],
        confirmSubscriptionUrl,
      });

      const result = await parser.parse(
        request({
          Type: 'SubscriptionConfirmation',
          TopicArn: MEC1,
          SubscribeURL: SUBSCRIBE_URL,
        })
      );

      expect(result.status).toBe('subscription_confirmed');
      expect(confirmSubscriptionUrl).toHaveBeenCalledWith(SUBSCRIBE_URL);
    });
  });
});

describe('SesFeedbackParser.parse — bounces', () => {
  const parser = new SesFeedbackParser({ signatureVerifier: verified() });

  it('normalises a hard bounce into one event per recipient', async () => {
    const result = await parser.parse(
      snsNotification({
        eventType: 'Bounce',
        mail: { timestamp: '2026-08-01T10:00:00.000Z', messageId: 'ses-msg-1' },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [
            { emailAddress: 'gone@example.com', diagnosticCode: 'smtp; 550 5.1.1 unknown' },
            { emailAddress: 'also-gone@example.com' },
          ],
        },
      })
    );

    expect(result.status).toBe('bounce_recorded');
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      type: EmailFeedbackType.BOUNCED,
      recipientEmail: 'gone@example.com',
      reason: 'smtp; 550 5.1.1 unknown | Permanent/General',
      providerMessageId: 'ses-msg-1',
    });
    expect(result.events[0].occurredAt?.toISOString()).toBe('2026-08-01T10:00:00.000Z');
    expect(result.events[1].reason).toBe('Permanent/General');
  });

  it('ignores a soft bounce — SES retries those itself', async () => {
    const result = await parser.parse(
      snsNotification({
        eventType: 'Bounce',
        mail: {},
        bounce: {
          bounceType: 'Transient',
          bounceSubType: 'MailboxFull',
          bouncedRecipients: [{ emailAddress: 'full@example.com' }],
        },
      })
    );

    expect(result.status).toBe('soft_bounce_ignored');
    expect(result.events).toEqual([]);
  });

  it('reads the legacy notificationType discriminator too', async () => {
    // Identity-level feedback notifications say notificationType; configuration-set
    // event publishing says eventType. Reading only one silently drops every
    // bounce from the other wiring.
    const result = await parser.parse(
      snsNotification({
        notificationType: 'Bounce',
        mail: {},
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'NoEmail',
          bouncedRecipients: [{ emailAddress: 'gone@example.com' }],
        },
      })
    );

    expect(result.status).toBe('bounce_recorded');
    expect(result.events).toHaveLength(1);
  });

  it('throws on a malformed bounce payload', async () => {
    await expect(
      parser.parse(
        snsNotification({
          eventType: 'Bounce',
          mail: {},
          bounce: { bounceType: 'Permanent', bouncedRecipients: 'not-a-list' },
        })
      )
    ).rejects.toBeInstanceOf(EmailFeedbackParseError);
  });
});

describe('SesFeedbackParser.parse — complaints and deliveries', () => {
  const parser = new SesFeedbackParser({ signatureVerifier: verified() });

  it('normalises a complaint', async () => {
    const result = await parser.parse(
      snsNotification({
        eventType: 'Complaint',
        mail: { messageId: 'ses-msg-2' },
        complaint: {
          feedbackId: 'fb-1',
          complaintFeedbackType: 'abuse',
          complainedRecipients: [{ emailAddress: 'angry@example.com' }],
        },
      })
    );

    expect(result.status).toBe('complaint_recorded');
    expect(result.events[0]).toMatchObject({
      type: EmailFeedbackType.COMPLAINED,
      recipientEmail: 'angry@example.com',
      reason: 'feedbackId=fb-1; type=abuse',
    });
  });

  it('normalises a delivery, whose recipients are plain strings', async () => {
    const result = await parser.parse(
      snsNotification({
        eventType: 'Delivery',
        mail: { messageId: 'ses-msg-3' },
        delivery: { recipients: ['ok@example.com'] },
      })
    );

    expect(result.status).toBe('delivery_recorded');
    expect(result.events[0]).toMatchObject({
      type: EmailFeedbackType.DELIVERED,
      recipientEmail: 'ok@example.com',
    });
  });

  it('acknowledges informational event types without acting on them', async () => {
    const result = await parser.parse(
      snsNotification({ eventType: 'DeliveryDelay', mail: {}, deliveryDelay: {} })
    );

    expect(result).toEqual({ events: [], status: 'ignored' });
  });

  it('rejects an envelope that is not an SNS Notification', async () => {
    await expect(parser.parse(request({ Type: 'Nonsense' }))).rejects.toBeInstanceOf(
      EmailFeedbackParseError
    );
  });

  it('rejects an unparseable body', async () => {
    await expect(parser.parse(request('not json'))).rejects.toBeInstanceOf(EmailFeedbackParseError);
  });

  it('rejects a body that parses to a non-object', async () => {
    await expect(parser.parse(request('"a string"'))).rejects.toBeInstanceOf(
      EmailFeedbackParseError
    );
  });

  it('rejects an envelope whose Message is not a string', async () => {
    await expect(
      parser.parse(request({ Type: 'Notification', Message: { not: 'a string' } }))
    ).rejects.toThrow('SNS envelope has no Message field');
  });

  it('rejects a Message that is not valid SES JSON', async () => {
    await expect(
      parser.parse(request({ Type: 'Notification', Message: 'not json' }))
    ).rejects.toThrow('SNS Message is not valid SES JSON');
  });

  it('rejects a Message that parses to a non-object', async () => {
    await expect(parser.parse(request({ Type: 'Notification', Message: '[]' }))).rejects.toThrow(
      'SNS Message is not valid SES JSON'
    );
  });

  it('throws on malformed delivery recipients', async () => {
    await expect(
      parser.parse(
        snsNotification({ eventType: 'Delivery', mail: {}, delivery: { recipients: 'nope' } })
      )
    ).rejects.toBeInstanceOf(EmailFeedbackParseError);
  });

  it('throws on a malformed complaint payload', async () => {
    await expect(
      parser.parse(snsNotification({ eventType: 'Complaint', mail: {}, complaint: 'nope' }))
    ).rejects.toBeInstanceOf(EmailFeedbackParseError);
  });

  it('throws on malformed complained recipients', async () => {
    await expect(
      parser.parse(
        snsNotification({
          eventType: 'Complaint',
          mail: {},
          complaint: { complainedRecipients: 'nope' },
        })
      )
    ).rejects.toBeInstanceOf(EmailFeedbackParseError);
  });

  it('skips blank and non-string recipient entries rather than emitting empty events', async () => {
    const result = await parser.parse(
      snsNotification({
        eventType: 'Delivery',
        mail: {},
        delivery: { recipients: ['ok@example.com', '', null, 42] },
      })
    );

    expect(result.events).toHaveLength(1);
  });

  it('skips malformed bounced-recipient entries', async () => {
    const result = await parser.parse(
      snsNotification({
        eventType: 'Bounce',
        mail: {},
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [{ emailAddress: 'ok@example.com' }, { emailAddress: '' }, 'nope'],
        },
      })
    );

    expect(result.events).toHaveLength(1);
  });

  it('skips a complained-recipient entry with no address', async () => {
    const result = await parser.parse(
      snsNotification({
        eventType: 'Complaint',
        mail: {},
        complaint: { complainedRecipients: [{ emailAddress: 'a@example.com' }, {}] },
      })
    );

    expect(result.events).toHaveLength(1);
  });

  it('tolerates a mail block with no timestamp or message id', async () => {
    const result = await parser.parse(
      snsNotification({ eventType: 'Delivery', delivery: { recipients: ['a@example.com'] } })
    );

    expect(result.events[0]).toMatchObject({ occurredAt: null, providerMessageId: null });
  });

  it('ignores an unparseable timestamp rather than failing the whole event', async () => {
    const result = await parser.parse(
      snsNotification({
        eventType: 'Delivery',
        mail: { timestamp: 'not-a-date' },
        delivery: { recipients: ['a@example.com'] },
      })
    );

    expect(result.events[0].occurredAt).toBeNull();
  });
});

describe('SesFeedbackParser — header handling', () => {
  it('reads a repeated shared-secret header, which arrives as an array', async () => {
    const parser = new SesFeedbackParser({
      signatureVerifier: unverified(),
      webhookSecret: 's3cret',
    });

    await expect(
      parser.verify(request({}, { headers: { 'x-webhook-token': ['s3cret', 'other'] } }))
    ).resolves.toBe(true);
  });
});

describe('SesFeedbackParser — default subscription confirmation', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const confirmation = request({
    Type: 'SubscriptionConfirmation',
    TopicArn: TOPIC_ARN,
    SubscribeURL: SUBSCRIBE_URL,
  });

  it('GETs the SubscribeURL when no confirmer is injected', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const parser = new SesFeedbackParser({
      signatureVerifier: verified(),
      allowedTopicArns: [TOPIC_ARN],
    });

    await expect(parser.parse(confirmation)).resolves.toMatchObject({
      status: 'subscription_confirmed',
    });
    expect(fetchMock).toHaveBeenCalledWith(SUBSCRIBE_URL);
  });

  it('reports a non-200 from the SubscribeURL as a failed confirmation', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 403 })
    ) as unknown as typeof fetch;

    const parser = new SesFeedbackParser({
      signatureVerifier: verified(),
      allowedTopicArns: [TOPIC_ARN],
    });

    await expect(parser.parse(confirmation)).resolves.toMatchObject({
      status: 'subscription_confirm_failed',
    });
  });
});

describe('SesFeedbackParser.parse — subscription handshake', () => {
  const confirmation = request({
    Type: 'SubscriptionConfirmation',
    TopicArn: TOPIC_ARN,
    SubscribeURL: SUBSCRIBE_URL,
  });

  it('leaves the subscription pending when no topic is allowlisted', async () => {
    const confirmSubscriptionUrl = vi.fn(async () => undefined);
    const parser = new SesFeedbackParser({
      signatureVerifier: verified(),
      confirmSubscriptionUrl,
    });

    const result = await parser.parse(confirmation);

    expect(result.status).toBe('subscription_pending_manual_confirm');
    expect(confirmSubscriptionUrl).not.toHaveBeenCalled();
  });

  it('auto-confirms only the allowlisted topic', async () => {
    const confirmSubscriptionUrl = vi.fn(async () => undefined);
    const parser = new SesFeedbackParser({
      signatureVerifier: verified(),
      allowedTopicArns: [TOPIC_ARN],
      confirmSubscriptionUrl,
    });

    const result = await parser.parse(confirmation);

    expect(result.status).toBe('subscription_confirmed');
    expect(confirmSubscriptionUrl).toHaveBeenCalledWith(SUBSCRIBE_URL);
  });

  it('refuses a validly signed confirmation from someone else’s topic', async () => {
    const confirmSubscriptionUrl = vi.fn(async () => undefined);
    const parser = new SesFeedbackParser({
      signatureVerifier: verified(),
      allowedTopicArns: ['arn:aws:sns:ap-south-1:1234:ours'],
      confirmSubscriptionUrl,
    });

    const result = await parser.parse(confirmation);

    expect(result.status).toBe('subscription_pending_manual_confirm');
    expect(confirmSubscriptionUrl).not.toHaveBeenCalled();
  });

  it('refuses a SubscribeURL that is not an SNS host', async () => {
    const confirmSubscriptionUrl = vi.fn(async () => undefined);
    const parser = new SesFeedbackParser({
      signatureVerifier: verified(),
      allowedTopicArns: [TOPIC_ARN],
      confirmSubscriptionUrl,
    });

    const result = await parser.parse(
      request({
        Type: 'SubscriptionConfirmation',
        TopicArn: TOPIC_ARN,
        SubscribeURL: 'https://evil.example.com/steal',
      })
    );

    expect(result.status).toBe('subscription_pending_manual_confirm');
    expect(confirmSubscriptionUrl).not.toHaveBeenCalled();
  });

  it('reports a failed confirmation instead of throwing', async () => {
    const parser = new SesFeedbackParser({
      signatureVerifier: verified(),
      allowedTopicArns: [TOPIC_ARN],
      confirmSubscriptionUrl: async () => {
        throw new Error('network down');
      },
    });

    await expect(parser.parse(confirmation)).resolves.toMatchObject({
      status: 'subscription_confirm_failed',
    });
  });
});
