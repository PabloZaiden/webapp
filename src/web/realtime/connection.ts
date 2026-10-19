import {
  realtimeClientMessageSchema, realtimeServerMessageSchema,
  type RealtimeClientMessage, type RealtimeInterest,
} from "../../contracts/realtime";
import { createLogger } from "../logger";

export type RealtimeStatus = "connecting" | "open" | "closed";
export interface RealtimeActivation { generation: number }
export interface RealtimeSubscriber<TEvent = unknown> {
  interest: RealtimeInterest;
  onEvent: (event: TEvent) => void;
  onSubscribed?: (activation: RealtimeActivation) => void | Promise<void>;
  onStatus?: (status: RealtimeStatus) => void;
  onError?: (error: Error) => void;
}
interface Subscription extends RealtimeSubscriber {
  generation: number;
  active: boolean;
  retired: boolean;
  acknowledgement?: ReturnType<typeof setTimeout>;
}
const log = createLogger("webapp:realtime");
const DEADLINE_MS = 5_000;
const HEARTBEAT_MS = 15_000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/** A runtime owns one transport and all of its subscriptions, heartbeat and retries. */
export class RealtimeRuntime {
  private subscriptions = new Map<string, Subscription>();
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private stopped = false;
  private listening = false;
  private blocked = false;
  private idleCloseScheduled = false;

  constructor(private readonly url: string) {}

