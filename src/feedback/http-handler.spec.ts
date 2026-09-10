import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailFeedbackType } from '../domain/email-feedback-type';
import { EmailFeedbackParseError } from '../domain/errors';
import {
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
} from '../memory/in-memory-stores';
import { handleFeedbackWebhook } from './http-handler';
import { EmailFeedbackParser, FeedbackRequest } from './parser';
import { EmailFeedbackParserRegistry } from './parser-registry';
import { EmailFeedbackProcessor } from './processor';

const request: FeedbackRequest = { rawBody: '{}', headers: {}, query: {} };

function stubParser(overrides: Partial<EmailFeedbackParser> = {}): EmailFeedbackParser {
  return {
    providerCode: 'ses',
    verify: vi.fn().mockResolvedValue(true),
    parse: vi.fn().mockResolvedValue({ events: [], status: 'ignored' }),
    ...overrides,
  } as EmailFeedbackParser;
}

describe('handleFeedbackWebhook', () => {
  let processor: EmailFeedbackProcessor;

  beforeEach(() => {
    processor = new EmailFeedbackProcessor({
      suppression: new InMemorySuppressionStore(),
      reputation: new InMemoryReputationStore(),
      deliveryLog: new InMemoryDeliveryLogStore(),
    });
  });

  function deps(parser?: EmailFeedbackParser) {
    return {
      registry: new EmailFeedbackParserRegistry(parser ? [parser] : []),
      processor,
    };
  }

  it('404s an unregistered provider slug', async () => {
    const response = await handleFeedbackWebhook(deps(), 'nope', request);

    expect(response.statusCode).toBe(404);
  });

  it('401s when the parser cannot authenticate the request', async () => {
    const parser = stubParser({ verify: vi.fn().mockResolvedValue(false) });

    const response = await handleFeedbackWebhook(deps(parser), 'ses', request);

    expect(response.statusCode).toBe(401);
  });

  it('does not reveal which authenticity check failed', async () => {
    const parser = stubParser({ verify: vi.fn().mockResolvedValue(false) });

    const response = await handleFeedbackWebhook(deps(parser), 'ses', request);

    expect(JSON.stringify(response.body)).not.toMatch(/signature|topic|secret|token/i);
  });

  it('never calls parse when verification failed', async () => {
    const parser = stubParser({ verify: vi.fn().mockResolvedValue(false) });

    await handleFeedbackWebhook(deps(parser), 'ses', request);

    expect(parser.parse).not.toHaveBeenCalled();
  });

  it('400s an authenticated but malformed payload', async () => {
    const parser = stubParser({
      parse: vi.fn().mockRejectedValue(new EmailFeedbackParseError('Invalid SNS envelope.')),
    });

    const response = await handleFeedbackWebhook(deps(parser), 'ses', request);

    expect(response.statusCode).toBe(400);
  });

  it('rethrows a non-parse error rather than reporting it as a bad payload', async () => {
    const parser = stubParser({ parse: vi.fn().mockRejectedValue(new Error('store is down')) });

    await expect(handleFeedbackWebhook(deps(parser), 'ses', request)).rejects.toThrow(
      'store is down'
    );
  });

  // Providers retry, then disable, an endpoint that errors. A handshake or an
  // ignored soft bounce is a successful request that happens to carry nothing.
  it('200s an authenticated request carrying no events', async () => {
    const parser = stubParser({
      parse: vi.fn().mockResolvedValue({ events: [], status: 'soft_bounce_ignored' }),
    });

    const response = await handleFeedbackWebhook(deps(parser), 'ses', request);

    expect(response).toEqual({
      statusCode: 200,
      body: { status: 'soft_bounce_ignored', provider: 'ses', applied: 0 },
    });
  });

  it('applies events and reports how many landed', async () => {
    const parser = stubParser({
      parse: vi.fn().mockResolvedValue({
        events: [
          {
            type: EmailFeedbackType.BOUNCED,
            recipientEmail: 'dead@example.com',
            reason: 'Permanent/General',
          },
        ],
        status: 'bounce_recorded',
      }),
    });

    const response = await handleFeedbackWebhook(deps(parser), 'ses', request);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'bounce_recorded', applied: 1 });
  });

  it('resolves the provider slug case-insensitively', async () => {
    const response = await handleFeedbackWebhook(deps(stubParser()), 'SES', request);

    expect(response.statusCode).toBe(200);
  });
});
