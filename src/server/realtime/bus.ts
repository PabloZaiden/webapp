import type { ServerWebSocket } from "bun";
import {
  realtimeClientMessageSchema, realtimeInterestMatches, MAX_REALTIME_SUBSCRIPTIONS,
  type RealtimeAction, type RealtimeInterest, type RealtimeKind, type RealtimeServerMessage,
  type ResourceRealtimeEvent,
} from "../../contracts/realtime";
export type { RealtimeAction, RealtimeKind, ResourceRealtimeEvent } from "../../contracts/realtime";

export interface WebSocketData {
  userId?: string;
}
export type RealtimeTarget = {
  resource?: string;
  id?: string;
  scope?: string;
  userId?: string;
} & Record<string, string | undefined>;
export interface RealtimePublishOptions {
  target?: RealtimeTarget;
  kind?: RealtimeKind;
  filter?: (socket: ServerWebSocket<WebSocketData>) => boolean;
}
interface Subscription {
  generation: number;
  interest: RealtimeInterest;
}
interface Connection {
  subscriptions: Map<string, Subscription>;
  generations: Map<string, number>;
}
export interface RealtimeBusOptions {
  maxSubscriptions?: number;
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
}

/** Owns server subscription state, never authorization inferred from client interests. */
export class RealtimeBus<TEvent = unknown> {
  private sockets = new Map<ServerWebSocket<WebSocketData>, Connection>();
  private readonly limits: Required<RealtimeBusOptions>;

