import { describe, expect, it } from 'vitest';
import {
  EmailAddressValidator,
  MailHostResolver,
  NODE_DNS_RESOLVER,
  REJECT_DISPOSABLE,
  REJECT_NO_MAIL_HOST,
  REJECT_SYNTAX,
} from './email-address-validator';

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A resolver that answers "no such record" for everything. */
const NO_RECORDS: MailHostResolver = {
  resolveMx: async () => {
    throw dnsError('ENOTFOUND');
  },
  resolve4: async () => {
    throw dnsError('ENOTFOUND');
  },
};

/** A resolver that is itself broken — not an answer, a failure. */
const BROKEN: MailHostResolver = {
  resolveMx: async () => {
    throw dnsError('ESERVFAIL');
  },
  resolve4: async () => {
    throw dnsError('ETIMEOUT');
  },
};

const HAS_MX: MailHostResolver = {
  resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }],
  resolve4: async () => [],
};

describe('EmailAddressValidator', () => {
  const noDns = new EmailAddressValidator({ mxCheckEnabled: false });

  it.each([
    '',
    '   ',
    'not-an-email',
    'missing@tld',
    'two@@example.com',
    'spaces in@example.com',
    'trailing@example.com.',
    `${'a'.repeat(250)}@example.com`,
  ])('rejects %j as malformed', async (address) => {
    await expect(noDns.rejectionReason(address)).resolves.toBe(REJECT_SYNTAX);
  });

  it.each(['ok@example.com', 'first.last+tag@sub.example.co.in', 'x@e-x.io'])(
    'accepts %j',
    async (address) => {
      await expect(noDns.rejectionReason(address)).resolves.toBeNull();
    }
  );

  it('rejects known disposable domains, case-insensitively', async () => {
    await expect(noDns.rejectionReason('throwaway@Mailinator.com')).resolves.toBe(
      REJECT_DISPOSABLE
    );
  });

  it('accepts extra disposable domains supplied by the host', async () => {
    const validator = new EmailAddressValidator({
      mxCheckEnabled: false,
      extraDisposableDomains: ['burner.test'],
    });

    await expect(validator.rejectionReason('x@burner.test')).resolves.toBe(REJECT_DISPOSABLE);
  });

  it('rejects a domain with neither an MX nor an A record', async () => {
    const validator = new EmailAddressValidator({ mxCheckEnabled: true, resolver: NO_RECORDS });

    await expect(validator.rejectionReason('x@nowhere.example')).resolves.toBe(REJECT_NO_MAIL_HOST);
  });

  it('accepts when the domain has an MX record', async () => {
    const validator = new EmailAddressValidator({ mxCheckEnabled: true, resolver: HAS_MX });

    await expect(validator.rejectionReason('x@example.com')).resolves.toBeNull();
  });

  it('falls back to the A record when there is no MX (RFC 5321 §5.1)', async () => {
    const validator = new EmailAddressValidator({
      mxCheckEnabled: true,
      resolver: {
        resolveMx: async () => [],
        resolve4: async () => ['203.0.113.10'],
      },
    });

    await expect(validator.rejectionReason('x@a-only.example')).resolves.toBeNull();
  });

  it('skips the DNS check entirely when disabled', async () => {
    // Local dev and tests use non-routable addresses with no live resolver.
    await expect(noDns.isSendable('dev@test.local')).resolves.toBe(true);
  });

  it("uses Node's resolver when none is injected", async () => {
    // Guards the default wiring: an unwired resolver would make every address
    // fail open, silently disabling the gate.
    const validator = new EmailAddressValidator({ mxCheckEnabled: true });

    expect(NODE_DNS_RESOLVER.resolveMx).toBeTypeOf('function');
    expect(NODE_DNS_RESOLVER.resolve4).toBeTypeOf('function');
    // A syntax rejection short-circuits before any lookup, so this asserts the
    // construction path without needing a live resolver.
    await expect(validator.rejectionReason('not-an-email')).resolves.toBe(REJECT_SYNTAX);
  });

  it('fails open when the resolver itself is broken', async () => {
    // A DNS hiccup must never silently drop legitimate mail — only a definitive
    // "this domain has no mail host" is a rejection.
    const validator = new EmailAddressValidator({ mxCheckEnabled: true, resolver: BROKEN });

    await expect(validator.rejectionReason('x@example.com')).resolves.toBeNull();
  });
});
