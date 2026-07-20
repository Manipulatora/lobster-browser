/**
 * Wraps the Twilio Voice SDK `Device` for the desktop softphone: register with a backend-minted access
 * token, place outbound calls, ring on inbound, mute/hang-up, and refresh the token before it expires.
 * Audio is real WebRTC (Opus). One active call at a time — enough for a per-operator phone.
 */
import { Call, Device } from '@twilio/voice-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getPhoneConfig, phoneClient } from './phoneApi';

export type VoiceStatus = 'offline' | 'initializing' | 'ready' | 'error';

export interface ActiveCall {
  direction: 'inbound' | 'outbound';
  /** The other party's E.164 number. */
  peer: string;
  /** Which owned number this call is on (best-effort). */
  line?: string;
  state: 'ringing' | 'active';
  muted: boolean;
  /** ms epoch when the call connected (for the duration timer). */
  startedAt?: number;
}

export interface VoiceDevice {
  status: VoiceStatus;
  error?: string;
  call: ActiveCall | null;
  /** (Re)initialize the device from the current config; safe to call repeatedly. */
  init: () => Promise<void>;
  startCall: (to: string, from: string) => Promise<void>;
  answer: () => void;
  hangup: () => void;
  toggleMute: () => void;
}

export function useVoiceDevice(): VoiceDevice {
  const [status, setStatus] = useState<VoiceStatus>('offline');
  const [error, setError] = useState<string | undefined>();
  const [call, setCall] = useState<ActiveCall | null>(null);

  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);

  const clearCall = useCallback(() => {
    callRef.current = null;
    setCall(null);
  }, []);

  const bindCall = useCallback(
    (twilioCall: Call, initial: ActiveCall) => {
      callRef.current = twilioCall;
      setCall(initial);

      twilioCall.on('accept', () => {
        setCall((c) => (c ? { ...c, state: 'active', startedAt: Date.now() } : c));
      });
      const end = () => clearCall();
      twilioCall.on('disconnect', end);
      twilioCall.on('cancel', end);
      twilioCall.on('reject', end);
      twilioCall.on('error', end);
    },
    [clearCall],
  );

  const init = useCallback(async () => {
    if (!getPhoneConfig()) {
      setStatus('offline');
      return;
    }
    try {
      setStatus('initializing');
      setError(undefined);
      // Tear down any prior device (config change / re-init).
      deviceRef.current?.destroy();

      const { token } = await phoneClient.voiceToken();
      const device = new Device(token, {
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
        // Twilio picks the lowest-latency media edge automatically.
        edge: 'roaming',
      });
      deviceRef.current = device;

      device.on('registered', () => setStatus('ready'));
      device.on('unregistered', () => setStatus('offline'));
      device.on('error', (e: { message?: string }) => {
        setError(e?.message ?? 'voice device error');
        setStatus('error');
      });
      device.on('tokenWillExpire', async () => {
        try {
          const fresh = await phoneClient.voiceToken();
          device.updateToken(fresh.token);
        } catch {
          /* next call will re-init */
        }
      });
      device.on('incoming', (incoming: Call) => {
        const peer =
          incoming.customParameters?.get('caller') ?? incoming.parameters?.From ?? 'Unknown';
        const line = incoming.customParameters?.get('line') ?? undefined;
        bindCall(incoming, { direction: 'inbound', peer, line, state: 'ringing', muted: false });
      });

      await device.register();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [bindCall]);

  const startCall = useCallback(
    async (to: string, from: string) => {
      const device = deviceRef.current;
      if (!device || status !== 'ready') throw new Error('voice device not ready');
      if (callRef.current) throw new Error('already on a call');
      const twilioCall = await device.connect({ params: { To: to, From: from } });
      bindCall(twilioCall, { direction: 'outbound', peer: to, line: from, state: 'ringing', muted: false });
    },
    [status, bindCall],
  );

  const answer = useCallback(() => {
    callRef.current?.accept();
  }, []);

  const hangup = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    // reject() if still ringing inbound, else disconnect() an active/outbound call.
    if (call?.direction === 'inbound' && call.state === 'ringing') c.reject();
    else c.disconnect();
    clearCall();
  }, [call, clearCall]);

  const toggleMute = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    const next = !c.isMuted();
    c.mute(next);
    setCall((prev) => (prev ? { ...prev, muted: next } : prev));
  }, []);

  // Initialize on mount when configured; tear down on unmount.
  useEffect(() => {
    void init();
    return () => {
      deviceRef.current?.destroy();
      deviceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, error, call, init, startCall, answer, hangup, toggleMute };
}
