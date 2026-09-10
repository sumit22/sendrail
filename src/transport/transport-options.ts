import { EmailTransport } from '../ports/transport';

/**
 * A description of how mail physically leaves — the input to
 * {@link createEmailTransport}.
 *
 * Lives in the transport layer rather than beside the Nest module options
 * because it describes a transport, and more than one rail is assembled from
 * it: the transactional sender and the cold-outreach sender, which differ only
 * in the SES configuration set they send under.
 */
export type EmailTransportOptions =
  | {
      kind: 'ses';
      region: string;
      /**
       * The SES configuration set to send under. Event publishing to SNS is
       * configured on the configuration set, so omitting it means no delivery
       * feedback arrives and the suppression loop goes quiet.
       */
      configurationSetName?: string;
      /** Message tags attached to every send, for SES event publishing dimensions. */
      tags?: Record<string, string>;
    }
  | { kind: 'smtp'; host: string; port: number; user?: string; pass?: string; secure?: boolean }
  | { kind: 'logging' }
  | { kind: 'custom'; transport: EmailTransport };
