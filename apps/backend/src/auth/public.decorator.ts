import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Exempts a route (or a whole controller) from the global JwtAuthGuard.
 *
 * Authorization used to be OPT-IN: every controller carried its own `@UseGuards(JwtAuthGuard)`,
 * and the cost of forgetting one was an unauthenticated endpoint that looked exactly like a
 * working one. This inverts the default — the guard is global, and what is annotated is now the
 * EXCEPTION, which is the thing a reviewer should have to see and question.
 *
 * Two legitimate uses:
 *  - genuinely public routes (health, register/login, the email-verification flow), and
 *  - routes with their OWN authentication that a bearer JWT would wrongly pre-empt: the payment
 *    webhook (HMAC over raw bytes), the agent LLM proxy (agent-audience token, which JwtAuthGuard
 *    deliberately refuses), automation (API key), and the admin sweep (admin token).
 *
 * `@Public()` on a route with no guard of its own and no HMAC is a finding, not a convenience.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
