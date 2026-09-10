/**
 * sendrail on NestJS, with nothing external: the logging transport and the
 * in-memory stores. No AWS account, no database — and no AWS SDK installed,
 * which is the point.
 *
 *   pnpm --filter sendrail-example-nestjs build
 *   pnpm --filter sendrail-example-nestjs start
 *
 *   curl localhost:3001/send -X POST -H 'content-type: application/json' \
 *        -d '{"to":"someone@example.com","subject":"Hi","html":"<p>Hello</p>"}'
 *   curl localhost:3001/admin/email/logs
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import type { IncomingMessage } from 'node:http';
import { AppModule } from './app.module';

type RawBodyCarrier = IncomingMessage & { rawBody?: Buffer };

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Capture the raw body for webhook routes BEFORE the general parser claims
  // the path. Express matches mounts in registration order, so this must come
  // first. `type: () => true` is required because SNS posts JSON under
  // `Content-Type: text/plain`, which the default matcher skips — leaving
  // neither body nor rawBody, and every genuine bounce failing its signature
  // check while the endpoint looks healthy.
  //
  // The Express router in `sendrail/express` does all of this for you; a
  // NestJS host has to wire it, which is what this shows.
  app.use(
    '/webhooks/notifications',
    json({
      limit: '1mb',
      type: () => true,
      verify: (req: RawBodyCarrier, _res, buf: Buffer) => {
        req.rawBody = buf;
      },
    })
  );

  app.use(json());

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`sendrail nestjs example on http://localhost:${port}`);
}

void bootstrap();
