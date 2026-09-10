import { EmailFeedbackParseError } from '../domain/errors';
import { EmailLogger, NULL_LOGGER } from '../ports/logger';
import { FeedbackRequest } from './parser';
import { EmailFeedbackParserRegistry } from './parser-registry';
import { EmailFeedbackProcessor } from './processor';

export interface FeedbackHttpResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

export interface FeedbackHttpDeps {
  registry: EmailFeedbackParserRegistry;
  processor: EmailFeedbackProcessor;
  logger?: EmailLogger;
}

/**
 * The provider-feedback webhook, as a function of a request rather than a route.
 *
 * Framework-free on purpose: the status-code contract below is the part that is
 * easy to get wrong and expensive to get wrong, so it lives somewhere it can be
 * tested without standing up an HTTP server, and every host — the Express router
 * here, a NestJS controller, a Lambda handler — gets the same behaviour rather
 * than its own approximation of it.
 *
 * Always answers 200 for an authenticated, well-formed request, INCLUDING one
 * carrying nothing to act on. Providers retry — and eventually disable — an
 * endpoint that returns errors, so an SNS handshake or a deliberately-ignored
 * soft bounce must not look like a failure. The three non-200s all mean "we did
 * not accept this at all": 404 unknown slug, 401 failed authenticity, 400
 * authenticated but malformed.
 */
export async function handleFeedbackWebhook(
  deps: FeedbackHttpDeps,
  providerCode: string,
  request: FeedbackRequest
): Promise<FeedbackHttpResponse> {
  const logger = deps.logger ?? NULL_LOGGER;

  const parser = deps.registry.get(providerCode);
  if (!parser) {
    logger.warn('Email feedback webhook hit for an unregistered provider', {
      provider: providerCode,
      registered: deps.registry.registeredCodes(),
    });

    return { statusCode: 404, body: { error: 'unknown provider' } };
  }

  if (!(await parser.verify(request))) {
    // Never echo why. An attacker probing this endpoint learns nothing about
    // which check failed.
    logger.warn('Email feedback webhook rejected — failed authenticity check', {
      provider: parser.providerCode,
      clientIp: request.clientIp ?? null,
    });

    return { statusCode: 401, body: { error: 'unauthorized' } };
  }

  let result;
  try {
    result = await parser.parse(request);
  } catch (error) {
    // Only a parse failure is the caller's fault. Anything else — a store that
    // is down, a bug — must surface as a real error rather than be reported to
    // the provider as a malformed payload it should stop retrying.
    if (error instanceof EmailFeedbackParseError) {
      logger.error('Email feedback webhook payload could not be parsed', {
        provider: parser.providerCode,
        error: error.message,
      });

      return { statusCode: 400, body: { error: 'invalid payload' } };
    }
    throw error;
  }

  const applied = await deps.processor.processAll(result.events);

  return {
    statusCode: 200,
    body: { status: result.status, provider: parser.providerCode, applied },
  };
}
