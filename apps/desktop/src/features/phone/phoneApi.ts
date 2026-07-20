/**
 * Client for the backend Phone API (the Twilio broker). The desktop talks to the backend over HTTPS
 * (numbers/SMS/voice-token) and subscribes to inbound events over SSE. The backend base URL + a static
 * access token are configured once (Settings) and kept in localStorage — the token is the operator's
 * own and is never committed.
 */
import type {
  AvailableNumber,
  OwnedNumber,
  PhoneEvent,
  SearchNumbersQuery,
  SmsMessage,
  VoiceToken,
} from '@lobster/shared-types';

export interface PhoneConfig {
  baseUrl: string;
  accessToken: string;
}

const STORAGE_KEY = 'lobster.phone.config';

function fromEnv(): PhoneConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const baseUrl = env.VITE_PHONE_API_URL;
  const accessToken = env.VITE_PHONE_ACCESS_TOKEN;
  return baseUrl && accessToken ? { baseUrl, accessToken } : null;
}

export function getPhoneConfig(): PhoneConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PhoneConfig>;
      if (parsed.baseUrl && parsed.accessToken) {
        return { baseUrl: parsed.baseUrl.replace(/\/+$/, ''), accessToken: parsed.accessToken };
      }
    }
  } catch {
    /* fall through to env */
  }
  return fromEnv();
}

export function savePhoneConfig(config: PhoneConfig): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ baseUrl: config.baseUrl.replace(/\/+$/, ''), accessToken: config.accessToken }),
  );
}

export function clearPhoneConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export class PhoneNotConfiguredError extends Error {
  constructor() {
    super('Phone backend is not configured');
    this.name = 'PhoneNotConfiguredError';
  }
}

interface Envelope<T> {
  code: number;
  data: T;
  msg: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = getPhoneConfig();
  if (!config) throw new PhoneNotConfiguredError();
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.accessToken}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let envelope: Envelope<T> | null = null;
  try {
    envelope = text ? (JSON.parse(text) as Envelope<T>) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok && !envelope) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  if (envelope && envelope.code !== 0) {
    throw new Error(envelope.msg || 'request failed');
  }
  return (envelope ? envelope.data : (undefined as unknown)) as T;
}

function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export interface PhoneStatus {
  configured: boolean;
  accountSid: boolean;
  apiKey: boolean;
  twimlApp: boolean;
  publicBaseUrl: boolean;
  webhookSignatureValidation: boolean;
}

export const phoneClient = {
  status: () => request<PhoneStatus>('/phone/status'),
  searchNumbers: (query: SearchNumbersQuery) =>
    request<AvailableNumber[]>(`/phone/numbers/available${toQuery({ ...query })}`),
  listOwned: () => request<OwnedNumber[]>('/phone/numbers'),
  buyNumber: (phoneNumber: string) =>
    request<OwnedNumber>('/phone/numbers', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    }),
  releaseNumber: (sid: string) =>
    request<{ released: string }>(`/phone/numbers/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
    }),
  voiceToken: () => request<VoiceToken>('/phone/voice/token', { method: 'POST' }),
  sendSms: (from: string, to: string, body: string) =>
    request<SmsMessage>('/phone/sms', {
      method: 'POST',
      body: JSON.stringify({ from, to, body }),
    }),
  history: (number: string) =>
    request<SmsMessage[]>(`/phone/sms${toQuery({ number })}`),
};

/**
 * Subscribe to the backend's real-time event stream (inbound SMS + call/message status). EventSource
 * can't set an Authorization header, so the access token rides as `?key=` (validated server-side).
 * Returns an unsubscribe function. Auto-reconnect is handled by EventSource itself.
 */
export function subscribePhoneEvents(onEvent: (event: PhoneEvent) => void): () => void {
  const config = getPhoneConfig();
  if (!config) throw new PhoneNotConfiguredError();
  const url = `${config.baseUrl}/phone/events?key=${encodeURIComponent(config.accessToken)}`;
  const source = new EventSource(url);
  source.onmessage = (e: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(e.data) as PhoneEvent);
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => source.close();
}
