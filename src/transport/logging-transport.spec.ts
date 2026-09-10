import { describe, expect, it, vi } from 'vitest';
import { EmailLogger } from '../ports/logger';
import { OutboundEmail } from '../ports/transport';
import { LoggingEmailTransport } from './logging-transport';

const message: OutboundEmail = {
  to: 'guest@example.com',
  from: { email: 'noreply@example.com', name: 'Example' },
  subject: 'Your order is confirmed',
  html: '<p>See you Saturday.</p>',
  text: 'See you Saturday.',
};

describe('LoggingEmailTransport', () => {
  it('writes the message to the log instead of sending it', async () => {
    const logger: EmailLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await new LoggingEmailTransport(logger).send(message);

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('guest@example.com'),
      expect.objectContaining({ from: 'noreply@example.com' })
    );
  });

  it('returns no provider message id, because nothing was sent', async () => {
    await expect(new LoggingEmailTransport().send(message)).resolves.toEqual({});
  });

  it('works with no logger wired', async () => {
    await expect(new LoggingEmailTransport().send(message)).resolves.toBeDefined();
  });
});
