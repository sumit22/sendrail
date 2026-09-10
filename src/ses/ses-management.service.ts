import { GetSendStatisticsCommand, GetSendStatisticsCommandOutput, SESClient } from '@aws-sdk/client-ses';
import {
  GetAccountCommand,
  GetAccountCommandOutput,
  GetEmailIdentityCommand,
  GetEmailIdentityCommandOutput,
  ListEmailIdentitiesCommand,
  ListEmailIdentitiesCommandOutput,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { ExternalServiceError } from '../domain/errors';
import { SesAccountHealth, SesIdentity } from './ses-account-health';

/** The SES v2 calls this service makes, narrowed for testability. */
export interface SesV2ManagementClient {
  send(command: GetAccountCommand): Promise<GetAccountCommandOutput>;
  send(command: ListEmailIdentitiesCommand): Promise<ListEmailIdentitiesCommandOutput>;
  send(command: GetEmailIdentityCommand): Promise<GetEmailIdentityCommandOutput>;
}

/** The single SES v1 call this service makes. */
export interface SesV1ManagementClient {
  send(command: GetSendStatisticsCommand): Promise<GetSendStatisticsCommandOutput>;
}

/**
 * Read surface over the SES account for the admin email console.
 *
 * A permanent contract with a replaceable implementation: today it wraps the
 * AWS SES SDK; a future in-house delivery provider drops in behind the same
 * shape.
 *
 * Two clients by necessity:
 *   - SES v2 `GetAccount` → production access / enforcement / send quota.
 *   - SES v1 `GetSendStatistics` → bounce/complaint datapoints, aggregated into
 *     rates here. v2 exposes no account-level reputation rates at all.
 *
 * Credentials come from the default provider chain (an instance role in
 * production). Any SDK failure is translated to {@link ExternalServiceError} so
 * the console degrades gracefully instead of 500ing.
 */
export interface SesManagementService {
  getAccountHealth(): Promise<SesAccountHealth>;
  listSendingIdentities(): Promise<SesIdentity[]>;
}

export class AwsSesManagementService implements SesManagementService {
  constructor(
    private readonly sesV2: SesV2ManagementClient,
    private readonly sesV1: SesV1ManagementClient,
    private readonly region: string
  ) {}

  async getAccountHealth(): Promise<SesAccountHealth> {
    let account: GetAccountCommandOutput;
    let stats: GetSendStatisticsCommandOutput;
    try {
      [account, stats] = await Promise.all([
        this.sesV2.send(new GetAccountCommand({})),
        this.sesV1.send(new GetSendStatisticsCommand({})),
      ]);
    } catch (error) {
      throw new ExternalServiceError('aws_ses', 'Unable to read SES account health.', error);
    }

    const quota = account.SendQuota ?? {};
    const { bounceRate, complaintRate, attempts } = reputationFrom(stats.SendDataPoints ?? []);

    return {
      productionAccess: Boolean(account.ProductionAccessEnabled),
      sendingEnabled: Boolean(account.SendingEnabled),
      enforcementStatus: account.EnforcementStatus ?? 'UNKNOWN',
      max24HourSend: Math.trunc(quota.Max24HourSend ?? 0),
      maxSendRate: quota.MaxSendRate ?? 0,
      sentLast24Hours: Math.trunc(quota.SentLast24Hours ?? 0),
      bounceRate,
      complaintRate,
      statsSampleSize: attempts,
      region: this.region,
    };
  }

  async listSendingIdentities(): Promise<SesIdentity[]> {
    try {
      const list = await this.sesV2.send(new ListEmailIdentitiesCommand({}));
      const entries = list.EmailIdentities ?? [];

      const identities: SesIdentity[] = [];
      for (const entry of entries) {
        const name = entry.IdentityName ?? '';
        if (name === '') {
          continue;
        }

        // Per-identity DKIM status — ListEmailIdentities doesn't carry it.
        const detail = await this.sesV2.send(new GetEmailIdentityCommand({ EmailIdentity: name }));

        identities.push({
          identity: name,
          type: entry.IdentityType ?? 'UNKNOWN',
          verifiedForSending: Boolean(entry.SendingEnabled),
          dkimStatus: detail.DkimAttributes?.Status ?? 'NOT_STARTED',
        });
      }

      return identities;
    } catch (error) {
      throw new ExternalServiceError('aws_ses', 'Unable to read SES sending identities.', error);
    }
  }
}

/**
 * Aggregate SES's 15-minute datapoints (a rolling ~2-week window) into
 * account-level bounce/complaint rates over delivery attempts.
 */
function reputationFrom(
  dataPoints: { DeliveryAttempts?: number; Bounces?: number; Complaints?: number }[]
): { bounceRate: number; complaintRate: number; attempts: number } {
  let attempts = 0;
  let bounces = 0;
  let complaints = 0;

  for (const point of dataPoints) {
    attempts += point.DeliveryAttempts ?? 0;
    bounces += point.Bounces ?? 0;
    complaints += point.Complaints ?? 0;
  }

  if (attempts <= 0) {
    return { bounceRate: 0, complaintRate: 0, attempts: 0 };
  }

  return { bounceRate: bounces / attempts, complaintRate: complaints / attempts, attempts };
}

/**
 * Construct the SES management service with both SDK clients from a region.
 *
 * Two clients by necessity: SES v2 for account and identity state, SES v1 for
 * `GetSendStatistics`, which v2 has no equivalent for.
 *
 * Lives here rather than in the Nest module so that constructing SDK clients is
 * confined to the `ses` entry point, and nothing outside it needs the AWS SDK.
 */
export function createSesManagementService(region: string): SesManagementService {
  return new AwsSesManagementService(new SESv2Client({ region }), new SESClient({ region }), region);
}
