import { resolve4, resolveMx } from 'node:dns/promises';
import { DISPOSABLE_DOMAINS } from './disposable-domains';

export const REJECT_SYNTAX = 'invalid_syntax';
export const REJECT_DISPOSABLE = 'disposable_domain';
export const REJECT_NO_MAIL_HOST = 'no_mail_host';

export type RejectionReason =
  | typeof REJECT_SYNTAX
  | typeof REJECT_DISPOSABLE
  | typeof REJECT_NO_MAIL_HOST;

/**
 * The DNS lookups the validator makes. Injectable so tests can assert both the
 * definitive-no path and the fail-open path without a live resolver.
 */
export interface MailHostResolver {
  resolveMx(domain: string): Promise<unknown[]>;
  resolve4(domain: string): Promise<unknown[]>;
}

export const NODE_DNS_RESOLVER: MailHostResolver = {
  resolveMx: (domain) => resolveMx(domain),
  resolve4: (domain) => resolve4(domain),
};

export interface EmailAddressValidatorOptions {
  /**
   * Whether to check the domain has a mail host. Off for tests and local dev,
   * which use non-routable addresses (`*@test.local`) with no live resolver.
   */
  mxCheckEnabled?: boolean;
  /** Extra domains to reject on top of the built-in list. */
  extraDisposableDomains?: readonly string[];
  /** Override the resolver. Defaults to Node's. */
  resolver?: MailHostResolver;
}

/**
 * RFC 5322-ish address syntax. Deliberately stricter than the full grammar
 * (no quoted local parts, no address literals) and looser than a deliverability
 * check — it exists to reject garbage before it reaches a provider, not to
 * adjudicate exotic-but-legal addresses.
 */
const SYNTAX =
  /^[^\s@,;:<>"'\\]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * Hard, vendor-agnostic email validation run at the send boundary — BEFORE any
 * mail vendor is called, so a malformed or tampered address never reaches the
 * provider and never becomes a bounce that hurts sender reputation.
 *
 * Three cheap checks, in order: syntax → known-disposable domain → the domain
 * actually has a mail host (MX, or A as the RFC 5321 §5.1 fallback).
 *
 * The mail-host check FAILS OPEN: a lookup that itself fails (transient DNS)
 * must NOT block a legitimate send — only a definitive "this domain has no MX
 * and no A record" is a rejection.
 *
 * This is a bounce-*reduction* gate, not a guarantee: a syntactically valid,
 * MX-having address can still be a dead mailbox discoverable only by sending.
 * The second layer — never re-sending to a known-bounced address — is the
 * suppression store.
 */
export class EmailAddressValidator {
  private readonly mxCheckEnabled: boolean;
  private readonly disposableDomains: Set<string>;
  private readonly resolver: MailHostResolver;

  constructor(options: EmailAddressValidatorOptions = {}) {
    this.mxCheckEnabled = options.mxCheckEnabled ?? true;
    this.disposableDomains = new Set([
      ...DISPOSABLE_DOMAINS,
      ...(options.extraDisposableDomains ?? []).map((d) => d.toLowerCase()),
    ]);
    this.resolver = options.resolver ?? NODE_DNS_RESOLVER;
  }

  /**
   * @returns a rejection reason if the address must not be sent to, or null if
   *          it is safe to attempt
   */
  async rejectionReason(email: string): Promise<RejectionReason | null> {
    const address = (email ?? '').trim();

    if (address === '' || address.length > 254 || !SYNTAX.test(address)) {
      return REJECT_SYNTAX;
    }

    const at = address.lastIndexOf('@');
    if (at === -1) {
      return REJECT_SYNTAX;
    }
    const domain = address.slice(at + 1).toLowerCase();

    if (this.disposableDomains.has(domain)) {
      return REJECT_DISPOSABLE;
    }

    if (this.mxCheckEnabled && !(await this.hasMailExchanger(domain))) {
      return REJECT_NO_MAIL_HOST;
    }

    return null;
  }

  async isSendable(email: string): Promise<boolean> {
    return (await this.rejectionReason(email)) === null;
  }

  /**
   * True unless the domain DEFINITIVELY has no mail host. A lookup that errors
   * for any reason other than "no such record" fails OPEN so a DNS hiccup can't
   * silently drop legitimate mail.
   */
  protected async hasMailExchanger(domain: string): Promise<boolean> {
    const mx = await lookup(() => this.resolver.resolveMx(domain));
    if (mx === 'lookup_failed' || mx.length > 0) {
      return true;
    }

    // RFC 5321 §5.1: no MX means fall back to the A record.
    const a = await lookup(() => this.resolver.resolve4(domain));
    return a === 'lookup_failed' || a.length > 0;
  }
}

/**
 * `ENOTFOUND` / `ENODATA` are the definitive "this domain has no such record"
 * answers. Everything else (SERVFAIL, timeout, refused) is the resolver
 * failing, not an answer — reported as `lookup_failed` so the caller fails open.
 */
async function lookup<T>(fn: () => Promise<T[]>): Promise<T[] | 'lookup_failed'> {
  try {
    return await fn();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return [];
    }
    return 'lookup_failed';
  }
}
