import {
  ApiError,
  BoardSettings,
  type BoardSettingsPatch,
  HooksInstallResponse,
  HooksPlanResponse,
  HooksStatusResponse,
  LibraryResponse,
  OkResponse,
  PairedDevicesResponse,
  PairingResponse,
  ServerStatus,
} from '@c-board/protocol';

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
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
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
  rotateToken: () => request(OkResponse, 'POST', '/api/token/rotate', {}),
  library: (signal?: AbortSignal) =>
    request(LibraryResponse, 'GET', '/api/library', undefined, signal),
  pair: (host?: string) =>
    request(PairingResponse, 'POST', '/api/remote/pair', host === undefined ? {} : { host }),
  devices: (signal?: AbortSignal) =>
    request(PairedDevicesResponse, 'GET', '/api/remote/devices', undefined, signal),
  revokeDevice: (id: string) =>
    request(OkResponse, 'DELETE', `/api/remote/devices/${encodeURIComponent(id)}`),
};
