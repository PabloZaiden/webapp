import { VALID_LOG_LEVELS, type LogLevelName } from "../contracts";
import type { RealtimeSource } from "./realtime/source";

export interface WebAppExternalSession {
  /** Local profile/cache namespace, not a server user or authorization claim. */
  readonly scope: string;
  readonly generation: number;
  readonly ready: boolean;
  readonly error?: Error;
  readonly logLevel: LogLevelName;
}

export function validateExternalSession(session: WebAppExternalSession): WebAppExternalSession {
  if (typeof session.scope !== "string" || !session.scope
    || !Number.isSafeInteger(session.generation) || session.generation < 0
    || typeof session.ready !== "boolean" || !VALID_LOG_LEVELS.includes(session.logLevel)
    || (session.error !== undefined && !(session.error instanceof Error))) {
    throw new TypeError("External client session state is invalid.");
  }
  return session;
}

export interface WebAppDuplexHandlers {
  onMessage: (data: string | ArrayBuffer) => void;
  onClose: (event: { code: number; reason: string }) => void;
  onError: (error: Error) => void;
}

/** A message transport, deliberately not a native WebSocket. */
export interface WebAppDuplex {
  readonly ready: Promise<void>;
  readonly bufferedAmount: number;
  subscribe(handlers: WebAppDuplexHandlers): () => void;
  send(data: string | ArrayBuffer | Uint8Array): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface WebAppResourceUrl {
  url: string;
  expiresAt: number | null;
  /** Release client-owned resources once the consumer no longer uses the URL. */
  dispose?: () => void;
}

export interface WebAppSaveResourceOptions {
  suggestedName: string;
  signal?: AbortSignal;
  onProgress?: (progress: { receivedBytes: number; totalBytes?: number }) => void;
}

/** External applications supply real session/transport state, not server config. */
export interface WebAppExternalClient {
  session: {
    getSnapshot(): WebAppExternalSession;
    subscribe(listener: () => void): () => void;
    refresh(): Promise<void>;
  };
  request(request: Request): Promise<Response>;
  createRealtimeSource(): RealtimeSource;
  connect(path: string, options: { signal?: AbortSignal }): Promise<WebAppDuplex>;
  resourceUrl?(path: string, options: { signal?: AbortSignal }): Promise<WebAppResourceUrl>;
  saveResource?(path: string, options: WebAppSaveResourceOptions): Promise<void>;
}
