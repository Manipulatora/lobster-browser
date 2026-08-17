import { Global, Module } from '@nestjs/common';

import { MailService } from './mail.service';

/** Global so any feature can send without re-importing; there is only ever one transport. */
@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