  constructor(options: RealtimeBusOptions = {}) {
    this.limits = {
      maxSubscriptions: options.maxSubscriptions ?? MAX_REALTIME_SUBSCRIPTIONS,
      maxMessageBytes: options.maxMessageBytes ?? 64 * 1024,
      maxBufferedBytes: options.maxBufferedBytes ?? 1024 * 1024,
    };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Realtime limits must be positive integers");
    }
    if (this.limits.maxSubscriptions > MAX_REALTIME_SUBSCRIPTIONS) {
      throw new TypeError(`Realtime supports at most ${MAX_REALTIME_SUBSCRIPTIONS} subscriptions per connection`);
    }
  }

  add(socket: ServerWebSocket<WebSocketData>): void {
    this.sockets.set(socket, { subscriptions: new Map(), generations: new Map() });
  }

  remove(socket: ServerWebSocket<WebSocketData>): void {
    this.sockets.delete(socket);
  }

  private fail(socket: ServerWebSocket<WebSocketData>, code: "invalid_message" | "subscription_limit" | "stale_generation" | "backpressure", message: string): void {
    this.remove(socket);
    socket.send(JSON.stringify({ type: "error", code, message }));
    socket.close(code === "backpressure" ? 1013 : 1008, code);
  }

  private send(socket: ServerWebSocket<WebSocketData>, frame: RealtimeServerMessage<TEvent>): boolean {
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload) + socket.getBufferedAmount() > this.limits.maxBufferedBytes) {
      this.fail(socket, "backpressure", "Realtime delivery exceeded the connection buffer; synchronize after reconnecting");
      return false;
    }
    // Bun's -1 means queued (not dropped); zero means delivery was lost.
    if (socket.send(payload) === 0) {
      this.fail(socket, "backpressure", "Realtime delivery failed; synchronize after reconnecting");
      return false;
    }
    return true;
  }

  message(socket: ServerWebSocket<WebSocketData>, raw: string | Buffer): void {
    const connection = this.sockets.get(socket);
    if (!connection) return;
    if (Buffer.byteLength(raw) > this.limits.maxMessageBytes) {
      this.fail(socket, "invalid_message", "Realtime message exceeds the size limit");
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(String(raw));
    } catch {
      this.fail(socket, "invalid_message", "Realtime messages must be JSON");
      return;
    }
    const parsed = realtimeClientMessageSchema.safeParse(input);
    if (!parsed.success) {
      this.fail(socket, "invalid_message", "Invalid realtime subscription message");
      return;
    }
    const frame = parsed.data;
    if (frame.type === "ping") {
      this.send(socket, { type: "pong" });
      return;
    }
    const existing = connection.subscriptions.get(frame.subscriptionId);
    const previousGeneration = connection.generations.get(frame.subscriptionId);
    if (previousGeneration !== undefined && frame.generation <= previousGeneration) {
      this.fail(socket, "stale_generation", "Subscription generations must increase");
      return;
    }
    if (frame.type === "unsubscribe") {
      connection.subscriptions.delete(frame.subscriptionId);
      if (previousGeneration !== undefined) connection.generations.set(frame.subscriptionId, frame.generation);
      this.send(socket, { type: "unsubscribed", subscriptionId: frame.subscriptionId, generation: frame.generation });
      return;
    }
    if (!existing && connection.subscriptions.size >= this.limits.maxSubscriptions) {
      this.fail(socket, "subscription_limit", "Too many realtime subscriptions");
      return;
    }
    if (previousGeneration === undefined && connection.generations.size >= this.limits.maxSubscriptions * 32) {
      this.fail(socket, "backpressure", "Subscription generation tracking is full; synchronize after reconnecting");
      return;
    }
    connection.generations.set(frame.subscriptionId, frame.generation);
    connection.subscriptions.set(frame.subscriptionId, { generation: frame.generation, interest: frame.interest });
    // The subscription is active before the ack; WebSocket frame order makes the handoff deterministic.
    this.send(socket, { type: "subscribed", subscriptionId: frame.subscriptionId, generation: frame.generation });
  }

  publish(event: TEvent, options: RealtimePublishOptions = {}): void {
    const target = options.target ?? {};
    for (const [socket, connection] of this.sockets) {
      if (target.userId !== undefined && socket.data.userId !== target.userId) continue;
      if (options.filter && !options.filter(socket)) continue;
      const subscriptions = [...connection.subscriptions].flatMap(([subscriptionId, subscription]) =>
        realtimeInterestMatches(subscription.interest, options.kind ?? "content", event, target)
          ? [{ subscriptionId, generation: subscription.generation }] : []);
      if (subscriptions.length) this.send(socket, { type: "event", subscriptions, event });
    }
  }

  publishChanged<TPayload = unknown>(resource: string, options: ResourceOptions<TPayload> = {}): void {
    this.publishResource(resource, "changed", options);
  }
  publishEntityChanged<TPayload = unknown>(resource: string, id: string, options: ResourceOptions<TPayload> = {}): void {
    this.publishResource(resource, "changed", { ...options, id });
  }
  publishDeleted<TPayload = unknown>(resource: string, id: string, options: ResourceOptions<TPayload> = {}): void {
    this.publishResource(resource, "deleted", { ...options, id });
  }
  publishSettingsChanged<TPayload = unknown>(options: ResourceOptions<TPayload> = {}): void {
    this.publishResource("settings", "changed", options);
  }
  publishResource<TPayload = unknown>(resource: string, action: RealtimeAction, options: ResourceOptions<TPayload> = {}): void {
    const { target: explicit, ...eventOptions } = options;
    const event: ResourceRealtimeEvent<TPayload> = { type: `${resource}.${action}`, resource, action, ...eventOptions };
    const target: RealtimeTarget = { ...explicit };
    for (const field of ["resource", "id", "scope"] as const) {
      if (explicit?.[field] !== undefined && explicit[field] !== event[field]) {
        throw new TypeError(`Realtime target ${field} conflicts with event metadata`);
      }
      if (event[field] !== undefined) target[field] = event[field];
    }
    this.publish(event as TEvent, { kind: "state", target });
  }
  get connectionCount(): number {
    return this.sockets.size;
  }
}
type ResourceOptions<TPayload> = Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action"> & { target?: RealtimeTarget };
export function createRealtimeBus<TEvent = unknown>(options?: RealtimeBusOptions): RealtimeBus<TEvent> {
  return new RealtimeBus<TEvent>(options);
}
