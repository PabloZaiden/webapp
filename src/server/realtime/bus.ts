import {
  realtimeClientMessageSchema, realtimeInterestMatches, MAX_REALTIME_SUBSCRIPTIONS,
  type RealtimeAction, type RealtimeInterest, type RealtimeKind, type RealtimeServerMessage,
  type ResourceRealtimeEvent,
} from "../../contracts/realtime";
import { createLogger } from "../logger";
import type {
  RealtimeConnectionOptions, RealtimePublication, RealtimeSource,
  RealtimeSourceOptions, RealtimeTarget, RealtimeTransport,
} from "./transport";
export * from "./transport";
export type { RealtimeAction, RealtimeKind, ResourceRealtimeEvent } from "../../contracts/realtime";

export interface RealtimePublishOptions {
  target?: RealtimeTarget;
  kind?: RealtimeKind;
  filter?: (socket: RealtimeTransport) => boolean;
}
interface Subscription {
  generation: number;
  interest: RealtimeInterest;
}
interface Connection<TEvent> {
  subscriptions: Map<string, Subscription>;
  generations: Map<string, number>;
  options: RealtimeConnectionOptions<TEvent>;
}
const log = createLogger("webapp:realtime");
export interface RealtimeBusOptions {
  maxSubscriptions?: number;
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
}

/** Owns server subscription state, never authorization inferred from client interests. */
export class RealtimeBus<TEvent = unknown> {
  private sockets = new Map<RealtimeTransport, Connection<TEvent>>();
  private sources = new Set<RealtimeSource<TEvent>>();
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

  add(socket: RealtimeTransport, options: RealtimeConnectionOptions<TEvent> = {}): void {
    this.remove(socket);
    this.sockets.set(socket, { subscriptions: new Map(), generations: new Map(), options });
  }

  remove(socket: RealtimeTransport): void {
    const connection = this.sockets.get(socket);
    this.sockets.delete(socket);
    if (connection) this.cleanup(connection.options.onDispose);
  }

  private cleanup(dispose?: () => void): void {
    try {
      dispose?.();
    } catch (error) {
      log.error("Realtime cleanup failed", { error: String(error) });
    }
  }

  private close(socket: RealtimeTransport, code: number, reason: string): void {
    this.remove(socket);
    this.cleanup(() => socket.close(code, reason));
  }

  private fail(socket: RealtimeTransport, code: "invalid_message" | "subscription_limit" | "stale_generation" | "backpressure", message: string): void {
    this.remove(socket);
    this.cleanup(() => { socket.send(JSON.stringify({ type: "error", code, message })); });
    this.close(socket, code === "backpressure" ? 1013 : 1008, code);
  }

  private send(socket: RealtimeTransport, frame: RealtimeServerMessage<TEvent>): boolean {
    const payload = JSON.stringify(frame);
    try {
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
    } catch (error) {
      log.error("Realtime transport failed", { error: String(error) });
      this.close(socket, 1011, "transport_failed");
      return false;
    }
  }

  message(socket: RealtimeTransport, raw: string | Uint8Array): void {
    const connection = this.sockets.get(socket);
    if (!connection) return;
    if (Buffer.byteLength(raw) > this.limits.maxMessageBytes) {
      this.fail(socket, "invalid_message", "Realtime message exceeds the size limit");
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
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
    const publication = { event, target: options.target ?? {}, kind: options.kind ?? "content" };
    for (const [socket, connection] of this.sockets) {
      if (options.filter && !options.filter(socket)) continue;
      this.deliver(socket, connection, publication);
    }
  }

  private deliver(socket: RealtimeTransport, connection: Connection<TEvent>, original: RealtimePublication<TEvent>): void {
    try {
      if (connection.options.authorize) {
        if (!connection.options.authorize(original)) return;
      } else if (original.target.userId !== undefined && socket.data.userId !== original.target.userId) {
        return;
      }
      const publication = connection.options.transform ? connection.options.transform(original) : original;
      if (!publication || this.sockets.get(socket) !== connection) return;
      const subscriptions = [...connection.subscriptions].flatMap(([subscriptionId, subscription]) =>
        realtimeInterestMatches(subscription.interest, publication.kind, publication.event, publication.target)
          ? [{ subscriptionId, generation: subscription.generation }] : []);
      if (subscriptions.length) this.send(socket, { type: "event", subscriptions, event: publication.event });
    } catch (error) {
      log.error("Realtime connection policy failed", { error: String(error) });
      this.close(socket, 1011, "policy_failed");
    }
  }

  attachSource(options: RealtimeSourceOptions<TEvent>): RealtimeSource<TEvent> {
    if (!options.userId) throw new TypeError("A realtime source requires a local userId");
    let active = true;
    const invalidate = () => {
      for (const socket of this.sockets.keys()) {
        if (socket.data.userId === options.userId) this.close(socket, 1012, "source_changed");
      }
    };
    const source: RealtimeSource<TEvent> = {
      publish: (event, publishOptions = {}) => {
        if (!active) return;
        try {
          const original = { event, target: publishOptions.target ?? {}, kind: publishOptions.kind ?? "content" };
          if (!options.authorize(original)) return;
          const transformed = options.transform ? options.transform(original) : original;
          if (!transformed || !active) return;
          const publication = { ...transformed, target: { ...transformed.target, userId: options.userId } };
          for (const [socket, connection] of this.sockets) {
            if (socket.data.userId === options.userId) this.deliver(socket, connection, publication);
          }
        } catch (error) {
          log.error("Realtime source policy failed", { error: String(error) });
          source.dispose();
        }
      },
      invalidate: () => { if (active) invalidate(); },
      dispose: () => {
        if (!active) return;
        active = false;
        this.sources.delete(source);
        invalidate();
        this.cleanup(options.onDispose);
      },
    };
    this.sources.add(source);
    return source;
  }

  /** Release portable transports and upstream sources as well as Bun sockets. */
  dispose(): void {
    for (const source of this.sources) source.dispose();
    for (const socket of this.sockets.keys()) this.close(socket, 1001, "server_stopped");
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
