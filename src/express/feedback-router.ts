import express, { Router } from 'express';
import type { IncomingMessage } from 'node:http';
import { handleFeedbackWebhook } from '../feedback/http-handler';
import { EmailFeedbackParserRegistry } from '../feedback/parser-registry';
import { EmailFeedbackProcessor } from '../feedback/processor';
import { EmailLogger, NULL_LOGGER } from '../ports/logger';

export interface FeedbackRouterOptions {
  registry: EmailFeedbackParserRegistry;
  processor: EmailFeedbackProcessor;
  logger?: EmailLogger;
  /** Body size cap. Feedback payloads are small; the default is deliberately tight. */
  bodyLimit?: string;
}

/** The request as body-parser hands it over, plus the field we stash on it. */
type RawBodyCarrier = IncomingMessage & { rawBody?: Buffer };

/**
 * Mountable provider-feedback webhook — `POST <mount>/:provider`.
 *
 * ## Why this router owns its body parser
 *
 * Signature verification runs over the literal bytes the provider signed, and
 * `JSON.stringify(JSON.parse(body))` is not byte-identical to them.
 * `express.json()` discards those bytes, so a host that parses globally has
 * already destroyed the evidence before any handler runs.
 *
 * Worse, SNS posts JSON under `Content-Type: text/plain; charset=UTF-8`, which
 * `express.json()`'s default matcher skips entirely — leaving neither `body` nor
 * `rawBody`. The failure mode is silent and production-only: every genuine
 * bounce 401s while the endpoint looks healthy, and the suppression list quietly
 * stays empty while reputation degrades.
 *
 * So the parser lives here, with `type: () => true`, and mounting the router is
 * what makes it correct. There is no step for a host to omit.
 *
 * Mount it BEFORE any global `express.json()`. If an upstream parser has already
 * consumed the body, this router answers 500 rather than falling back to a
 * re-serialised payload — a verification that cannot be meaningful should fail
 * loudly, not appear to work.
 *
 * The route is deliberately unauthenticated: providers sign their payloads, they
 * do not carry a token. Authenticity is the parser's job.
 */
export function createFeedbackRouter(options: FeedbackRouterOptions): Router {
  const logger = options.logger ?? NULL_LOGGER;
  const router = Router();

  router.use(
    express.json({
      limit: options.bodyLimit ?? '1mb',
      type: () => true,
      verify: (req: RawBodyCarrier, _res, buf: Buffer) => {
        req.rawBody = buf;
      },
    })
  );

  router.post('/:provider', (req, res, next) => {
    const rawBody = (req as unknown as RawBodyCarrier).rawBody;

    if (rawBody === undefined) {
      logger.error(
        'Email feedback webhook cannot verify signatures: the request body was already consumed ' +
          'by an upstream parser. Mount createFeedbackRouter() before any global express.json().'
      );

      res.status(500).json({ error: 'raw body unavailable' });
      return;
    }

    handleFeedbackWebhook(
      { registry: options.registry, processor: options.processor, logger },
      req.params.provider,
      {
        rawBody: rawBody.toString('utf8'),
        headers: req.headers,
        query: req.query as Record<string, string | string[] | undefined>,
        clientIp: req.ip,
      }
    )
      .then(({ statusCode, body }) => {
        res.status(statusCode).json(body);
      })
      .catch(next);
  });

  return router;
}
