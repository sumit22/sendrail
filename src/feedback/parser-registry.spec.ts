import { describe, expect, it } from 'vitest';
import { EmailFeedbackParser } from './parser';
import { EmailFeedbackParserRegistry } from './parser-registry';

function parser(providerCode: string): EmailFeedbackParser {
  return {
    providerCode,
    verify: async () => true,
    parse: async () => ({ events: [], status: 'processed' }),
  };
}

describe('EmailFeedbackParserRegistry', () => {
  const registry = new EmailFeedbackParserRegistry([parser('ses'), parser('SendGrid')]);

  it('resolves an adapter by its slug', () => {
    expect(registry.get('ses')?.providerCode).toBe('ses');
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    // The slug arrives from a URL path, which is untrusted input.
    expect(registry.get('  SES ')?.providerCode).toBe('ses');
    expect(registry.get('sendgrid')?.providerCode).toBe('SendGrid');
  });

  it('returns null for an unknown slug rather than throwing', () => {
    // The caller is a public webhook endpoint: an unknown slug is untrusted
    // input, not a programming error.
    expect(registry.get('postmark')).toBeNull();
  });

  it('returns null for an empty slug', () => {
    expect(registry.get('')).toBeNull();
  });

  it('lists registered slugs for diagnostics', () => {
    expect(registry.registeredCodes()).toEqual(['ses', 'sendgrid']);
  });

  it('is empty when nothing is registered', () => {
    const empty = new EmailFeedbackParserRegistry();

    expect(empty.registeredCodes()).toEqual([]);
    expect(empty.get('ses')).toBeNull();
  });
});
