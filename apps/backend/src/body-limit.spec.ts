import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { Controller, Module, Post, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { BODY_LIMIT, WEBHOOK_BODY_LIMIT, configureBodyLimit } from './body-limit';

/**
 * The two ceilings this file draws, exercised over real HTTP.
 *
 * Encrypted profile blobs are pushed as base64 and need a very large limit; the payment callback is
 * the one unauthenticated body-driven route and needs a small one. Both come from the same call in
 * `main.ts`, so a regression in either shows up here rather than in production.
 */
@Controller()
class EchoController {
  @Post('billing/webhook')
  webhook(@Req() req: { rawBody?: Buffer; body?: unknown }): { bytes: number; parsed: boolean } {
    return { bytes: req.rawBody?.length ?? 0, parsed: typeof req.body === 'object' };
  }

  @Post('profiles/sync')
  sync(@Req() req: { body?: { blob?: string } }): { bytes: number } {
    return { bytes: req.body?.blob?.length ?? 0 };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

let app: NestExpressApplication;

function bytes(limit: string): number {
  return Number(limit.replace('kb', '')) * 1024 || Number(limit.replace('mb', '')) * 1024 * 1024;
}

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [EchoModule] }).compile();
  // Mirrors the production bootstrap: Nest's own parser off, ours on, raw bytes retained.
  app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    rawBody: true,
  });
  configureBodyLimit(app);
  await app.init();
});

after(async () => {
  await app?.close();
});

test('the webhook keeps its raw bytes and is capped far below the blob limit', async () => {
  const payload = { payment_id: '1', payment_status: 'finished' };
  const ok = await request(app.getHttpServer()).post('/billing/webhook').send(payload);
  assert.equal(ok.status, 201);
  // The signature is an HMAC over the bytes as sent, so losing them would reject every callback.
  assert.equal(ok.body.bytes, Buffer.byteLength(JSON.stringify(payload)));

  const oversized = await request(app.getHttpServer())
    .post('/billing/webhook')
    .send({ payment_id: 'x'.repeat(bytes(WEBHOOK_BODY_LIMIT) + 1024) });
  assert.equal(
    oversized.status,
    413,
    'an unauthenticated caller cannot hand us a megabyte to sort',
  );
});

test('a form-encoded webhook body gets the same cap, not the blob one', async () => {
  // Whichever content type is chosen has to hit the same ceiling, or the cap is a suggestion.
  const oversized = await request(app.getHttpServer())
    .post('/billing/webhook')
    .type('form')
    .send(`payment_id=${'x'.repeat(bytes(WEBHOOK_BODY_LIMIT) + 1024)}`);
  assert.equal(oversized.status, 413);
});

test('an ordinary route still accepts a blob far past the webhook cap', async () => {
  const blob = 'A'.repeat(bytes(WEBHOOK_BODY_LIMIT) * 4);
  const res = await request(app.getHttpServer()).post('/profiles/sync').send({ blob });
  assert.equal(res.status, 201);
  assert.equal(res.body.bytes, blob.length);
  assert.ok(
    bytes(BODY_LIMIT) > bytes(WEBHOOK_BODY_LIMIT),
    'the blob limit is the larger of the two',
  );
});
