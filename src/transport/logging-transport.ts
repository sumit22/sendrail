import { EmailLogger, NULL_LOGGER } from '../ports/logger';
import { EmailTransport, OutboundEmail, SendResult } from '../ports/transport';

/**
 * Writes the message to the log instead of sending it.
 *
 * The default when nothing is configured, so a host that has not wired SES yet
 * still exercises the whole path — validation, suppression, delivery log,
 * reputation — rather than silently doing nothing.
 */
export class LoggingEmailTransport implements EmailTransport {
  readonly name = 'logging';

  constructor(private readonly logger: EmailLogger = NULL_LOGGER) {}

  async send(message: OutboundEmail): Promise<SendResult> {
    this.logger.log(`[EMAIL-STUB] To: ${message.to} | Subject: ${message.subject}`, {
      from: message.from.email,
      text: message.text,
    });

    return {};
  }
}
