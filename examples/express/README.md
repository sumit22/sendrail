# sendrail on Express

Runs with no AWS account and no database: the logging transport writes messages
to stdout, and the in-memory stores hold state for the process lifetime.

```bash
pnpm --filter sendrail-example-express build
pnpm --filter sendrail-example-express start
```

```bash
# send — watch the message appear on stdout
curl localhost:3000/send -X POST -H 'content-type: application/json' \
     -d '{"to":"someone@example.com","subject":"Hi","html":"<p>Hello</p>"}'

# read the delivery log back
curl localhost:3000/admin/email/logs

# the feedback webhook (404s here: no provider parser is registered, because
# this example ships no AWS credentials to verify signatures against)
curl localhost:3000/webhooks/notifications/ses -X POST -d '{"Type":"Notification"}'
```

Everything is lost on restart. A suppression list that forgets is worse than
useless — wire real stores before sending real mail. See `docs/schema.sql`.

## The two things worth copying

1. `createFeedbackRouter` is mounted **before** `express.json()`. It installs its
   own body parser to preserve the raw bytes signature verification runs over.
2. `createAdminRouter` takes a required `authorize` middleware. This example
   passes a no-op because it is a local demo; a real host puts its auth there.
