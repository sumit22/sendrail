/**
 * Decoupled view of the SES account's sending health for the admin console.
 *
 * Deliberately NOT the raw AWS response shape — the console reads this, so if
 * the sending rail ever moves off SES the console keeps its contract.
 *
 * Rates are fractions in [0, 1] (multiply by 100 for a percentage). AWS puts an
 * account under review when the bounce rate crosses 5% and the complaint rate
 * 0.1%; those thresholds live in the console UI, not here.
 */
export interface SesAccountHealth {
  productionAccess: boolean;
  sendingEnabled: boolean;
  enforcementStatus: string;
  max24HourSend: number;
  maxSendRate: number;
  sentLast24Hours: number;
  bounceRate: number;
  complaintRate: number;
  /** Delivery attempts the rates were computed over. */
  statsSampleSize: number;
  region: string;
}

/**
 * A SES sending identity (our domain or address) and its verification + DKIM
 * state — the "is our sending domain still authenticated" signal.
 *
 * `dkimStatus` mirrors SES: SUCCESS / PENDING / FAILED / TEMPORARY_FAILURE /
 * NOT_STARTED. `verifiedForSending` false or a non-SUCCESS DKIM status is the
 * "DKIM silently broke" alarm the console exists to raise, usually well before
 * deliverability visibly tanks.
 */
export interface SesIdentity {
  identity: string;
  type: string;
  verifiedForSending: boolean;
  dkimStatus: string;
}

export function isIdentityHealthy(identity: SesIdentity): boolean {
  return identity.verifiedForSending && identity.dkimStatus === 'SUCCESS';
}
