import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { EmailFeedbackParser } from '../feedback/parser';
import { EmailFeedbackParserRegistry } from '../feedback/parser-registry';
import { EmailFeedbackProcessor } from '../feedback/processor';
import {
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
} from '../memory/in-memory-stores';
import { createFeedbackRouter } from './feedback-router';

/** Records the exact bytes handed to verify(), so we can assert they survived. */
function recordingParser(seen: { rawBody?: string }): EmailFeedbackParser {
  return {
    providerCode: 'ses',
    verify: vi.fn(async (req) => {
      seen.rawBody = req.rawBody;
      return true;
    }),
    parse: vi.fn().mockResolvedValue({ events: [], status: 'ignored' }),
  } as unknown as EmailFeedbackParser;
}

function processor() {
  return new EmailFeedbackProcessor({
    suppression: new InMemorySuppressionStore(),
    reputation: new InMemoryReputationStore(),
    deliveryLog: new InMemoryDeliveryLogStore(),
  });
}

function appWith(parser: EmailFeedbackParser, mountGlobalJson = false) {
  const app = express();
  if (mountGlobalJson) {
    app.use(express.json());
  }
  app.use(
    '/webhooks',
    createFeedbackRouter({
      registry: new EmailFeedbackParserRegistry([parser]),
      processor: processor(),
    })
  );
  return app;
}

// SNS posts JSON under `Content-Type: text/plain; charset=UTF-8`. The default
// express.json() matcher skips that, so a host with a global json() mounted
// first leaves neither body nor rawBody — every genuine bounce 401s while a
// spoofed payload is indistinguishable. The router's own parser accepts any
// content type, which is what makes this survivable.
const SNS_BODY = JSON.stringify({ Type: 'Notification', TopicArn: 'arn:aws:sns:x', Message: '{}' });

describe('createFeedbackRouter', () => {
  it('hands the parser the exact bytes that were posted', async () => {
    const seen: { rawBody?: string } = {};

    await request(appWith(recordingParser(seen)))
      .post('/webhooks/ses')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .send(SNS_BODY)
      .expect(200);

    expect(seen.rawBody).toBe(SNS_BODY);
  });

  it('still captures the raw body when mounted after a global express.json()', async () => {
    const seen: { rawBody?: string } = {};

    await request(appWith(recordingParser(seen), true))
      .post('/webhooks/ses')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .send(SNS_BODY)
      .expect(200);

    expect(seen.rawBody).toBe(SNS_BODY);
  });

  it('captures the raw body for an application/json post too', async () => {
    const seen: { rawBody?: string } = {};

    await request(appWith(recordingParser(seen)))
      .post('/webhooks/ses')
      .set('Content-Type', 'application/json')
      .send(SNS_BODY)
      .expect(200);

    expect(seen.rawBody).toBe(SNS_BODY);
  });

  it('fails loudly rather than guessing when an upstream parser already consumed the body', async () => {
    const seen: { rawBody?: string } = {};
    const app = express();
    // A host that parses every content type before our router sees it. There is
    // no honest recovery: re-serialising the parsed object is not byte-identical
    // to what was signed, so verification would be meaningless rather than merely
    // failing.
    app.use(express.json({ type: () => true }));
    app.use(
      '/webhooks',
      createFeedbackRouter({
        registry: new EmailFeedbackParserRegistry([recordingParser(seen)]),
        processor: processor(),
      })
    );

    const response = await request(app)
      .post('/webhooks/ses')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .send(SNS_BODY);

    expect(response.status).toBe(500);
    expect(seen.rawBody).toBeUndefined();
  });

  it('404s an unknown provider slug', async () => {
    await request(appWith(recordingParser({})))
      .post('/webhooks/sendgrid')
      .send(SNS_BODY)
      .expect(404);
  });

  it('401s a request the parser will not authenticate', async () => {
    const parser = {
      providerCode: 'ses',
      verify: vi.fn().mockResolvedValue(false),
      parse: vi.fn(),
    } as unknown as EmailFeedbackParser;

    await request(appWith(parser)).post('/webhooks/ses').send(SNS_BODY).expect(401);
  });

  it('passes the query string through for the shared-secret fallback', async () => {
    const seen: { query?: unknown } = {};
    const parser = {
      providerCode: 'ses',
      verify: vi.fn(async (req) => {
        seen.query = req.query;
        return true;
      }),
      parse: vi.fn().mockResolvedValue({ events: [], status: 'ignored' }),
    } as unknown as EmailFeedbackParser;

    await request(appWith(parser)).post('/webhooks/ses?token=shh').send(SNS_BODY).expect(200);

    expect(seen.query).toMatchObject({ token: 'shh' });
  });
});
