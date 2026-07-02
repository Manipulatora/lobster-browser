/**
 * The universal response envelope used by the local automation API (and mirrored by
 * the AdsPower/Octo contract developers already integrate against): `{ code, data, msg }`.
 * `code === 0` means success.
 */
export interface ApiResponse<T> {
  code: number;
  data: T | null;
  msg: string;
}

export const API_OK = 0;
export const API_ERR = 1;

export function ok<T>(data: T, msg = 'success'): ApiResponse<T> {
  return { code: API_OK, data, msg };
}

export function err(msg: string, code = API_ERR): ApiResponse<null> {
  return { code, data: null, msg };
}

/** Payload returned by the local API `start` endpoint — both connect styles, zero friction. */
export interface StartProfileResult {
  profileId: string;
  /** Playwright/Puppeteer: `browser.connectOverCDP(ws)`. */
  ws: string;
  /** Selenium: set `debuggerAddress` to this `host:port`. */
  debuggerAddress: string;
  /** The webdriver/automation base http endpoint, when applicable. */
  webDriver?: string;
  pid?: number;
}

export interface ProfileStatusResult {
  profileId: string;
  running: boolean;
  ws?: string;
  debuggerAddress?: string;
}

export interface LocalApiListItem {
  profileId: string;
  name: string;
  running: boolean;
}
