import { Module } from '@nestjs/common';
import {
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
} from 'sendrail';
import { EmailModule } from 'sendrail/nest';
import { FeedbackController } from './feedback.controller';

/**
 * Wired with the logging transport and in-memory stores, so this runs with no
 * AWS account and no database.
 *
 * Note this app never installs the AWS SDK, and does not need to. `EmailModule`
 * reaches SES only through a lazy `import('sendrail/ses')` taken when
 * `transport.kind === 'ses'`, so a host on SMTP or the logging transport is
 * never made to resolve it.
 */
@Module({
  imports: [
    EmailModule.forRoot({
      transport: { kind: 'logging' },
      from: { email: 'noreply@example.com', name: 'sendrail example' },
      stores: {
        deliveryLog: new InMemoryDeliveryLogStore(),
        reputation: new InMemoryReputationStore(),
        suppression: new InMemorySuppressionStore(),
      },
      // Off because this example uses example.com addresses with no live resolver.
      validation: { mxCheckEnabled: false },
    }),
  ],
  controllers: [FeedbackController],
})
export class AppModule {}
