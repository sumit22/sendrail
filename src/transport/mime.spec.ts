import { describe, expect, it } from 'vitest';
import { OutboundEmail } from '../ports/transport';
import { composeMime } from './mime';

const base: OutboundEmail = {
  to: 'guest@example.com',
  from: { email: 'noreply@example.com', name: 'Example' },
  subject: 'Your order is confirmed',
  html: '<p>See you Saturday.</p>',
  text: 'See you Saturday.',
};

async function compose(overrides: Partial<OutboundEmail> = {}): Promise<string> {
  return (await composeMime({ ...base, ...overrides })).toString('utf8');
}

describe('composeMime', () => {
  it('carries the sender display name, not just the address', async () => {
    // SES sends the From header verbatim, so a bare address arrives with no name
    // attached — which reads as machine-generated to recipients and filters alike.
    expect(await compose()).toContain('From: Example <noreply@example.com>');
  });

  it('sends a bare address when no display name is set', async () => {
    const mime = await compose({ from: { email: 'noreply@example.com' } });

    expect(mime).toContain('From: noreply@example.com');
    expect(mime).not.toContain('Example <');
  });

  it('includes recipient and subject', async () => {
    const mime = await compose();

    expect(mime).toContain('To: guest@example.com');
    expect(mime).toContain('Your order is confirmed');
  });

  it('builds a multipart message carrying both bodies', async () => {
    const mime = await compose();

    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('text/plain');
    expect(mime).toContain('text/html');
  });

  it('carries custom headers', async () => {
    // The reason we build the MIME ourselves rather than handing parts to a
    // provider's simple-send API.
    const mime = await compose({
      headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' },
    });

    expect(mime).toContain('List-Unsubscribe: <https://example.com/unsubscribe>');
  });

  it('carries reply-to and cc', async () => {
    const mime = await compose({
      replyTo: 'support@example.com',
      cc: ['manager@example.com'],
    });

    expect(mime).toContain('Reply-To: support@example.com');
    expect(mime).toContain('Cc: manager@example.com');
  });

  it('does not leak bcc into the message headers', async () => {
    // Bcc is an envelope concern; a Bcc header in the body would disclose the
    // hidden recipient to everyone else on the message.
    const mime = await compose({ bcc: ['audit@example.com'] });

    expect(mime).not.toContain('audit@example.com');
  });

  it('encodes a non-ASCII subject rather than emitting raw bytes', async () => {
    const mime = await compose({ subject: 'Réservation confirmée' });

    expect(mime).not.toContain('Réservation confirmée');
    expect(mime).toMatch(/Subject: =\?UTF-8\?/i);
  });
});
