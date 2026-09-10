import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailDeliveryStatus } from '../domain/email-delivery-status';
import { EmailLogStatus } from '../domain/email-log-status';
import { EmailTransportError } from '../domain/errors';
import {
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
} from '../memory/in-memory-stores';
import { EmailTransport, OutboundEmail, SendResult } from '../ports/transport';
import { EmailAddressValidator } from '../validation/email-address-validator';
import { EmailSender } from './email-sender';

class RecordingTransport implements EmailTransport {
  readonly name = 'recording';
  readonly sent: OutboundEmail[] = [];

  constructor(private readonly result: SendResult = { providerMessageId: 'ses-msg-1' }) {}

  async send(message: OutboundEmail): Promise<SendResult> {
    this.sent.push(message);
    return this.result;
  }
}

describe('EmailSender', () => {
  let deliveryLog: InMemoryDeliveryLogStore;
  let reputation: InMemoryReputationStore;
  let suppression: InMemorySuppressionStore;
  let transport: RecordingTransport;

  const build = (overrides: { transport?: EmailTransport } = {}) =>
    new EmailSender({
      transport: overrides.transport ?? transport,
      validator: new EmailAddressValidator({ mxCheckEnabled: false }),
      suppression,
      deliveryLog,
      reputation,
      defaultFrom: { email: 'noreply@example.com', name: 'Example' },
    });

  const request = {
    to: 'guest@example.com',
    subject: 'Your order is confirmed',
    html: '<p>See you <a href="https://example.com/b/1">Saturday</a>.</p>',
    template: 'order-confirmed',
  };

  beforeEach(() => {
    deliveryLog = new InMemoryDeliveryLogStore();
    reputation = new InMemoryReputationStore();
    suppression = new InMemorySuppressionStore();
    transport = new RecordingTransport();
  });

  it('sends, logs the row and counts the send', async () => {
    const outcome = await build().send(request);

    expect(outcome).toEqual({ status: EmailLogStatus.SENT, providerMessageId: 'ses-msg-1' });
    expect(transport.sent[0]).toMatchObject({
      to: 'guest@example.com',
      from: { email: 'noreply@example.com', name: 'Example' },
      subject: 'Your order is confirmed',
    });

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0]).toMatchObject({
      recipientEmail: 'guest@example.com',
      notificationClass: 'order-confirmed',
      template: 'order-confirmed',
      status: EmailLogStatus.SENT,
      providerMessageId: 'ses-msg-1',
    });

    const rows = await reputation.findPaginated({ page: 1, pageSize: 10 });
    expect(rows.items[0]).toMatchObject({ email: 'guest@example.com', sentCount: 1 });
  });

  it('derives a plain-text part from the HTML actually sent', async () => {
    await build().send(request);

    // Derived rather than maintained separately, so the two parts cannot drift.
    expect(transport.sent[0].text).toContain('Saturday');
    expect(transport.sent[0].text).toContain('https://example.com/b/1');
  });

  it('keeps a caller-supplied text part', async () => {
    await build().send({ ...request, text: 'See you Saturday.' });

    expect(transport.sent[0].text).toBe('See you Saturday.');
  });

  it('refuses to send to a suppressed address', async () => {
    await suppression.record(
      'guest@example.com',
      EmailDeliveryStatus.BOUNCED,
      'Permanent/General',
      new Date()
    );

    const outcome = await build().send(request);

    expect(outcome).toEqual({
      status: EmailLogStatus.SUPPRESSED,
      skippedReason: 'suppressed',
    });
    expect(transport.sent).toHaveLength(0);
  });

  it('records the refusal rather than dropping it silently', async () => {
    await suppression.record(
      'guest@example.com',
      EmailDeliveryStatus.COMPLAINED,
      'abuse',
      new Date()
    );

    await build().send(request);

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0]).toMatchObject({
      status: EmailLogStatus.SUPPRESSED,
      errorMessage: 'suppressed',
    });
  });

  it('refuses a malformed address before the transport is touched', async () => {
    const outcome = await build().send({ ...request, to: 'not-an-email' });

    expect(outcome.status).toBe(EmailLogStatus.SUPPRESSED);
    expect(outcome.skippedReason).toBe('invalid_syntax');
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses a disposable domain', async () => {
    const outcome = await build().send({ ...request, to: 'throwaway@mailinator.com' });

    expect(outcome.skippedReason).toBe('disposable_domain');
  });

  it('records a transport failure and returns it rather than throwing', async () => {
    const failing: EmailTransport = {
      name: 'failing',
      send: async () => {
        throw new EmailTransportError('SES rejected the message: Throttling');
      },
    };

    const outcome = await build({ transport: failing }).send(request);

    expect(outcome.status).toBe(EmailLogStatus.FAILED);
    expect(outcome.error?.message).toContain('Throttling');

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0]).toMatchObject({
      status: EmailLogStatus.FAILED,
      errorMessage: 'SES rejected the message: Throttling',
    });
  });

  it('does not turn a bookkeeping failure into a send failure', async () => {
    vi.spyOn(deliveryLog, 'append').mockRejectedValue(new Error('log store down'));

    await expect(build().send(request)).resolves.toMatchObject({ status: EmailLogStatus.SENT });
  });

  it('refuses a blank recipient without touching the stores', async () => {
    const outcome = await build().send({ ...request, to: '   ' });

    expect(outcome).toEqual({
      status: EmailLogStatus.SUPPRESSED,
      skippedReason: 'invalid_syntax',
    });
    // Nothing to attribute the row to, so no log entry either.
    await expect(deliveryLog.findPaginated({ page: 1, pageSize: 10 })).resolves.toMatchObject({
      total: 0,
    });
    expect(transport.sent).toHaveLength(0);
  });

  it('falls back to a generic class when neither is supplied', async () => {
    await build().send({ to: 'guest@example.com', subject: 'Hi', html: '<p>Hi</p>' });

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0]).toMatchObject({ notificationClass: 'email', template: null });
  });

  it('prefers an explicit notification class over the template name', async () => {
    await build().send({ ...request, notificationClass: 'order.confirmed' });

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0].notificationClass).toBe('order.confirmed');
  });

  it('sends an empty text part when the HTML yields no text', async () => {
    // Never a reason to fail a send: the HTML part is the one that matters.
    const outcome = await build().send({ ...request, html: '<div></div>' });

    expect(outcome.status).toBe(EmailLogStatus.SENT);
    expect(transport.sent[0].text).toBe('');
  });

  it('wraps a non-Error transport rejection', async () => {
    const failing: EmailTransport = {
      name: 'failing',
      send: async () => {
        throw 'connection reset';
      },
    };

    const outcome = await build({ transport: failing }).send(request);

    expect(outcome.status).toBe(EmailLogStatus.FAILED);
    expect(outcome.error?.message).toBe('connection reset');
  });

  it('passes an explicit sender identity through', async () => {
    await build().send({ ...request, from: { email: 'billing@example.com', name: 'Billing' } });

    expect(transport.sent[0].from).toEqual({ email: 'billing@example.com', name: 'Billing' });
  });

  it('does not count a suppressed send against the sent counter', async () => {
    await suppression.record('guest@example.com', EmailDeliveryStatus.BOUNCED, 'x', new Date());

    await build().send(request);

    const rows = await reputation.findPaginated({ page: 1, pageSize: 10 });
    expect(rows.total).toBe(0);
  });

  /**
   * Cold outreach sends as a personal note, and a personal note has no HTML
   * part — an HTML alternative is exactly the tell that marks a message as
   * bulk. The sender must therefore be able to compose text-only.
   */
  describe('text-only messages', () => {
    it('sends the text verbatim and attaches no html part', async () => {
      const outcome = await build().send({
        to: 'owner@example.com',
        subject: 'Quick question about Luxe Beauty',
        text: 'Hi there,\n\nSaw your site and had a thought.\n\n— Alex',
        notificationClass: 'outreach',
      });

      expect(outcome.status).toBe(EmailLogStatus.SENT);
      expect(transport.sent[0].text).toBe(
        'Hi there,\n\nSaw your site and had a thought.\n\n— Alex'
      );
      expect(transport.sent[0].html).toBeUndefined();
    });

    it('still derives text from html when only html is given', async () => {
      await build().send(request);

      expect(transport.sent[0].text).toContain('Saturday');
    });

    it('refuses a request with neither body rather than mailing an empty message', async () => {
      const outcome = await build().send({
        to: 'owner@example.com',
        subject: 'Oops',
        notificationClass: 'outreach',
      });

      expect(outcome.status).toBe(EmailLogStatus.FAILED);
      expect(outcome.error?.message).toMatch(/body/i);
      expect(transport.sent).toHaveLength(0);

      const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
      expect(items[0]).toMatchObject({ status: EmailLogStatus.FAILED });
    });
  });
});
