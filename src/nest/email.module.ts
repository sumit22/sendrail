import { DynamicModule, Module, ModuleMetadata, Provider } from '@nestjs/common';
import { EmailFeedbackParserRegistry } from '../feedback/parser-registry';
import { EmailFeedbackProcessor } from '../feedback/processor';
import { SesFeedbackParser } from '../feedback/ses/ses-feedback-parser';
import { SnsSignatureVerifier } from '../feedback/ses/sns-signature-verifier';
import { DeliveryLogPruner } from '../maintenance/delivery-log-pruner';
import { EmailLogger, NULL_LOGGER } from '../ports/logger';
import { EmailTransport } from '../ports/transport';
import { EmailSender } from '../sending/email-sender';
import { createEmailTransport } from '../transport/create-transport';
import { EmailAddressValidator } from '../validation/email-address-validator';
import { EmailModuleOptions } from './email-module-options';
import {
  EMAIL_ADDRESS_VALIDATOR,
  EMAIL_DELIVERY_LOG_PRUNER,
  EMAIL_DELIVERY_LOG_STORE,
  EMAIL_FEEDBACK_PROCESSOR,
  EMAIL_FEEDBACK_REGISTRY,
  EMAIL_MODULE_OPTIONS,
  EMAIL_REPUTATION_STORE,
  EMAIL_SENDER,
  EMAIL_SUPPRESSION_STORE,
  EMAIL_TRANSPORT,
  SES_MANAGEMENT_SERVICE,
} from './tokens';

export interface EmailModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: any[];
  useFactory: (...args: any[]) => Promise<EmailModuleOptions> | EmailModuleOptions;
}

/**
 * Wires the whole email rail: transport, pre-send validation, the send path,
 * the provider-feedback loop, and the SES account-health reader.
 *
 * The module deliberately provides no controllers. Webhook and admin routes
 * need the host's own auth decorators and route conventions, so the host owns
 * them and injects what it needs from here — that is what keeps this package
 * usable in an app whose guards look nothing like ours.
 *
 * Storage is the host's too: it passes the three stores in through the options.
 * The package never assumes an ORM, a schema, or even a database.
 */
@Module({})
export class EmailModule {
  static forRoot(options: EmailModuleOptions): DynamicModule {
    return this.build([{ provide: EMAIL_MODULE_OPTIONS, useValue: options }]);
  }

