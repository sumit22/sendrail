import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { EmailFeedbackParserRegistry } from '../feedback/parser-registry';
import { EmailFeedbackProcessor } from '../feedback/processor';
import { DeliveryLogPruner } from '../maintenance/delivery-log-pruner';
import {
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
} from '../memory/in-memory-stores';
import { EmailTransport } from '../ports/transport';
import { EmailSender } from '../sending/email-sender';
import { LoggingEmailTransport } from '../transport/logging-transport';
import { SesEmailTransport } from '../transport/ses-transport';
import { SmtpEmailTransport } from '../transport/smtp-transport';
import { EmailModuleOptions, EmailTransportOptions } from './email-module-options';
import { EmailModule } from './email.module';
import {
  EMAIL_DELIVERY_LOG_PRUNER,
  EMAIL_DELIVERY_LOG_STORE,
  EMAIL_FEEDBACK_PROCESSOR,
  EMAIL_FEEDBACK_REGISTRY,
  EMAIL_REPUTATION_STORE,
  EMAIL_SENDER,
  EMAIL_SUPPRESSION_STORE,
  EMAIL_TRANSPORT,
  SES_MANAGEMENT_SERVICE,
} from './tokens';

const stores = {
  deliveryLog: new InMemoryDeliveryLogStore(),
  reputation: new InMemoryReputationStore(),
  suppression: new InMemorySuppressionStore(),
};

function options(transport: EmailTransportOptions): EmailModuleOptions {
  return { transport, from: { email: 'noreply@example.com', name: 'Example' }, stores };
}

async function compile(module: ReturnType<typeof EmailModule.forRoot>) {
  return (await Test.createTestingModule({ imports: [module] }).compile()).createNestApplication();
}

describe('EmailModule.forRoot', () => {
  it('provides a sender wired to the configured transport', async () => {
    const app = await compile(EmailModule.forRoot(options({ kind: 'logging' })));

    expect(app.get(EMAIL_SENDER)).toBeInstanceOf(EmailSender);
    expect(app.get(EMAIL_TRANSPORT)).toBeInstanceOf(LoggingEmailTransport);
  });

  it('provides the feedback loop and the pruner', async () => {
    const app = await compile(EmailModule.forRoot(options({ kind: 'logging' })));

    expect(app.get(EMAIL_FEEDBACK_REGISTRY)).toBeInstanceOf(EmailFeedbackParserRegistry);
    expect(app.get(EMAIL_FEEDBACK_PROCESSOR)).toBeInstanceOf(EmailFeedbackProcessor);
    expect(app.get(EMAIL_DELIVERY_LOG_PRUNER)).toBeInstanceOf(DeliveryLogPruner);
  });

  it('registers the SES adapter under its stable slug', async () => {
    // The slug is baked into the URL configured at AWS, so renaming it silently
    // stops feedback arriving.
    const app = await compile(EmailModule.forRoot(options({ kind: 'logging' })));

    expect(
      (app.get(EMAIL_FEEDBACK_REGISTRY) as EmailFeedbackParserRegistry).registeredCodes()
    ).toEqual(['ses']);
  });

  it('exposes the host-supplied stores rather than copies of them', async () => {
    const app = await compile(EmailModule.forRoot(options({ kind: 'logging' })));

    expect(app.get(EMAIL_DELIVERY_LOG_STORE)).toBe(stores.deliveryLog);
    expect(app.get(EMAIL_REPUTATION_STORE)).toBe(stores.reputation);
    expect(app.get(EMAIL_SUPPRESSION_STORE)).toBe(stores.suppression);
  });

  it('builds an SES transport and its management service', async () => {
    const app = await compile(EmailModule.forRoot(options({ kind: 'ses', region: 'ap-south-1' })));

    expect(app.get(EMAIL_TRANSPORT)).toBeInstanceOf(SesEmailTransport);
    expect(app.get(SES_MANAGEMENT_SERVICE)).not.toBeNull();
  });

  it('has no SES management service on a non-SES transport', async () => {
    // There is no account to report health for — that is an answer, not an error.
    const app = await compile(EmailModule.forRoot(options({ kind: 'logging' })));

    expect(app.get(SES_MANAGEMENT_SERVICE)).toBeNull();
  });

  it('builds an SMTP transport', async () => {
    const app = await compile(
      EmailModule.forRoot(options({ kind: 'smtp', host: 'mailpit', port: 1025 }))
    );

    expect(app.get(EMAIL_TRANSPORT)).toBeInstanceOf(SmtpEmailTransport);
  });

  it('uses a custom transport as-is', async () => {
    const custom: EmailTransport = { name: 'custom', send: async () => ({}) };
    const app = await compile(EmailModule.forRoot(options({ kind: 'custom', transport: custom })));

    expect(app.get(EMAIL_TRANSPORT)).toBe(custom);
  });
});

describe('EmailModule.forRootAsync', () => {
  it('resolves options from an injected factory', async () => {
    const app = await compile(
      EmailModule.forRootAsync({
        useFactory: async () => options({ kind: 'logging' }),
      })
    );

    expect(app.get(EMAIL_SENDER)).toBeInstanceOf(EmailSender);
  });

  it('sends end to end through the wired sender', async () => {
    const sent: string[] = [];
    const custom: EmailTransport = {
      name: 'capture',
      send: async (message) => {
        sent.push(message.to);
        return { providerMessageId: 'id-1' };
      },
    };

    const app = await compile(
      EmailModule.forRoot({
        ...options({ kind: 'custom', transport: custom }),
        validation: { mxCheckEnabled: false },
      })
    );

    await (app.get(EMAIL_SENDER) as EmailSender).send({
      to: 'guest@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
    });

    expect(sent).toEqual(['guest@example.com']);
  });
});
