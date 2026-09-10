import { SendEmailCommand, SendEmailCommandOutput } from '@aws-sdk/client-sesv2';
import { EmailTransportError } from '../domain/errors';
import { EmailTransport, OutboundEmail, SendResult } from '../ports/transport';
import { composeMime } from './mime';

/**
 * The slice of `SESv2Client` this transport uses. Narrow on purpose: a test
 * double is one object literal, and the real client satisfies it structurally.
 */
export interface SesV2Like {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>;
}

export interface SesTransportOptions {
  client: SesV2Like;
  /**
   * SES configuration set to send under.
   *
   * Not optional in practice: publishing bounce/complaint/delivery events to
   * SNS is configured ON the configuration set, so a send that omits it
   * produces no feedback at all and the whole suppression loop goes quiet.
   */
  configurationSetName?: string;
  /**
   * Message tags attached to every send, surfaced in SES event publishing and
   * CloudWatch dimensions. Keys and values must match `[A-Za-z0-9_-]{1,256}`.
   */
  defaultTags?: Record<string, string>;
}

/**
 * Sends through the SES v2 API as raw MIME.
 *
 * Raw rather than SES's `Simple` content shape because the message is already
 * composed — same bytes over SES or SMTP — and because raw is the only way to
 * carry our own headers.
 *
 * The API (not SMTP) is what makes the feedback loop exact: `SendEmail` returns
 * the SES message id, which is the same id that arrives on the SES→SNS feedback
 * event as `mail.messageId`. Under SMTP the provider never echoes the RFC
 * Message-ID back, so feedback can only be correlated by recipient.
 */
export class SesEmailTransport implements EmailTransport {
  readonly name = 'ses';

  constructor(private readonly options: SesTransportOptions) {}

  async send(message: OutboundEmail): Promise<SendResult> {
    const raw = await composeMime(message);

    const destinations = [message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];

    try {
      const response = await this.options.client.send(
        new SendEmailCommand({
          Content: { Raw: { Data: raw } },
          Destination: { ToAddresses: destinations },
          ConfigurationSetName: this.options.configurationSetName,
          EmailTags: toEmailTags(this.options.defaultTags),
        })
      );

      return { providerMessageId: response.MessageId };
    } catch (error) {
      throw new EmailTransportError(
        `SES rejected the message: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}

function toEmailTags(
  tags: Record<string, string> | undefined
): { Name: string; Value: string }[] | undefined {
  if (!tags) {
    return undefined;
  }
  const entries = Object.entries(tags);
  return entries.length > 0 ? entries.map(([Name, Value]) => ({ Name, Value })) : undefined;
}
