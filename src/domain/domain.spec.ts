import { describe, expect, it } from 'vitest';
import { EmailDeliveryStatus, suppressesDelivery } from './email-delivery-status';
import { acknowledged, feedbackResult } from './email-feedback-event';
import { EmailFeedbackType, suppressesRecipient, toLogStatus } from './email-feedback-type';
import { EmailLogStatus, isTerminalFailure } from './email-log-status';
import { EmailFeedbackParseError, EmailTransportError, ExternalServiceError } from './errors';

describe('suppressesRecipient', () => {
  it('suppresses on a bounce and a complaint, never on a delivery', () => {
    // The single place this decision lives — a new provider adapter cannot
    // accidentally disagree about what suppresses.
    expect(suppressesRecipient(EmailFeedbackType.BOUNCED)).toBe(true);
    expect(suppressesRecipient(EmailFeedbackType.COMPLAINED)).toBe(true);
    expect(suppressesRecipient(EmailFeedbackType.DELIVERED)).toBe(false);
  });
});

describe('toLogStatus', () => {
  it.each([
    [EmailFeedbackType.DELIVERED, EmailLogStatus.DELIVERED],
    [EmailFeedbackType.BOUNCED, EmailLogStatus.BOUNCED],
    [EmailFeedbackType.COMPLAINED, EmailLogStatus.COMPLAINED],
  ])('maps %s to %s', (feedback, log) => {
    expect(toLogStatus(feedback)).toBe(log);
  });
});

describe('suppressesDelivery', () => {
  it('treats anything other than ACTIVE as suppressed', () => {
    expect(suppressesDelivery(EmailDeliveryStatus.ACTIVE)).toBe(false);
    expect(suppressesDelivery(EmailDeliveryStatus.BOUNCED)).toBe(true);
    expect(suppressesDelivery(EmailDeliveryStatus.COMPLAINED)).toBe(true);
  });
});

describe('isTerminalFailure', () => {
  it.each([EmailLogStatus.BOUNCED, EmailLogStatus.COMPLAINED, EmailLogStatus.FAILED])(
    '%s is terminal',
    (status) => {
      expect(isTerminalFailure(status)).toBe(true);
    }
  );

  it.each([EmailLogStatus.SENT, EmailLogStatus.DELIVERED, EmailLogStatus.SUPPRESSED])(
    '%s is not terminal',
    (status) => {
      expect(isTerminalFailure(status)).toBe(false);
    }
  );
});

describe('feedback results', () => {
  it('defaults the status of a result carrying events', () => {
    const event = { type: EmailFeedbackType.BOUNCED, recipientEmail: 'a@example.com' };

    expect(feedbackResult([event])).toEqual({ events: [event], status: 'processed' });
  });

  it('distinguishes an acknowledged request from a parse failure', () => {
    // A handshake or an ignored soft bounce is a successful, uninteresting
    // request — not an error.
    expect(acknowledged('soft_bounce_ignored')).toEqual({
      events: [],
      status: 'soft_bounce_ignored',
    });
  });
});

describe('errors', () => {
  it('names each error so it survives serialisation into a log', () => {
    expect(new EmailFeedbackParseError('bad').name).toBe('EmailFeedbackParseError');
    expect(new EmailTransportError('bad').name).toBe('EmailTransportError');
    expect(new ExternalServiceError('aws_ses', 'down').name).toBe('ExternalServiceError');
  });

  it('keeps the originating failure and service attached for diagnosis', () => {
    const cause = new Error('ECONNREFUSED');

    expect(new EmailTransportError('bad', cause).cause).toBe(cause);
    expect(new ExternalServiceError('aws_ses', 'down', cause)).toMatchObject({
      service: 'aws_ses',
      cause,
    });
  });
});
