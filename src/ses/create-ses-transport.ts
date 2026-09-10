import { SESv2Client } from '@aws-sdk/client-sesv2';
import { EmailTransport } from '../ports/transport';
import { EmailTransportOptions } from '../transport/transport-options';
import { SesEmailTransport } from '../transport/ses-transport';

export type SesTransportConfig = Extract<EmailTransportOptions, { kind: 'ses' }>;

/**
 * Build the SES transport, constructing the SDK client from the options.
 *
 * Lives under the `ses` entry point rather than in the core transport factory
 * because it is the only transport whose construction needs the AWS SDK, and
 * core must stay installable without it. Importing `sendrail/ses` IS the act of
 * opting into AWS.
 */
export function createSesTransport(options: SesTransportConfig): EmailTransport {
  return new SesEmailTransport({
    client: new SESv2Client({ region: options.region }),
    configurationSetName: options.configurationSetName,
    defaultTags: options.tags,
  });
}
