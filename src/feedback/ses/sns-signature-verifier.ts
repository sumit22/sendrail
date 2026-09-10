import { createVerify } from 'node:crypto';
import { EmailLogger, NULL_LOGGER } from '../../ports/logger';

/** Fetches a PEM certificate for a URL the verifier has already host-checked. */
export type CertificateFetcher = (url: string) => Promise<string>;

export interface SnsSignatureVerifierOptions {
  /**
   * Off for tests and local dev, which post unsigned fixtures and have no
   * network to AWS. When off, {@link hasValidSignature} returns false — never
   * true — so a skipped check is never mistaken for a passed one.
   */
  enabled?: boolean;
  logger?: EmailLogger;
  /** Override the cert fetch (tests, or a host with its own HTTP client). */
  fetchCertificate?: CertificateFetcher;
}

/**
 * SNS signing certificates are served from `sns.<region>.amazonaws.com` and
 * nowhere else. Checking this BEFORE fetching is what stops a forged
 * `SigningCertURL` from turning signature verification into an SSRF primitive.
 */
const SIGNING_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/**
 * SNS serves its signing certificates from exactly one filename shape. Pinning
 * it matters because the cert URL arrives on an UNAUTHENTICATED request — the
 * signature cannot be checked until the cert is fetched — so without this, a
 * crafted envelope can make us issue an outbound request to any path it likes
 * under the SNS host, once per distinct URL.
 */
const SIGNING_PATH = /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/;

/**
 * Cap on distinct certificates held. AWS rotates rarely, so a handful is the
 * real working set; the cap is there so unauthenticated input cannot grow the
 * map without bound.
 */
const MAX_CACHED_CERTIFICATES = 8;

/**
 * Fields covered by the signature, in the exact order SNS canonicalises them.
 * Anything not listed — `SignatureVersion`, `SigningCertURL`, `UnsubscribeURL`
 * — is deliberately outside the signed payload.
 */
const SIGNED_KEYS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

/** SignatureVersion → the algorithm SNS signed with. */
const ALGORITHMS: Record<string, string> = {
  '1': 'RSA-SHA1',
  '2': 'RSA-SHA256',
};

/**
 * Verifies the cryptographic SNS signature on a webhook body.
 *
 * Checks the `SigningCertURL` is a real SNS host (anti-SSRF), fetches and
 * caches the signing certificate, rebuilds the canonical string SNS signed, and
 * RSA-verifies the signature against it.
 *
 * Certificates are cached by URL for the process lifetime — AWS rotates them
 * rarely, and an unbounded refetch on every webhook is both slow and a way to
 * get rate-limited during a bounce storm.
 */
export class SnsSignatureVerifier {
  private readonly enabled: boolean;
  private readonly logger: EmailLogger;
  private readonly fetchCertificate: CertificateFetcher;
  private readonly certCache = new Map<string, Promise<string>>();

  constructor(options: SnsSignatureVerifierOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.logger = options.logger ?? NULL_LOGGER;
    this.fetchCertificate = options.fetchCertificate ?? defaultCertificateFetcher;
  }

  /**
   * True ONLY when signature checking is enabled AND the raw body carries a
   * cryptographically valid SNS signature — i.e. a POSITIVE verification.
   *
   * Returns false when checking is disabled so the caller falls back to the
   * shared-secret token rather than treating "unchecked" as "authorized". Never
   * grant access on a skipped check.
   */
  async hasValidSignature(rawBody: string): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const envelope = JSON.parse(rawBody) as Record<string, unknown>;

      const type = asString(envelope.Type);
      const signedKeys = SIGNED_KEYS[type ?? ''];
      if (!signedKeys) {
        throw new Error(`Unsupported SNS envelope type "${type ?? 'null'}"`);
      }

      const algorithm = ALGORITHMS[asString(envelope.SignatureVersion) ?? ''];
      if (!algorithm) {
        throw new Error(
          `Unsupported SNS SignatureVersion "${asString(envelope.SignatureVersion)}"`
        );
      }

      const signature = asString(envelope.Signature);
      const certUrl = asString(envelope.SigningCertURL);
      if (!signature || !certUrl) {
        throw new Error('SNS envelope is missing Signature or SigningCertURL');
      }
      if (!isSnsCertificateUrl(certUrl)) {
        throw new Error(`SigningCertURL is not an SNS signing certificate: ${certUrl}`);
      }

      const certificate = await this.certificate(certUrl);

      const verifier = createVerify(algorithm);
      verifier.update(canonicalString(envelope, signedKeys), 'utf8');

      return verifier.verify(certificate, signature, 'base64');
    } catch (error) {
      this.logger.warn('SNS signature verification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private certificate(url: string): Promise<string> {
    const cached = this.certCache.get(url);
    if (cached) {
      return cached;
    }

    // Oldest-first eviction. Insertion order is Map's iteration order, and the
    // working set is a handful of certs, so nothing cleverer earns its keep.
    if (this.certCache.size >= MAX_CACHED_CERTIFICATES) {
      const oldest = this.certCache.keys().next();
      if (!oldest.done) {
        this.certCache.delete(oldest.value);
      }
    }

    // Cache the promise, not the resolved value, so concurrent webhooks during a
    // bounce storm share one fetch. A rejection is evicted so the next request
    // retries instead of caching the failure forever.
    const pending = this.fetchCertificate(url).catch((error: unknown) => {
      this.certCache.delete(url);
      throw error;
    });
    this.certCache.set(url, pending);

    return pending;
  }
}

/**
 * `key\nvalue\n` for each signed field present, in SNS's canonical order.
 * Absent optional fields (`Subject`) are skipped entirely rather than emitted
 * empty — emitting them produces a different string and a failed verification.
 */
function canonicalString(envelope: Record<string, unknown>, keys: string[]): string {
  let canonical = '';
  for (const key of keys) {
    const value = envelope[key];
    if (typeof value !== 'string') {
      continue;
    }
    canonical += `${key}\n${value}\n`;
  }
  return canonical;
}

/**
 * Whether a URL is one SNS itself would have served — HTTPS, on an SNS host.
 *
 * Used for the SubscribeURL as well as the signing certificate, which is why the
 * path is not checked here: confirmation URLs carry a query string and a
 * different path entirely.
 */
export function isSnsSigningUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && SIGNING_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** As {@link isSnsSigningUrl}, and the path is a signing certificate's. */
export function isSnsCertificateUrl(url: string): boolean {
  if (!isSnsSigningUrl(url)) {
    return false;
  }

  try {
    return SIGNING_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function defaultCertificateFetcher(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Certificate fetch returned HTTP ${response.status}`);
  }
  return response.text();
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