  static forRootAsync(options: EmailModuleAsyncOptions): DynamicModule {
    return this.build(
      [
        {
          provide: EMAIL_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ],
      options.imports
    );
  }

  private static build(
    optionsProviders: Provider[],
    imports: ModuleMetadata['imports'] = []
  ): DynamicModule {
    const providers: Provider[] = [
      ...optionsProviders,

      {
        provide: EMAIL_DELIVERY_LOG_STORE,
        useFactory: (options: EmailModuleOptions) => options.stores.deliveryLog,
        inject: [EMAIL_MODULE_OPTIONS],
      },
      {
        provide: EMAIL_REPUTATION_STORE,
        useFactory: (options: EmailModuleOptions) => options.stores.reputation,
        inject: [EMAIL_MODULE_OPTIONS],
      },
      {
        provide: EMAIL_SUPPRESSION_STORE,
        useFactory: (options: EmailModuleOptions) => options.stores.suppression,
        inject: [EMAIL_MODULE_OPTIONS],
      },

      {
        provide: EMAIL_TRANSPORT,
        useFactory: (options: EmailModuleOptions) => buildTransport(options),
        inject: [EMAIL_MODULE_OPTIONS],
      },
      {
        provide: EMAIL_ADDRESS_VALIDATOR,
        useFactory: (options: EmailModuleOptions) =>
          new EmailAddressValidator({
            mxCheckEnabled: options.validation?.mxCheckEnabled,
            extraDisposableDomains: options.validation?.extraDisposableDomains,
          }),
        inject: [EMAIL_MODULE_OPTIONS],
      },

      {
        provide: EMAIL_SENDER,
        useFactory: (
          options: EmailModuleOptions,
          transport: EmailTransport,
          validator: EmailAddressValidator
        ) =>
          new EmailSender({
            transport,
            validator,
            suppression: options.stores.suppression,
            deliveryLog: options.stores.deliveryLog,
            reputation: options.stores.reputation,
            defaultFrom: options.from,
            logger: logger(options),
          }),
        inject: [EMAIL_MODULE_OPTIONS, EMAIL_TRANSPORT, EMAIL_ADDRESS_VALIDATOR],
      },

      {
        provide: EMAIL_FEEDBACK_REGISTRY,
        useFactory: (options: EmailModuleOptions) =>
          new EmailFeedbackParserRegistry([
            new SesFeedbackParser({
              signatureVerifier: new SnsSignatureVerifier({
                enabled: options.feedback?.snsSignatureVerification ?? true,
                logger: logger(options),
              }),
              webhookSecret: options.feedback?.webhookSecret,
              allowedTopicArns: options.feedback?.allowedTopicArns,
              logger: logger(options),
            }),
          ]),
        inject: [EMAIL_MODULE_OPTIONS],
      },
      {
        provide: EMAIL_FEEDBACK_PROCESSOR,
        useFactory: (options: EmailModuleOptions) =>
          new EmailFeedbackProcessor({
            suppression: options.stores.suppression,
            reputation: options.stores.reputation,
            deliveryLog: options.stores.deliveryLog,
            logger: logger(options),
          }),
        inject: [EMAIL_MODULE_OPTIONS],
      },

      {
        provide: EMAIL_DELIVERY_LOG_PRUNER,
        useFactory: (options: EmailModuleOptions) =>
          new DeliveryLogPruner(
            options.stores.deliveryLog,
            options.retention?.deliveryLogDays,
            logger(options)
          ),
        inject: [EMAIL_MODULE_OPTIONS],
      },

      {
        provide: SES_MANAGEMENT_SERVICE,
        useFactory: async (options: EmailModuleOptions) => {
          // Only meaningful when we are actually sending on SES; on any other
          // transport there is no account to report health for.
          if (options.transport.kind !== 'ses') {
            return null;
          }
          const { createSesManagementService } = await import('sendrail/ses');
          return createSesManagementService(options.transport.region);
        },
        inject: [EMAIL_MODULE_OPTIONS],
      },
    ];

    return {
      module: EmailModule,
      imports,
      providers,
      exports: [
        EMAIL_MODULE_OPTIONS,
        EMAIL_SENDER,
        EMAIL_TRANSPORT,
        EMAIL_ADDRESS_VALIDATOR,
        EMAIL_DELIVERY_LOG_STORE,
        EMAIL_REPUTATION_STORE,
        EMAIL_SUPPRESSION_STORE,
        EMAIL_FEEDBACK_REGISTRY,
        EMAIL_FEEDBACK_PROCESSOR,
        EMAIL_DELIVERY_LOG_PRUNER,
        SES_MANAGEMENT_SERVICE,
      ],
    };
  }
}

/**
 * Every non-SES transport is built synchronously by the core factory. SES is
 * loaded through a self-referencing dynamic import so that a host on SMTP or the
 * logging transport never resolves the AWS SDK at all — this module is reachable
 * from `sendrail/nest`, so a static import would make AWS a hard requirement of
 * using NestJS with this package.
 */
async function buildTransport(options: EmailModuleOptions): Promise<EmailTransport> {
  if (options.transport.kind === 'ses') {
    const { createSesTransport } = await import('sendrail/ses');
    return createSesTransport(options.transport);
  }

  return createEmailTransport(options.transport, logger(options));
}

function logger(options: EmailModuleOptions): EmailLogger {
  return options.logger ?? NULL_LOGGER;
}
