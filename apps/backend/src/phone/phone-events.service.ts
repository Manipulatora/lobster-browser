import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

import type { PhoneEvent } from '@lobster/shared-types';

/**
 * In-process fan-out of real-time phone events. Webhook handlers `emit()`; the SSE endpoint
 * (`GET /phone/events`) subscribes to `stream()`. Single-process is fine for the single-operator
 * deployment; a multi-node deployment would back this with Redis pub/sub.
 */
@Injectable()
export class PhoneEventsService {
  private readonly subject = new Subject<PhoneEvent>();

  emit(event: PhoneEvent): void {
    this.subject.next(event);
  }

  stream(): Observable<PhoneEvent> {
    return this.subject.asObservable();
  }
}
