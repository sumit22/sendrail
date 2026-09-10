import { EmailLogger, NULL_LOGGER } from '../ports/logger';
import { EmailTransport } from '../ports/transport';
import { EmailTransportOptions } from './transport-options';
import { LoggingEmailTransport } from './logging-transport';
import { SmtpEmailTransport } from './smtp-transport';

/**
 * Build the transport a set of options describes.
 *
 * Exported rather than kept private to the Nest module because more than one
 * rail is assembled from these options, and two hosts constructing their own
 * client is two places for a regional or tagging detail to drift.
 *
 * `kind: 'ses'` is deliberately NOT handled here. Constructing it needs the AWS
 * SDK, and this module is reachable from the package root — handling it here
 * would make every consumer, including an SMTP-only one, resolve
 * `@aws-sdk/client-sesv2`. SES callers use `createSesTransport` from
 * `sendrail/ses`, which is where that dependency belongs.
 */
export function createEmailTransport(
  options: EmailTransportOptions,
  logger: EmailLogger = NULL_LOGGER
): EmailTransport {
  switch (options.kind) {
    case 'smtp':
      return new SmtpEmailTransport(options);
    case 'custom':
      return options.transport;
    case 'logging':
      return new LoggingEmailTransport(logger);
    case 'ses':
      throw new Error(
        "The SES transport is not built by the core factory. Import { createSesTransport } from 'sendrail/ses' " +
          'and pass it as { kind: "custom", transport }, or use EmailModule from sendrail/nest, which wires it for you.'
      );
  }
}
