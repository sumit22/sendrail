/**
 * sendrail on Express, with nothing external: the logging transport writes
 * messages to stdout and the in-memory stores hold state for the process
 * lifetime. No AWS account, no database.
 *
 *   pnpm --filter sendrail-example-express build
 *   pnpm --filter sendrail-example-express start
 *
 *   curl localhost:3000/send -X POST -H 'content-type: application/json' \
 *        -d '{"to":"someone@example.com","subject":"Hi","html":"<p>Hello</p>"}'
 *   curl localhost:3000/admin/email/logs
 *   curl localhost:3000/webhooks/notifications/ses -X POST -d '{"Type":"Notification"}'
 */
import express from 'express';
import {
  EmailAddressValidator,
  EmailFeedbackParserRegistry,
  EmailFeedbackProcessor,
  EmailSender,
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
  LoggingEmailTransport,
  type EmailLogger,
} from 'sendrail';
import { createAdminRouter, createFeedbackRouter } from 'sendrail/express';

const logger: EmailLogger = {
  log: (message, context) => console.log(message, context ?? ''),
  warn: (message, context) => console.warn(message, context ?? ''),
  error: (message, context) => console.error(message, context ?? ''),
};

const stores = {
  deliveryLog: new InMemoryDeliveryLogStore(),
  reputation: new InMemoryReputationStore(),
  suppression: new InMemorySuppressionStore(),
};

const sender = new EmailSender({
  transport: new LoggingEmailTransport(logger),
  // Off because this example uses example.com addresses with no live resolver.
  // On everywhere mail actually goes out.
  validator: new EmailAddressValidator({ mxCheckEnabled: false }),
  suppression: stores.suppression,
  deliveryLog: stores.deliveryLog,
  reputation: stores.reputation,
  defaultFrom: { email: 'noreply@example.com', name: 'sendrail example' },
  logger,
});

const app = express();

// The feedback router MUST be mounted before any global express.json(): it
// installs its own parser to keep the raw bytes that signature verification
// needs, and to accept SNS's `Content-Type: text/plain`, which the default
// express.json() matcher skips entirely. See createFeedbackRouter's docblock.
app.use(
  '/webhooks/notifications',
  createFeedbackRouter({
    // No parser is registered: this example ships no AWS credentials, so there
    // is nothing to verify against and the endpoint answers 404 for every slug.
    // Register SesFeedbackParser from 'sendrail/ses' in a real deployment and
    // it starts working with no other change.
    registry: new EmailFeedbackParserRegistry([]),
    processor: new EmailFeedbackProcessor({ ...stores, logger }),
    logger,
  })
);

app.use(express.json());

app.use(
  '/admin/email',
  createAdminRouter({
    stores,
    ses: null,
    // A real host puts its own auth middleware here. It is a required option
    // precisely so this decision cannot be skipped by accident.
    authorize: (_req, _res, next) => next(),
  })
);

app.post('/send', (req, res) => {
  void sender
    .send({
      to: req.body?.to,
      subject: req.body?.subject ?? 'Hello from sendrail',
      html: req.body?.html ?? '<p>Hello from sendrail</p>',
      notificationClass: 'example',
    })
    .then((outcome) => {
      res.json({ status: outcome.status, skippedReason: outcome.skippedReason ?? null });
    });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`sendrail express example on http://localhost:${port}`));
