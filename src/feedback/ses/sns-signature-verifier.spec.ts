import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SnsSignatureVerifier,
  isSnsCertificateUrl,
  isSnsSigningUrl,
} from './sns-signature-verifier';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const CERT_URL = 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abc123.pem';

/** Canonical string is key\nvalue\n for the signed fields, in SNS's order. */
function sign(envelope: Record<string, unknown>, keys: string[], version: '1' | '2'): string {
  let canonical = '';
  for (const key of keys) {
    if (typeof envelope[key] === 'string') {
      canonical += `${key}\n${envelope[key] as string}\n`;
    }
  }

  const signer = createSign(version === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
  signer.update(canonical, 'utf8');
  envelope.Signature = signer.sign(privateKey, 'base64');

  return JSON.stringify(envelope);
}

function signedNotification(
  overrides: Record<string, unknown> = {},
  version: '1' | '2' = '1'
): string {
  const envelope: Record<string, unknown> = {
    Type: 'Notification',
    MessageId: 'msg-1',
    TopicArn: 'arn:aws:sns:ap-south-1:1234:ses-feedback',
    Message: '{"eventType":"Delivery"}',
    Timestamp: '2026-08-01T10:00:00.000Z',
    SignatureVersion: version,
    SigningCertURL: CERT_URL,
    ...overrides,
  };

  return sign(
    envelope,
    ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
    version
  );
}

function signedConfirmation(): string {
  const envelope: Record<string, unknown> = {
    Type: 'SubscriptionConfirmation',
    MessageId: 'msg-1',
    Token: 'token-1',
    TopicArn: 'arn:aws:sns:ap-south-1:1234:ses-feedback',
    Message: 'You have chosen to subscribe',
    SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription',
    Timestamp: '2026-08-01T10:00:00.000Z',
    SignatureVersion: '1',
    SigningCertURL: CERT_URL,
  };

  return sign(
    envelope,
    ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
    '1'
  );
}

describe('SnsSignatureVerifier', () => {
  it('accepts a correctly signed notification', async () => {
    const verifier = new SnsSignatureVerifier({
      fetchCertificate: async () => publicKey,
    });

    await expect(verifier.hasValidSignature(signedNotification())).resolves.toBe(true);
  });

  it('rejects a body tampered with after signing', async () => {
    const verifier = new SnsSignatureVerifier({
      fetchCertificate: async () => publicKey,
    });

    const envelope = JSON.parse(signedNotification()) as Record<string, unknown>;
    envelope.Message = '{"eventType":"Bounce"}';

    await expect(verifier.hasValidSignature(JSON.stringify(envelope))).resolves.toBe(false);
  });

  it('includes Subject in the canonical string when present', async () => {
    const verifier = new SnsSignatureVerifier({ fetchCertificate: async () => publicKey });

    await expect(
      verifier.hasValidSignature(signedNotification({ Subject: 'Amazon SES Email Event' }))
    ).resolves.toBe(true);
  });

  it('returns false — never true — when verification is disabled', async () => {
    const verifier = new SnsSignatureVerifier({
      enabled: false,
      fetchCertificate: async () => publicKey,
    });

    // A skipped check must never read as a passed one: the caller falls back to
    // the shared secret rather than treating "unchecked" as "authorized".
    await expect(verifier.hasValidSignature(signedNotification())).resolves.toBe(false);
  });

  it('refuses to fetch a certificate from a non-SNS host', async () => {
    const fetchCertificate = vi.fn(async () => publicKey);
    const verifier = new SnsSignatureVerifier({ fetchCertificate });

    const body = signedNotification({
      SigningCertURL: 'https://evil.example.com/SimpleNotificationService-abc.pem',
    });

    await expect(verifier.hasValidSignature(body)).resolves.toBe(false);
    expect(fetchCertificate).not.toHaveBeenCalled();
  });

  it('caches the certificate across verifications', async () => {
    const fetchCertificate = vi.fn(async () => publicKey);
    const verifier = new SnsSignatureVerifier({ fetchCertificate });

    await verifier.hasValidSignature(signedNotification());
    await verifier.hasValidSignature(signedNotification({ MessageId: 'msg-2' }));

    expect(fetchCertificate).toHaveBeenCalledTimes(1);
  });

  it('retries the fetch after a failure rather than caching it', async () => {
    const fetchCertificate = vi
      .fn<(url: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(publicKey);
    const verifier = new SnsSignatureVerifier({ fetchCertificate });

    await expect(verifier.hasValidSignature(signedNotification())).resolves.toBe(false);
    await expect(verifier.hasValidSignature(signedNotification())).resolves.toBe(true);
    expect(fetchCertificate).toHaveBeenCalledTimes(2);
  });

  it('refuses a certificate URL whose path is not a signing certificate', async () => {
    // The cert URL arrives on an UNAUTHENTICATED request — the signature cannot
    // be checked until the cert is fetched — so an unpinned path lets a crafted
    // envelope aim an outbound request anywhere under the SNS host.
    const fetchCertificate = vi.fn(async () => publicKey);
    const verifier = new SnsSignatureVerifier({ fetchCertificate });

    const body = signedNotification({
      SigningCertURL: 'https://sns.ap-south-1.amazonaws.com/../../internal/admin',
    });

    await expect(verifier.hasValidSignature(body)).resolves.toBe(false);
    expect(fetchCertificate).not.toHaveBeenCalled();
  });

  it('caps the certificate cache so crafted input cannot grow it without bound', async () => {
    const fetchCertificate = vi.fn(async () => publicKey);
    const verifier = new SnsSignatureVerifier({ fetchCertificate });

    // Twelve distinct cert URLs against a cap of eight.
    for (let i = 0; i < 12; i += 1) {
      await verifier.hasValidSignature(
        signedNotification({
          SigningCertURL: `https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-cert${i}.pem`,
        })
      );
    }

    // The first URL was evicted, so it is fetched again rather than served warm.
    await verifier.hasValidSignature(
      signedNotification({
        SigningCertURL: 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-cert0.pem',
      })
    );

    expect(fetchCertificate).toHaveBeenCalledTimes(13);
  });

  it('rejects an unparseable body without throwing', async () => {
    const verifier = new SnsSignatureVerifier({ fetchCertificate: async () => publicKey });

    await expect(verifier.hasValidSignature('not json')).resolves.toBe(false);
  });
});

describe('SnsSignatureVerifier — malformed envelopes', () => {
  const verifier = () => new SnsSignatureVerifier({ fetchCertificate: async () => publicKey });

  it('rejects an unsupported SNS envelope type', async () => {
    await expect(
      verifier().hasValidSignature(JSON.stringify({ Type: 'Nonsense', Signature: 'x' }))
    ).resolves.toBe(false);
  });

  it('rejects an unsupported SignatureVersion', async () => {
    // Only 1 (SHA1) and 2 (SHA256) exist; anything else is not something AWS sent.
    const envelope = JSON.parse(signedNotification()) as Record<string, unknown>;
    envelope.SignatureVersion = '9';

    await expect(verifier().hasValidSignature(JSON.stringify(envelope))).resolves.toBe(false);
  });

  it('verifies a SignatureVersion 2 (SHA256) envelope', async () => {
    const envelope = JSON.parse(signedNotification({}, '2')) as Record<string, unknown>;

    await expect(verifier().hasValidSignature(JSON.stringify(envelope))).resolves.toBe(true);
  });

  it('rejects an envelope with no signature', async () => {
    const envelope = JSON.parse(signedNotification()) as Record<string, unknown>;
    delete envelope.Signature;

    await expect(verifier().hasValidSignature(JSON.stringify(envelope))).resolves.toBe(false);
  });

  it('rejects an envelope with no signing certificate URL', async () => {
    const envelope = JSON.parse(signedNotification()) as Record<string, unknown>;
    delete envelope.SigningCertURL;

    await expect(verifier().hasValidSignature(JSON.stringify(envelope))).resolves.toBe(false);
  });

  it('verifies a SubscriptionConfirmation, which signs a different field set', async () => {
    await expect(verifier().hasValidSignature(signedConfirmation())).resolves.toBe(true);
  });
});

describe('the default certificate fetcher', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches the certificate over HTTPS when none is injected', async () => {
    const fetchMock = vi.fn(async () => new Response(publicKey, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(new SnsSignatureVerifier().hasValidSignature(signedNotification())).resolves.toBe(
      true
    );
    expect(fetchMock).toHaveBeenCalledWith(CERT_URL);
  });

  it('rejects rather than trusting a non-200 certificate response', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 503 })
    ) as unknown as typeof fetch;

    await expect(new SnsSignatureVerifier().hasValidSignature(signedNotification())).resolves.toBe(
      false
    );
  });
});

describe('isSnsCertificateUrl', () => {
  it.each([
    ['https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem', true],
    ['https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-abc.pem', true],
    ['https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem?x=1', true],
    ['https://sns.us-east-1.amazonaws.com/evil.pem', false],
    ['https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.txt', false],
    ['https://sns.us-east-1.amazonaws.com/', false],
    ['https://evil.com/SimpleNotificationService-abc.pem', false],
  ])('%s → %s', (url, expected) => {
    expect(isSnsCertificateUrl(url)).toBe(expected);
  });
});

describe('isSnsSigningUrl', () => {
  it.each([
    ['https://sns.us-east-1.amazonaws.com/cert.pem', true],
    ['https://sns.cn-north-1.amazonaws.com.cn/cert.pem', true],
    ['http://sns.us-east-1.amazonaws.com/cert.pem', false],
    ['https://sns.us-east-1.amazonaws.com.evil.com/cert.pem', false],
    ['https://evil.com/sns.us-east-1.amazonaws.com/cert.pem', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isSnsSigningUrl(url)).toBe(expected);
  });
});
