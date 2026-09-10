import {
  GetAccountCommand,
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
} from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';
import { ExternalServiceError } from '../domain/errors';
import { isIdentityHealthy } from './ses-account-health';
import {
  AwsSesManagementService,
  SesV1ManagementClient,
  SesV2ManagementClient,
} from './ses-management.service';

const HEALTHY_ACCOUNT = {
  ProductionAccessEnabled: true,
  SendingEnabled: true,
  EnforcementStatus: 'HEALTHY',
  SendQuota: { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 1234 },
};

function build(
  v2Responses: Record<string, unknown> = {},
  v1Response: unknown = { SendDataPoints: [] }
) {
  const v2Send = vi.fn(async (command: unknown) => {
    if (command instanceof GetAccountCommand) {
      return v2Responses.account ?? HEALTHY_ACCOUNT;
    }
    if (command instanceof ListEmailIdentitiesCommand) {
      return v2Responses.list ?? { EmailIdentities: [] };
    }
    if (command instanceof GetEmailIdentityCommand) {
      const name = (command as GetEmailIdentityCommand).input.EmailIdentity as string;
      return (v2Responses.identities as Record<string, unknown>)?.[name] ?? {};
    }
    throw new Error('unexpected command');
  });
  const v1Send = vi.fn(async () => v1Response);

  return {
    service: new AwsSesManagementService(
      { send: v2Send } as unknown as SesV2ManagementClient,
      { send: v1Send } as unknown as SesV1ManagementClient,
      'ap-south-1'
    ),
    v2Send,
  };
}

describe('AwsSesManagementService.getAccountHealth', () => {
  it('reports quota and enforcement state', async () => {
    const { service } = build();

    await expect(service.getAccountHealth()).resolves.toMatchObject({
      productionAccess: true,
      sendingEnabled: true,
      enforcementStatus: 'HEALTHY',
      max24HourSend: 50000,
      maxSendRate: 14,
      sentLast24Hours: 1234,
      region: 'ap-south-1',
    });
  });

  it('aggregates the 15-minute datapoints into account-level rates', async () => {
    // SES exposes no account-level reputation rates, only these buckets — the
    // numbers AWS actually judges the account on have to be computed here.
    const { service } = build(
      {},
      {
        SendDataPoints: [
          { DeliveryAttempts: 100, Bounces: 3, Complaints: 1 },
          { DeliveryAttempts: 100, Bounces: 1, Complaints: 0 },
        ],
      }
    );

    await expect(service.getAccountHealth()).resolves.toMatchObject({
      bounceRate: 0.02,
      complaintRate: 0.005,
      statsSampleSize: 200,
    });
  });

  it('reports zero rates rather than dividing by zero on a silent account', async () => {
    const { service } = build({}, { SendDataPoints: [{ DeliveryAttempts: 0 }] });

    await expect(service.getAccountHealth()).resolves.toMatchObject({
      bounceRate: 0,
      complaintRate: 0,
      statsSampleSize: 0,
    });
  });

  it('defaults a missing enforcement status rather than reporting it as healthy', async () => {
    const { service } = build({ account: { SendQuota: {} } });

    await expect(service.getAccountHealth()).resolves.toMatchObject({
      enforcementStatus: 'UNKNOWN',
      productionAccess: false,
      sendingEnabled: false,
      max24HourSend: 0,
    });
  });

  it('translates an SDK failure so the console degrades instead of 500ing', async () => {
    const v2Send = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const service = new AwsSesManagementService(
      { send: v2Send } as unknown as SesV2ManagementClient,
      { send: vi.fn(async () => ({})) } as unknown as SesV1ManagementClient,
      'ap-south-1'
    );

    await expect(service.getAccountHealth()).rejects.toBeInstanceOf(ExternalServiceError);
    await expect(service.getAccountHealth()).rejects.toMatchObject({ service: 'aws_ses' });
  });
});

describe('AwsSesManagementService.listSendingIdentities', () => {
  it('reports per-identity DKIM status, which the list call does not carry', async () => {
    const { service } = build({
      list: {
        EmailIdentities: [
          { IdentityName: 'example.com', IdentityType: 'DOMAIN', SendingEnabled: true },
        ],
      },
      identities: { 'example.com': { DkimAttributes: { Status: 'SUCCESS' } } },
    });

    await expect(service.listSendingIdentities()).resolves.toEqual([
      {
        identity: 'example.com',
        type: 'DOMAIN',
        verifiedForSending: true,
        dkimStatus: 'SUCCESS',
      },
    ]);
  });

  it('reports a missing DKIM record as NOT_STARTED rather than assuming success', async () => {
    const { service } = build({
      list: { EmailIdentities: [{ IdentityName: 'example.com', SendingEnabled: false }] },
      identities: { 'example.com': {} },
    });

    await expect(service.listSendingIdentities()).resolves.toEqual([
      {
        identity: 'example.com',
        type: 'UNKNOWN',
        verifiedForSending: false,
        dkimStatus: 'NOT_STARTED',
      },
    ]);
  });

  it('skips a nameless entry instead of fetching detail for an empty identity', async () => {
    const { service, v2Send } = build({
      list: { EmailIdentities: [{ IdentityName: '' }, { IdentityName: undefined }] },
    });

    await expect(service.listSendingIdentities()).resolves.toEqual([]);
    expect(v2Send.mock.calls.filter(([c]) => c instanceof GetEmailIdentityCommand)).toHaveLength(0);
  });

  it('returns an empty list when the account has no identities', async () => {
    const { service } = build({ list: {} });

    await expect(service.listSendingIdentities()).resolves.toEqual([]);
  });

  it('translates an SDK failure', async () => {
    const v2Send = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    const service = new AwsSesManagementService(
      { send: v2Send } as unknown as SesV2ManagementClient,
      { send: vi.fn() } as unknown as SesV1ManagementClient,
      'ap-south-1'
    );

    await expect(service.listSendingIdentities()).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe('isIdentityHealthy', () => {
  const identity = {
    identity: 'example.com',
    type: 'DOMAIN',
    verifiedForSending: true,
    dkimStatus: 'SUCCESS',
  };

  it('is healthy only when verified AND DKIM succeeded', () => {
    expect(isIdentityHealthy(identity)).toBe(true);
  });

  it.each(['PENDING', 'FAILED', 'TEMPORARY_FAILURE', 'NOT_STARTED'])(
    'is unhealthy when DKIM is %s — the silent-breakage alarm',
    (dkimStatus) => {
      expect(isIdentityHealthy({ ...identity, dkimStatus })).toBe(false);
    }
  );

  it('is unhealthy when the identity cannot send', () => {
    expect(isIdentityHealthy({ ...identity, verifiedForSending: false })).toBe(false);
  });
});
