import {
  ApiError,
  BoardSettings,
  type BoardSettingsPatch,
  BrowserSessionsResponse,
  HooksInstallResponse,
  HooksPlanResponse,
  HooksStatusResponse,
  LibraryResponse,
  OkResponse,
  PairedDevicesResponse,
  PairingResponse,
  PortShare,
  PortSharesResponse,
  PushInfoResponse,
  RotateTokenResponse,
  SearchIndexStatus,
  SearchResponse,
  SearchTranscriptResponse,
  SeenResponse,
  type SeenUpdate,
  ServerStatus,
} from '@yardmaster/protocol';
import { boardFetch } from '../auth/session.js';

/** A failed settings call: the HTTP status plus the server's error code and message, if any. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  schema: { parse(value: unknown): T },
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await boardFetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = ApiError.safeParse(json);
    throw new ApiRequestError(
      res.status,
      error.success ? error.data.error : null,
      error.success && error.data.message
        ? error.data.message
        : `${method} ${url} failed: ${res.status}`,
    );
  }
  return schema.parse(json);
}

export const api = {
  seen: () => request(SeenResponse, 'GET', '/api/seen'),
  markSeen: (update: SeenUpdate) => request(OkResponse, 'POST', '/api/seen', update),
  status: (signal?: AbortSignal) => request(ServerStatus, 'GET', '/api/status', undefined, signal),
  settings: (signal?: AbortSignal) =>
    request(BoardSettings, 'GET', '/api/settings', undefined, signal),
  updateSettings: (patch: BoardSettingsPatch) =>
    request(BoardSettings, 'PUT', '/api/settings', patch),
  hooks: (signal?: AbortSignal) =>
    request(HooksStatusResponse, 'GET', '/api/hooks', undefined, signal),
  planHooks: () => request(HooksPlanResponse, 'POST', '/api/hooks/plan', {}),
  installHooks: (fingerprint: string) =>
    request(HooksInstallResponse, 'POST', '/api/hooks/install', { fingerprint }),
  rotateToken: () => request(RotateTokenResponse, 'POST', '/api/token/rotate', {}),
  sessions: (signal?: AbortSignal) =>
    request(BrowserSessionsResponse, 'GET', '/api/sessions', undefined, signal),
  revokeSession: (id: string) =>
    request(OkResponse, 'DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  library: (signal?: AbortSignal) =>
    request(LibraryResponse, 'GET', '/api/library', undefined, signal),
  pair: (host?: string) =>
    request(PairingResponse, 'POST', '/api/remote/pair', host === undefined ? {} : { host }),
  devices: (signal?: AbortSignal) =>
    request(PairedDevicesResponse, 'GET', '/api/remote/devices', undefined, signal),
  revokeDevice: (id: string) =>
    request(OkResponse, 'DELETE', `/api/remote/devices/${encodeURIComponent(id)}`),
  portShares: (signal?: AbortSignal) =>
    request(PortSharesResponse, 'GET', '/api/ports/shares', undefined, signal),
  sharePort: (port: number) => request(PortShare, 'POST', `/api/ports/${port}/share`, {}),
  unsharePort: (port: number) => request(OkResponse, 'DELETE', `/api/ports/${port}/share`),
  push: (signal?: AbortSignal) => request(PushInfoResponse, 'GET', '/api/push', undefined, signal),
  removePushDevice: (id: string) =>
    request(OkResponse, 'DELETE', `/api/push/subscriptions/${encodeURIComponent(id)}`),
  search: (query: URLSearchParams, signal?: AbortSignal) =>
    request(SearchResponse, 'GET', `/api/search?${query}`, undefined, signal),
  searchIndex: (signal?: AbortSignal) =>
    request(SearchIndexStatus, 'GET', '/api/search/index', undefined, signal),
  rebuildSearchIndex: () => request(OkResponse, 'POST', '/api/search/index/rebuild', {}),
  clearSearchIndex: () => request(OkResponse, 'DELETE', '/api/search/index'),
  searchTranscript: (sessionId: string, around?: string, signal?: AbortSignal) =>
    request(
      SearchTranscriptResponse,
      'GET',
      `/api/search/sessions/${encodeURIComponent(sessionId)}${
        around ? `?around=${encodeURIComponent(around)}` : ''
      }`,
      undefined,
      signal,
    ),
  testPush: (id: string) => request(OkResponse, 'POST', '/api/push/test', { id }),
};
