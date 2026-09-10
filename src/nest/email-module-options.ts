import { DeliveryLogStore } from '../ports/delivery-log.store';
import { EmailLogger } from '../ports/logger';
import { ReputationStore } from '../ports/reputation.store';
import { SuppressionStore } from '../ports/suppression.store';
import { EmailAddress } from '../ports/transport';
import { EmailTransportOptions } from '../transport/transport-options';

// Re-exported so existing importers of this module keep working; the type now
// lives in the transport layer, which is what it describes.
export { EmailTransportOptions };

export interface EmailModuleOptions {
  /** How mail physically leaves. */
  transport: EmailTransportOptions;
  /** Default sender identity. Individual sends may override it. */
  from: EmailAddress;
  /** Where the three kinds of state live. Supply real stores before sending real mail. */
  stores: {
    deliveryLog: DeliveryLogStore;
    reputation: ReputationStore;
    suppression: SuppressionStore;
  };
  validation?: {
    /**
     * Off for tests and local dev, which use non-routable addresses with no
     * live resolver. On everywhere mail actually goes out.
     */
    mxCheckEnabled?: boolean;
    extraDisposableDomains?: readonly string[];
  };
  feedback?: {
    /**
     * SNS signature verification. Off only where unsigned fixtures are posted
     * and there is no network to AWS; when off, the shared secret becomes the
     * sole way in.
     */
    snsSignatureVerification?: boolean;
    /**
     * Interim shared secret accepted as `?token=`, because SNS HTTPS
     * subscriptions cannot set custom headers. Empty disables the fallback.
     */
    webhookSecret?: string;
    /**
     * Topic ARNs permitted to auto-confirm their own SNS subscription. Empty
     * keeps the manual flow, which is the safe default. One entry per SES
     * region, since SNS topics are regional.
     */
    allowedTopicArns?: readonly string[];
  };
  retention?: {
    /** Days of per-send delivery log kept. Defaults to 7. */
    deliveryLogDays?: number;
  };
  logger?: EmailLogger;
}
