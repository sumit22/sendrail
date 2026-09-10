import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  DeliveryLogStore,
  EmailFeedbackParserRegistry,
  EmailFeedbackProcessor,
  EmailSender,
  handleFeedbackWebhook,
} from 'sendrail';
import {
  EMAIL_DELIVERY_LOG_STORE,
  EMAIL_FEEDBACK_PROCESSOR,
  EMAIL_FEEDBACK_REGISTRY,
  EMAIL_SENDER,
} from 'sendrail/nest';

type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * A host's own controller over what the module provides.
 *
 * The package deliberately ships no NestJS controllers — webhook and admin
 * routes need the host's auth decorators and route conventions — so this is
 * what a real host writes. Note how little there is to write: the feedback
 * route delegates entirely to `handleFeedbackWebhook`, the same function the
 * Express router calls.
 */
@Controller()
export class FeedbackController {
  constructor(
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(EMAIL_DELIVERY_LOG_STORE) private readonly deliveryLog: DeliveryLogStore,
    @Inject(EMAIL_FEEDBACK_REGISTRY) private readonly registry: EmailFeedbackParserRegistry,
    @Inject(EMAIL_FEEDBACK_PROCESSOR) private readonly processor: EmailFeedbackProcessor
  ) {}

  @Post('send')
  async send(@Body() body: { to: string; subject?: string; html?: string }) {
    const outcome = await this.sender.send({
      to: body.to,
      subject: body.subject ?? 'Hello from sendrail',
      html: body.html ?? '<p>Hello from sendrail</p>',
      notificationClass: 'example',
    });

    return { status: outcome.status, skippedReason: outcome.skippedReason ?? null };
  }

  @Get('admin/email/logs')
  async logs(@Query('page') page?: string) {
    return this.deliveryLog.findPaginated({
      status: null,
      recipient: null,
      from: null,
      to: null,
      page: Number(page) || 1,
      pageSize: 25,
    });
  }

  /**
   * The same handler the Express router calls. The controller's only job is
   * turning an HTTP request into a FeedbackRequest — note `rawBody`, captured
   * in main.ts, not `body`: signature verification runs over the literal bytes,
   * and `JSON.stringify(JSON.parse(body))` is not byte-identical to them.
   */
  @Post('webhooks/notifications/:provider')
  async feedback(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest,
    @Res() res: Response
  ) {
    const { statusCode, body } = await handleFeedbackWebhook(
      { registry: this.registry, processor: this.processor },
      provider,
      {
        rawBody: req.rawBody?.toString('utf8') ?? '',
        headers: req.headers,
        query: req.query as Record<string, string | string[] | undefined>,
        clientIp: req.ip,
      }
    );

    res.status(statusCode).json(body);
  }
}
