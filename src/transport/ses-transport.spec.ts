import { SendEmailCommand, SendEmailCommandOutput } from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';
import { EmailTransportError } from '../domain/errors';
import { OutboundEmail } from '../ports/transport';
import { SesEmailTransport, SesV2Like } from './ses-transport';

const message: OutboundEmail = {
  to: 'guest@example.com',
  from: { email: 'noreply@example.com', name: 'Example' },
  subject: 'Your order is confirmed',
  html: '<p>See you Saturday.</p>',
  text: 'See you Saturday.',
};

function client(result: Partial<SendEmailCommandOutput> = { MessageId: 'ses-msg-1' }) {
  const send = vi.fn().mockResolvedValue(result);

  return { client: { send } as unknown as SesV2Like, send };
}

function inputOf(send: ReturnType<typeof client>['send']) {
  return (send.mock.calls[0][0] as SendEmailCommand).input;
}

describe('SesEmailTransport', () => {
  it('returns the SES message id, which is what feedback correlates on', async () => {
    // The whole reason for using the API over SMTP: this id is the same one that
    // arrives on the SES→SNS feedback event as mail.messageId.
    const { client: c } = client();

    await expect(new SesEmailTransport({ client: c }).send(message)).resolves.toEqual({
      providerMessageId: 'ses-msg-1',
    });
  });

  it('sends raw MIME rather than SES simple content', async () => {
    const { client: c, send } = client();

    await new SesEmailTransport({ client: c }).send(message);

    const raw = inputOf(send).Content?.Raw?.Data;
    expect(raw).toBeInstanceOf(Buffer);
    expect(Buffer.from(raw as Uint8Array).toString('utf8')).toContain(
      'From: Example <noreply@example.com>'
    );
  });

  it('sends under the configuration set', async () => {
    // Event publishing to SNS is configured ON the configuration set, so a send
    // that omits it produces no delivery feedback at all.
    const { client: c, send } = client();

    await new SesEmailTransport({
      client: c,
      configurationSetName: 'example-delivery',
    }).send(message);

    expect(inputOf(send).ConfigurationSetName).toBe('example-delivery');
  });

  it('lists every destination, including cc and bcc', async () => {
    const { client: c, send } = client();

    await new SesEmailTransport({ client: c }).send({
      ...message,
      cc: ['manager@example.com'],
      bcc: ['audit@example.com'],
    });

    expect(inputOf(send).Destination?.ToAddresses).toEqual([
      'guest@example.com',
      'manager@example.com',
      'audit@example.com',
    ]);
  });

  it('maps default tags into SES message tags', async () => {
    const { client: c, send } = client();

    await new SesEmailTransport({
      client: c,
      defaultTags: { app: 'example', env: 'production' },
    }).send(message);

    expect(inputOf(send).EmailTags).toEqual([
      { Name: 'app', Value: 'example' },
      { Name: 'env', Value: 'production' },
    ]);
  });

  it('omits the tag list entirely when there are no tags', async () => {
    const { client: c, send } = client();

    await new SesEmailTransport({ client: c, defaultTags: {} }).send(message);

    expect(inputOf(send).EmailTags).toBeUndefined();
  });

  it('reports a missing message id as absent rather than inventing one', async () => {
    const { client: c } = client({});

    await expect(new SesEmailTransport({ client: c }).send(message)).resolves.toEqual({
      providerMessageId: undefined,
    });
  });

  it('wraps a provider rejection as a transport error', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Throttling: Maximum sending rate exceeded'));
    const transport = new SesEmailTransport({ client: { send } as unknown as SesV2Like });

    await expect(transport.send(message)).rejects.toBeInstanceOf(EmailTransportError);
    await expect(transport.send(message)).rejects.toThrow('Maximum sending rate exceeded');
  });

  it('keeps the original failure attached for diagnosis', async () => {
    const cause = new Error('AccountSendingPausedException');
    const send = vi.fn().mockRejectedValue(cause);
    const transport = new SesEmailTransport({ client: { send } as unknown as SesV2Like });

    await expect(transport.send(message)).rejects.toMatchObject({ cause });
  });
});
