import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from './auth.module';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Authenticate-by-default, pinned.
 *
 * The regression this spec exists to catch is not a broken guard but a FORGOTTEN one: before the
 * global APP_GUARD, authorization was opt-in per controller, and a new controller with no
 * annotation shipped as an open endpoint that looked healthy. So the controller under test here is
 * deliberately BARE — no @UseGuards, no @Public — because that is exactly the shape of the
 * mistake. If it 401s, the default protects; if it ever answers 200, the inversion has been
 * undone and every future unannotated route is exposed with it.
 */
@Controller('guard-probe')
class BareProbeController {
  @Get()
  read(): { leaked: boolean } {
    return { leaked: true };
  }
}

let app: INestApplication;

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.SMTP_HOST = '';
  process.env.NODE_ENV = 'test';

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      MailModule,
      PrismaModule,
      AuthModule,
    ],
    controllers: [BareProbeController],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

after(async () => {
  await app?.close();
});

test('a route with no annotation at all requires authentication', async () => {
  const bare = await request(app.getHttpServer()).get('/guard-probe');
  assert.equal(bare.status, 401, 'an unannotated route must be closed by default');

  const junk = await request(app.getHttpServer())
    .get('/guard-probe')
    .set('Authorization', 'Bearer not-a-token');
  assert.equal(junk.status, 401, 'a garbage token must not open it either');
});

test('the public surface is exactly the reviewed allowlist', async () => {
  // Reflection over the live route table, not a source grep: this sees precisely what the guard
  // sees. Every entry here is either genuinely public (register/login/verify, health) or a route
  // whose OWN guard is the authority (webhook HMAC, agent token, API key, admin token). Adding a
  // route to this list is a security decision; this spec makes it an explicit diff.
  const expected = new Set([
    'AuthController.register',
    'AuthController.login',
    'AuthController.desktopExchange',
    'AuthController.verifyEmail',
    'AuthController.resendVerification',
    'HealthController.*',
    'BillingController.webhook',
    'BillingController.renewalSweep',
    'AgentLlmController.*',
    'AutomationController.*',
  ]);

  // Load every controller in the application, not only the ones in this spec's module graph.
  const { AppModule } = await import('../app.module');
  const full = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const found = new Set<string>();
  for (const module of (full as unknown as { container: { getModules(): Map<string, unknown> } })
    .container.getModules()
    .values()) {
    const controllers = (module as { controllers: Map<unknown, { metatype?: unknown }> })
      .controllers;
    for (const wrapper of controllers.values()) {
      const metatype = wrapper.metatype as (new () => unknown) | undefined;
      if (!metatype) continue;
      if (Reflect.getMetadata(IS_PUBLIC_KEY, metatype) === true) {
        found.add(`${metatype.name}.*`);
        continue;
      }
      for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
        if (name === 'constructor') continue;
        const handler = (metatype.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true) {
          found.add(`${metatype.name}.${name}`);
        }
      }
    }
  }
  await full.close();

  assert.deepEqual(
    [...found].sort(),
    [...expected].sort(),
    'the set of @Public routes changed — every addition must be deliberate and reviewed',
  );
});
