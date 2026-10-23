import type { RealtimeKind } from "../../contracts/realtime";

export interface WebSocketData {
  userId?: string;
}

/** Bun ServerWebSocket satisfies this interface without an adapter. */
export interface RealtimeTransport {
  readonly data: WebSocketData;
  send(payload: string): number | void;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

export type RealtimeTarget = {
  resource?: string;
  id?: string;
  scope?: string;
  userId?: string;
} & Record<string, string | undefined>;

export interface RealtimePublication<TEvent> {
  event: TEvent;
  target: Readonly<RealtimeTarget>;
  kind: RealtimeKind;
}

export interface RealtimeConnectionOptions<TEvent> {
  /**
   * Replaces default userId targeting. Must authorize the original owner AND
   * resource scope, independently of untrusted subscription interests.
   */
  authorize?: (publication: Readonly<RealtimePublication<TEvent>>) => boolean;
  /** Runs after authorization, before matching the connection's interests. */
  transform?: (publication: Readonly<RealtimePublication<TEvent>>) => RealtimePublication<TEvent> | undefined;
  onDispose?: () => void;
}

export interface RealtimeSourceOptions<TEvent> {
  /** Authenticated local recipient, never an upstream storage owner. */
  userId: string;
  /** Validates original upstream event metadata before any transformation. */
  authorize: (publication: Readonly<RealtimePublication<TEvent>>) => boolean;
  transform?: (publication: Readonly<RealtimePublication<TEvent>>) => RealtimePublication<TEvent> | undefined;
  onDispose?: () => void;
}

/** A server-owned source feeds only its local user's existing connections. */
export interface RealtimeSource<TEvent> {
  publish(event: TEvent, options?: { target?: RealtimeTarget; kind?: RealtimeKind }): void;
  /** Close recipient connections so reconnect refreshes authoritative state. */
  invalidate(): void;
  /** Idempotently detach and invalidate. No queued event history is retained. */
  dispose(): void;
}
