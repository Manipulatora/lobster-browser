import type { Fingerprint } from '@lobster/shared-types';
import type { MobileFormFactor } from './device-frame.js';

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string };
  params?: {
    sessionId?: string;
    targetInfo?: { targetId?: string; type?: string };
  };
}

interface MobileEmulationOptions {
  formFactor?: MobileFormFactor;
  initialScale?: number;
}

export interface MobileEmulationController {
  close(): void;
}

export interface MobileEmulationCommand {
  method: string;
  params: Record<string, unknown>;
}

/** Target-scoped commands required to make every tab behave like mobile Chrome. */
export function mobileEmulationCommands(
  fingerprint: Pick<Fingerprint, 'screen' | 'navigator'>,
  options: MobileEmulationOptions = {},
): MobileEmulationCommand[] {
  const { width, height, devicePixelRatio } = fingerprint.screen;
  const landscape = options.formFactor === 'tablet';
  return [
    {
      method: 'Emulation.setTouchEmulationEnabled',
      params: {
        enabled: true,
        maxTouchPoints: fingerprint.navigator.maxTouchPoints || 5,
      },
    },
    {
      method: 'Emulation.setEmitTouchEventsForMouse',
      params: { enabled: true, configuration: 'mobile' },
    },
    {
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width,
        height,
        deviceScaleFactor: devicePixelRatio || 1,
        mobile: true,
        screenWidth: width,
        screenHeight: height,
        scale: options.initialScale ?? 1,
        screenOrientation: landscape
          ? { type: 'landscapePrimary', angle: 90 }
          : { type: 'portraitPrimary', angle: 0 },
      },
    },
    {
      method: 'Emulation.setScrollbarsHidden',
      params: { hidden: true },
    },
  ];
}

/**
 * Keep mobile emulation attached to the browser lifetime, not only the first page target.
 * New tabs/popups are paused before their first script, configured, then resumed.
 */
export async function installMobileEmulationForAllTargets(
  browserWsUrl: string,
  fingerprint: Pick<Fingerprint, 'screen' | 'navigator'>,
  options: MobileEmulationOptions = {},
): Promise<MobileEmulationController> {
  const socket = new WebSocket(browserWsUrl);
  let nextId = 1;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const sessionsByTarget = new Map<string, string>();
  const configuredSessions = new Set<string>();
  const formFactor = options.formFactor ?? 'phone';
  const visualScale = options.initialScale ?? 1;

  const send = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        reject(new Error(`mobile emulation CDP socket is not open (${method})`));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const configureSession = async (sessionId: string, type: string): Promise<void> => {
    if (configuredSessions.has(sessionId)) return;
    configuredSessions.add(sessionId);
    try {
      if (type === 'page') {
        for (const command of mobileEmulationCommands(fingerprint, {
          formFactor,
          initialScale: visualScale,
        })) {
          await send(command.method, command.params, sessionId);
        }
      }
    } finally {
      // Auto-attach pauses every new target so no page script can observe desktop metrics first.
      await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
    }
  };

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener(
      'error',
      () => reject(new Error('mobile emulation CDP websocket failed to open')),
      { once: true },
    );
  });

  socket.addEventListener('message', (event) => {
    let message: CdpMessage;
    try {
      message = JSON.parse(String(event.data)) as CdpMessage;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || 'CDP error'));
      else request.resolve(message.result);
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      const sessionId = message.params?.sessionId;
      const target = message.params?.targetInfo;
      if (!sessionId) return;
      if (target?.targetId) sessionsByTarget.set(target.targetId, sessionId);
      void configureSession(sessionId, target?.type ?? 'other').catch((error: unknown) => {
        // A target can disappear between attachment and configuration (for example, a popup that
        // immediately closes). Keep the browser-wide controller alive for every other tab.
        console.warn(
          `[mobile-emulation] could not configure ${target?.type ?? 'target'} ${target?.targetId ?? ''}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    if (message.method === 'Target.detachedFromTarget') {
      const sessionId = message.params?.sessionId;
      if (sessionId) {
        configuredSessions.delete(sessionId);
      }
    }
  });
  socket.addEventListener('close', () => {
    closed = true;
    for (const request of pending.values()) {
      request.reject(new Error('mobile emulation CDP websocket closed'));
    }
    pending.clear();
  });

  try {
    await opened;
    await send('Target.setDiscoverTargets', { discover: true });
    await send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    const result = (await send('Target.getTargets')) as {
      targetInfos?: Array<{ targetId: string; type: string }>;
    };
    for (const target of result.targetInfos ?? []) {
      if (target.type !== 'page') continue;
      let sessionId = sessionsByTarget.get(target.targetId);
      if (!sessionId) {
        try {
          const attached = (await send('Target.attachToTarget', {
            targetId: target.targetId,
            flatten: true,
          })) as { sessionId?: string };
          sessionId = attached.sessionId;
        } catch {
          sessionId = sessionsByTarget.get(target.targetId);
        }
      }
      if (sessionId) await configureSession(sessionId, 'page');
    }

  } catch (error) {
    closed = true;
    socket.close();
    throw error;
  }

  return {
    close: () => {
      if (closed) return;
      closed = true;
      socket.close();
    },
  };
}