  subscribe<TEvent>(subscriber: RealtimeSubscriber<TEvent>): () => void {
    if (this.stopped) throw new Error("Realtime runtime has been disposed");
    const id = crypto.randomUUID();
    const parsed = realtimeClientMessageSchema.parse({
      type: "subscribe", subscriptionId: id, generation: 1, interest: subscriber.interest,
    });
    if (parsed.type !== "subscribe") throw new Error("Invalid subscription");
    const subscription: Subscription = { ...subscriber, interest: parsed.interest, onEvent: subscriber.onEvent as (event: unknown) => void, generation: 0, active: false, retired: false };
    this.subscriptions.set(id, subscription);
    this.blocked = false;
    this.invoke(subscription, () => subscription.onStatus?.("connecting"));
    this.listen();
    if (this.socket?.readyState === WebSocket.OPEN) this.activate(id, subscription);
    else if (!this.socket && this.retry === undefined) this.connect();
    return () => {
      if (!this.subscriptions.delete(id)) return;
      clearTimeout(subscription.acknowledgement);
      subscription.active = false;
      subscription.retired = true;
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.send({ type: "unsubscribe", subscriptionId: id, generation: ++subscription.generation });
      }
      if (!this.subscriptions.size && !this.idleCloseScheduled) {
        this.idleCloseScheduled = true;
        queueMicrotask(() => {
          this.idleCloseScheduled = false;
          if (!this.subscriptions.size) this.stopTransport();
        });
      }
    };
  }

  private report(subscription: Subscription, value: unknown): void {
    if (subscription.retired) return;
    const error = value instanceof Error ? value : new Error(String(value));
    try {
      if (subscription.onError) subscription.onError(error);
      else log.error("Realtime consumer failed", { error: error.message });
    } catch (reportError) {
      log.error("Realtime error handler failed", { error: String(reportError), cause: error.message });
    }
  }

  private invoke(subscription: Subscription, callback: () => void | Promise<void>): void {
    const generation = subscription.generation;
    try {
      const result = callback();
      if (result) void result.catch(error => {
        if (generation === subscription.generation) this.report(subscription, error);
      });
    } catch (error) {
      this.report(subscription, error);
    }
  }

  private send(frame: RealtimeClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      const payload = JSON.stringify(frame);
      if (socket.bufferedAmount + new TextEncoder().encode(payload).byteLength > MAX_FRAME_BYTES) {
        throw new Error("Realtime outbound buffer exceeded");
      }
      socket.send(payload);
    } catch (error) {
      this.fail(error);
    }
  }

  private activate(id: string, subscription: Subscription): void {
    subscription.active = false;
    const generation = ++subscription.generation;
    subscription.acknowledgement = setTimeout(() => this.fail(new Error("Realtime subscription acknowledgement timed out")), DEADLINE_MS);
    this.send({ type: "subscribe", subscriptionId: id, generation, interest: subscription.interest });
  }

  private connect(): void {
    if (this.stopped || !this.subscriptions.size) return;
    for (const subscription of this.subscriptions.values()) {
      this.invoke(subscription, () => subscription.onStatus?.("connecting"));
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.socket = socket;
    this.deadline = setTimeout(() => this.fail(new Error("Realtime connection timed out")), DEADLINE_MS);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      clearTimeout(this.deadline);
      this.deadline = undefined;
      this.retries = 0;
      this.ping();
      for (const [id, subscription] of this.subscriptions) this.activate(id, subscription);
    };
    socket.onmessage = message => {
      if (this.socket !== socket) return;
      try {
        if (typeof message.data !== "string" || new TextEncoder().encode(message.data).byteLength > MAX_FRAME_BYTES) {
          throw new Error("Invalid or oversized realtime frame");
        }
        const frame = realtimeServerMessageSchema.parse(JSON.parse(message.data));
        if (frame.type === "pong") {
          clearTimeout(this.deadline);
          this.deadline = undefined;
          clearTimeout(this.heartbeat);
          this.heartbeat = setTimeout(() => this.ping(), HEARTBEAT_MS);
        } else if (frame.type === "error") {
          this.fail(new Error(`${frame.code}: ${frame.message}`), frame.code === "backpressure");
        } else if (frame.type === "subscribed") {
          const subscription = this.subscriptions.get(frame.subscriptionId);
          if (!subscription || subscription.generation !== frame.generation || subscription.active) return;
          clearTimeout(subscription.acknowledgement);
          subscription.acknowledgement = undefined;
          subscription.active = true;
          this.invoke(subscription, () => subscription.onStatus?.("open"));
          this.invoke(subscription, () => subscription.onSubscribed?.({ generation: frame.generation }));
        } else if (frame.type === "event") {
          const delivered = new Set<string>();
          for (const match of frame.subscriptions) {
            const subscription = this.subscriptions.get(match.subscriptionId);
            if (!subscription?.active || subscription.generation !== match.generation || delivered.has(match.subscriptionId)) continue;
            delivered.add(match.subscriptionId);
            this.invoke(subscription, () => subscription.onEvent(frame.event));
          }
        }
      } catch (error) {
        this.fail(error);
      }
    };
    socket.onclose = event => { if (this.socket === socket) this.fail(new Error("Realtime connection closed"), event.code !== 1008); };
    socket.onerror = () => { if (this.socket === socket) this.fail(new Error("Realtime connection failed")); };
  }

  private ping(): void {
    this.deadline = setTimeout(() => this.fail(new Error("Realtime heartbeat timed out")), DEADLINE_MS);
    this.send({ type: "ping" });
  }

  private retire(): void {
    clearTimeout(this.heartbeat);
    clearTimeout(this.deadline);
    this.heartbeat = undefined;
    this.deadline = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    for (const subscription of this.subscriptions.values()) {
      clearTimeout(subscription.acknowledgement);
      subscription.acknowledgement = undefined;
      subscription.active = false;
      this.invoke(subscription, () => subscription.onStatus?.("closed"));
    }
  }

  private fail(error: unknown, retry = true): void {
    for (const subscription of this.subscriptions.values()) this.report(subscription, error);
    this.retire();
    this.blocked = !retry;
    if (this.blocked || this.stopped || !this.subscriptions.size || this.retry !== undefined) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, Math.min(250 * 2 ** this.retries++, 10_000));
  }

  private reconnect = (): void => {
    if (!this.subscriptions.size || this.stopped || this.blocked) return;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.retire();
    this.connect();
  };
  private pageShow = (event: PageTransitionEvent): void => { if (event.persisted) this.reconnect(); };

  private listen(): void {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;
    window.addEventListener("online", this.reconnect);
    window.addEventListener("pageshow", this.pageShow);
  }

  private stopTransport(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    this.retire();
    if (this.listening) {
      window.removeEventListener("online", this.reconnect);
      window.removeEventListener("pageshow", this.pageShow);
      this.listening = false;
    }
  }

  dispose(): void {
    this.stopped = true;
    this.stopTransport();
    for (const subscription of this.subscriptions.values()) subscription.retired = true;
    this.subscriptions.clear();
  }
}

export function createRealtimeRuntime(options: { url: string }): RealtimeRuntime {
  return new RealtimeRuntime(options.url);
}
