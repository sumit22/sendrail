import { Transporter } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { EmailTransportError } from '../domain/errors';
import { OutboundEmail } from '../ports/transport';
import { SmtpEmailTransport, SmtpTransportOptions } from './smtp-transport';

const message: OutboundEmail = {
  to: 'guest@example.com',
  from: { email: 'noreply@example.com', name: 'Example' },
  subject: 'Your order is confirmed',
  html: '<p>See you Saturday.</p>',
  text: 'See you Saturday.',
};

function build(
  sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@example.com>' }),
  options: Partial<SmtpTransportOptions> = {}
) {
  const seen: SmtpTransportOptions[] = [];
  const transport = new SmtpEmailTransport({
    host: 'mailpit',
    port: 1025,
    ...options,
    createTransport: (opts) => {
      seen.push(opts);
      return { sendMail } as unknown as Transporter;
    },
  });

  return { transport, sendMail, seen };
}

describe('SmtpEmailTransport', () => {
  it('passes the message fields through to the transporter', async () => {
    const { transport, sendMail } = build();

    await transport.send({ ...message, replyTo: 'support@example.com' });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'guest@example.com',
        from: { name: 'Example', address: 'noreply@example.com' },
        subject: 'Your order is confirmed',
        html: '<p>See you Saturday.</p>',
        text: 'See you Saturday.',
        replyTo: 'support@example.com',
      })
    );
  });

  it('sends a bare address when no display name is set', async () => {
    const { transport, sendMail } = build();

    await transport.send({ ...message, from: { email: 'noreply@example.com' } });

    expect(sendMail.mock.calls[0][0].from).toBe('noreply@example.com');
  });

  it('returns the RFC Message-ID, which feedback cannot be correlated against', async () => {
    // Recorded for completeness, but SES never echoes this back on a feedback
    // event — rows sent this way can only be matched by recipient.
    const { transport } = build();

    await expect(transport.send(message)).resolves.toEqual({
      providerMessageId: '<abc@example.com>',
    });
  });

  it('wraps a relay rejection as a transport error', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('451 4.4.2 Timeout waiting for data'));
    const { transport } = build(sendMail);

    await expect(transport.send(message)).rejects.toBeInstanceOf(EmailTransportError);
    await expect(transport.send(message)).rejects.toThrow('Timeout waiting for data');
  });

  it('builds the transporter from the supplied connection settings', async () => {
    const { seen } = build(undefined, { host: 'relay.internal', port: 587, user: 'u', pass: 'p' });

    expect(seen[0]).toMatchObject({ host: 'relay.internal', port: 587, user: 'u', pass: 'p' });
  });
});
