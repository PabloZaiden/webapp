import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createWebAppServer, defineRoutes, jsonResponse, memoryWebAppStore,
  type RealtimeBus, type RealtimeTransport, type RuntimeConfig,
} from "@pablozaiden/webapp/server";
import {
  realtimeServerMessageSchema, type RealtimeServerMessage, type ResourceRealtimeEvent,
} from "@pablozaiden/webapp/contracts";

async function bounded<T>(promise: Promise<T>, condition: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${condition}`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function frames(url: string) {
  const socket = new WebSocket(url);
  const open = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<number>();
  const queue: RealtimeServerMessage[] = [];
  let changed = Promise.withResolvers<void>();
  socket.onopen = () => open.resolve();
  socket.onerror = () => open.reject(new Error("WebSocket open failed"));
  socket.onclose = event => { closed.resolve(event.code); changed.resolve(); };
  socket.onmessage = event => {
    queue.push(realtimeServerMessageSchema.parse(JSON.parse(String(event.data))));
    changed.resolve();
  };
  await bounded(open.promise, "WebSocket open");
  return {
    socket, closed: closed.promise,
    send(value: unknown) { socket.send(JSON.stringify(value)); },
    async next(): Promise<RealtimeServerMessage> {
      while (!queue.length) {
        if (socket.readyState === WebSocket.CLOSED) throw new Error("Socket closed before the expected frame");
        changed = Promise.withResolvers<void>();
        await bounded(changed.promise, "WebSocket frame");
      }
      return queue.shift()!;
    },
  };
}

const eventSchema = z.object({
  type: z.literal("documents.changed"), resource: z.literal("documents"),
  action: z.literal("changed"), id: z.string(), scope: z.string(),
});
type Event = ResourceRealtimeEvent;
function config(directory: string, label: string): RuntimeConfig {
  return {
    appName: label, envPrefix: "TEST_REALTIME_SOURCE", host: "127.0.0.1", port: 0,
    dataDir: resolve(directory, label), logLevel: "error", logLevelFromEnv: false,
    passkeyDisabled: true, sameOriginDisabled: true,
    trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
  };
}

// Public contract: admitted relay bytes use ordinary framework subscriptions and
// authorization. Remote events merge only into their local user's connection.
test("portable relay authorization and per-user sources share the normal realtime endpoint", async () => {
  const directory = resolve(".cache/tests", `realtime-source-${crypto.randomUUID()}`);
  const remote = createWebAppServer<Event>({
    appName: "Remote", envPrefix: "TEST_REALTIME_SOURCE", web: false,
    runtimeConfig: config(directory, "Remote"), store: memoryWebAppStore(),
    routes: defineRoutes<Event>({
      "/api/documents/active": {
        auth: "user", sameOrigin: "mutations",
        async POST(req, ctx) {
          const input = z.object({ owner: z.string(), scope: z.string() }).safeParse(await req.json());
          if (!input.success) return jsonResponse({ error: "invalid_input" }, { status: 400 });
          ctx.realtime.publishEntityChanged("documents", "active", {
            scope: input.data.scope, target: { userId: input.data.owner },
          });
          return jsonResponse({ updated: true });
        },
      },
    }),
  });
  const local = createWebAppServer<Event>({
    appName: "Local", envPrefix: "TEST_REALTIME_SOURCE", web: false,
    runtimeConfig: config(directory, "Local"), store: memoryWebAppStore(),
    routes: defineRoutes<Event>({
      "/api/identity": {
        auth: "user", sameOrigin: "mutations", GET: (_req, ctx) => jsonResponse(ctx.requireUser()),
      },
      "/api/documents/local": {
        auth: "user", sameOrigin: "mutations",
        POST(_req, ctx) {
          ctx.userRealtime.publishEntityChanged("documents", "local", { scope: "local" });
          return jsonResponse({ updated: true });
        },
      },
    }),
  });
  const remoteServer = await remote.start();
  const localServer = await local.start();
  const admittedToken = crypto.randomUUID();
  type RelayData = { observer: boolean };
  const transports = new WeakMap<ServerWebSocket<RelayData>, { bus: RealtimeBus<Event>; transport: RealtimeTransport }>();
  const relay = Bun.serve<RelayData>({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.searchParams.get("token") !== admittedToken) return new Response(null, { status: 401 });
      return server.upgrade(req, { data: { observer: url.pathname === "/observer" } })
        ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        const bus = socket.data.observer ? local.realtime : remote.realtime;
        const transport: RealtimeTransport = {
          data: { userId: socket.data.observer ? "another-local-user" : "remote-guest" },
          send: payload => socket.send(payload),
          close: (code, reason) => socket.close(code, reason),
          getBufferedAmount: () => socket.getBufferedAmount(),
        };
        transports.set(socket, { bus, transport });
        bus.add(transport, {
          authorize: socket.data.observer ? () => true : publication =>
            publication.target.userId === "controller-owner" && publication.target.scope === "A",
        });
      },
      message(socket, bytes) {
        const connection = transports.get(socket);
        if (connection) connection.bus.message(connection.transport, bytes);
      },
      close(socket) {
        const connection = transports.get(socket);
        if (connection) connection.bus.remove(connection.transport);
        transports.delete(socket);
      },
    },
  });
  const relayUrl = `${relay.url.origin.replace("http:", "ws:")}`;
  let upstream: WebSocket | undefined;
  let client: Awaited<ReturnType<typeof frames>> | undefined;
  let observer: Awaited<ReturnType<typeof frames>> | undefined;
  try {
    const identity = await (await fetch(`${localServer.url.origin}/api/identity`, {
      signal: AbortSignal.timeout(5_000),
    })).json() as { id: string };
    const source = local.realtime.attachSource({
      userId: identity.id,
      authorize: publication => publication.target.userId === "controller-owner" && publication.target.scope === "A",
      transform: publication => {
        const event = eventSchema.parse(publication.event);
        return {
          ...publication,
          event: { ...event, id: `remote:${event.id}`, scope: `remote:${event.scope}` },
          target: { ...publication.target, id: `remote:${event.id}`, scope: `remote:${event.scope}` },
        };
      },
    });
    const ready = Promise.withResolvers<void>();
    upstream = new WebSocket(`${relayUrl}/guest?token=${admittedToken}`);
    upstream.onopen = () => upstream!.send(JSON.stringify({
      type: "subscribe", subscriptionId: "source", generation: 1,
      interest: { kinds: ["state"], resources: ["documents"], scopes: ["A", "B"] },
    }));
    upstream.onerror = () => ready.reject(new Error("Upstream connection failed"));
    upstream.onclose = () => { source.dispose(); ready.reject(new Error("Upstream closed before admission")); };
    upstream.onmessage = message => {
      try {
        const frame = realtimeServerMessageSchema.parse(JSON.parse(String(message.data)));
        if (frame.type === "subscribed") ready.resolve();
        if (frame.type === "event") {
          const event = eventSchema.parse(frame.event);
          source.publish(event, {
            kind: "state",
            target: { userId: "controller-owner", resource: event.resource, id: event.id, scope: event.scope },
          });
        }
      } catch (error) {
        ready.reject(error);
        upstream?.close();
      }
    };
    await bounded(ready.promise, "admitted upstream subscription");
    client = await frames(`${localServer.url.origin.replace("http:", "ws:")}/api/ws`);
    observer = await frames(`${relayUrl}/observer?token=${admittedToken}`);
    for (const peer of [client, observer]) {
      peer.send({
        type: "subscribe", subscriptionId: "documents", generation: 1,
        interest: { kinds: ["state"], resources: ["documents"] },
      });
      expect(await peer.next()).toMatchObject({ type: "subscribed" });
    }
    for (const input of [
      { owner: "another-owner", scope: "A" },
      { owner: "controller-owner", scope: "B" },
      { owner: "controller-owner", scope: "A" },
    ]) {
      const response = await fetch(`${remoteServer.url.origin}/api/documents/active`, {
        method: "POST", headers: { origin: remoteServer.url.origin, "content-type": "application/json" },
        body: JSON.stringify(input), signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(200);
    }
    expect(await client.next()).toMatchObject({
      type: "event", event: { id: "remote:active", scope: "remote:A", resource: "documents" },
    });
    observer.send({ type: "ping" });
    expect(await observer.next()).toEqual({ type: "pong" });
    const localUpdate = await fetch(`${localServer.url.origin}/api/documents/local`, {
      method: "POST", headers: { origin: localServer.url.origin }, signal: AbortSignal.timeout(5_000),
    });
    expect(localUpdate.status).toBe(200);
    expect(await client.next()).toMatchObject({ type: "event", event: { id: "local", scope: "local" } });
    upstream.close();
    expect(await bounded(client.closed, "source loss invalidates the local connection")).toBe(1012);
  } finally {
    upstream?.close();
    client?.socket.close();
    observer?.socket.close();
    await relay.stop(true);
    await remote.stop(true);
    await local.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
