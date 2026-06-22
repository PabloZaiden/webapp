import type { ServerWebSocket } from "bun";

export interface WebSocketData {
  filters?: Record<string, string>;
  userId?: string;
}

export type RealtimeAction = "created" | "updated" | "changed" | "deleted";

export interface ResourceRealtimeEvent<TPayload = unknown> {
  type: `${string}.${RealtimeAction}`;
  resource: string;
  action: RealtimeAction;
  id?: string;
  scope?: string;
  payload?: TPayload;
}

export type RealtimeTarget = {
  resource?: string;
  id?: string;
  scope?: string;
  userId?: string;
} & Record<string, string | undefined>;

export interface RealtimePublishOptions {
  target?: RealtimeTarget;
  filter?: (socket: ServerWebSocket<WebSocketData>) => boolean;
}

export type RealtimeMessage<TEvent> =
  | { type: "event"; event: TEvent }
  | { type: "ping" }
  | { type: "pong" };

function targetMatches(socket: ServerWebSocket<WebSocketData>, target: RealtimeTarget | undefined): boolean {
  if (!target) return true;
  if (target.userId !== undefined && socket.data.userId !== target.userId) {
    return false;
  }
  const filters = socket.data.filters;
  if (!filters) return true;
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && target[key] !== value) {
      return false;
    }
  }
  return true;
}

export class RealtimeBus<TEvent = unknown> {
  private sockets = new Set<ServerWebSocket<WebSocketData>>();

  add(socket: ServerWebSocket<WebSocketData>): void {
    this.sockets.add(socket);
  }

  remove(socket: ServerWebSocket<WebSocketData>): void {
    this.sockets.delete(socket);
  }

  publish(event: TEvent, options?: RealtimePublishOptions | ((socket: ServerWebSocket<WebSocketData>) => boolean)): void {
    const publishOptions = typeof options === "function" ? { filter: options } : options;
    const payload = JSON.stringify({ type: "event", event } satisfies RealtimeMessage<TEvent>);
    for (const socket of this.sockets) {
      if (targetMatches(socket, publishOptions?.target) && (!publishOptions?.filter || publishOptions.filter(socket))) {
        socket.send(payload);
      }
    }
  }

  publishChanged<TPayload = unknown>(resource: string, options: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action"> & { target?: RealtimeTarget } = {}): void {
    this.publishResource(resource, "changed", options);
  }

  publishEntityChanged<TPayload = unknown>(resource: string, id: string, options: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action" | "id"> & { target?: RealtimeTarget } = {}): void {
    this.publishResource(resource, "changed", { ...options, id });
  }

  publishDeleted<TPayload = unknown>(resource: string, id: string, options: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action" | "id"> & { target?: RealtimeTarget } = {}): void {
    this.publishResource(resource, "deleted", { ...options, id });
  }

  publishSettingsChanged<TPayload = unknown>(options: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action"> & { target?: RealtimeTarget } = {}): void {
    this.publishResource("settings", "changed", options);
  }

  publishResource<TPayload = unknown>(
    resource: string,
    action: RealtimeAction,
    options: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action"> & { target?: RealtimeTarget } = {},
  ): void {
    const { target, ...eventOptions } = options;
    const event = {
      type: `${resource}.${action}`,
      resource,
      action,
      ...eventOptions,
    } satisfies ResourceRealtimeEvent<TPayload>;
    this.publish(event as TEvent, { target: target ?? { resource, ...(event.id ? { id: event.id } : {}), ...(event.scope ? { scope: event.scope } : {}) } });
  }

  get connectionCount(): number {
    return this.sockets.size;
  }
}

export function createRealtimeBus<TEvent = unknown>(): RealtimeBus<TEvent> {
  return new RealtimeBus<TEvent>();
}
