import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

import { err } from './api-response';

/**
 * Extract a single human-readable message from an `HttpException` body. Nest's built-in exceptions
 * carry `{ statusCode, message, error }`, and the global `ValidationPipe` puts EVERY failed
 * constraint in `message` as an array — joined here so no detail is dropped on the way out.
 */
function messageOf(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') {
    return body;
  }
  const message = (body as { message?: unknown }).message;
  if (typeof message === 'string') {
    return message;
  }
  if (Array.isArray(message)) {
    return message.join('; ');
  }
  return exception.message;
}

/**
 * Global exception filter: renders EVERY error in the same `{ code, data, msg }` envelope the
 * successes use (see api-response.ts).
 *
 * Without it Nest answers errors in its own default shape while every controller answers in the
 * documented envelope, so a client has two contracts to parse and cannot branch on `code` at all —
 * and a validation failure does not even match the single-message shape, since `message` is an
 * array there. The HTTP status is preserved untouched; only the body is normalised.
 *
 * Anything that is NOT an HttpException is a bug or an infrastructure failure: it is logged with
 * its stack and reported as a generic 500, because the message of an unexpected throw is not part
 * of any contract and can carry internals (SQL, paths, credentials in a connection string).
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(err(messageOf(exception)));
      return;
    }
    this.logger.error(
      exception instanceof Error ? exception.message : String(exception),
      exception instanceof Error ? exception.stack : undefined,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(err('internal server error'));
  }
}
