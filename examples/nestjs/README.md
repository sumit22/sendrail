# sendrail on NestJS

Runs with no AWS account and no database: the logging transport and the
in-memory stores.

```bash
pnpm --filter sendrail-example-nestjs build
pnpm --filter sendrail-example-nestjs start
```

```bash
curl localhost:3001/send -X POST -H 'content-type: application/json' \
     -d '{"to":"someone@example.com","subject":"Hi","html":"<p>Hello</p>"}'

curl localhost:3001/admin/email/logs
```

## This app never installs the AWS SDK

Check `examples/nestjs/package.json` — there is no `@aws-sdk/*` anywhere, and
none is installed. `EmailModule` reaches SES only through a lazy
`import('sendrail/ses')` taken when `transport.kind === 'ses'`, so a NestJS host
on SMTP or the logging transport is never made to resolve it. CI asserts this
against a real install.

## The host owns its routes

`sendrail/nest` deliberately provides no controllers — webhook and admin routes
need the host's own auth decorators and route conventions. `feedback.controller.ts`
is what a host writes, and it is short: the webhook route delegates to
`handleFeedbackWebhook`, the same framework-free function the Express router calls.

Note `main.ts` captures `rawBody` for the webhook mount, with `type: () => true`
so SNS's `Content-Type: text/plain` is not skipped. The Express router does this
for you; on NestJS you wire it yourself.
