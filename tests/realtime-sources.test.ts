import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createWebAppServer, defineRoutes, jsonResponse, memoryWebAppStore,
  type RealtimeBus, type RealtimeTransport, type RuntimeConfig, type WebAppServer, type WebAppWebSocketData,
} from "@pablozaiden/webapp/server";
import {
  realtimeServerMessageSchema, type ResourceRealtimeEvent,
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

async function frames(url: string, parse: (value: unknown) => unknown = value => realtimeServerMessageSchema.parse(value)) {
  const socket = new WebSocket(url);
  const open = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<number>();
  const queue: unknown[] = [];
  let changed = Promise.withResolvers<void>();
  socket.onopen = () => open.resolve();
  socket.onerror = () => open.reject(new Error("WebSocket open failed"));
  socket.onclose = event => { closed.resolve(event.code); changed.resolve(); };
  socket.onmessage = event => {
    queue.push(parse(JSON.parse(String(event.data))));
    changed.resolve();
  };
  await bounded(open.promise, "WebSocket open");
  return {
    socket, closed: closed.promise,
    send(value: unknown) { socket.send(JSON.stringify(value)); },
    async next(): Promise<unknown> {
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

// Public contract: paired control transports survive idle browsers, while the
// source receives only authoritative current interests of its own local user.
test("paired sources observe current browser and CLI interests without retaining subscriptions", async () => {
  const directory = resolve(".cache/tests", `realtime-interests-${crypto.randomUUID()}`);
  const stops = new WeakMap<ServerWebSocket<WebAppWebSocketData>, () => void>();
  let app: WebAppServer<Event>;
  const rawRoutes = defineRoutes({
    "/api/pair": {
      auth: "user", sameOrigin: "always",
      GET(req, ctx) {
        if (!ctx.server?.upgrade(req, { data: { userId: ctx.requireUser().id, webappSocketHandler: "pair" } })) {
          return new Response(null, { status: 400 });
        }
        return undefined;
      },
    },
    "/api/foreign": {
      auth: "user", sameOrigin: "always",
      GET(req, ctx) {
        if (!ctx.server?.upgrade(req, { data: { userId: "another-user", webappSocketHandler: "foreign" } })) {
          return new Response(null, { status: 400 });
        }
        return undefined;
      },
    },
  });
  app = createWebAppServer<Event>({
    appName: "Interests", envPrefix: "TEST_REALTIME_SOURCE", web: false,
    runtimeConfig: config(directory, "Interests"), store: memoryWebAppStore(),
    realtime: { maxInterestObservers: 1 },
    routes: {
      ...rawRoutes,
      "/api/retire-source-runtime": {
        auth: "user", sameOrigin: "mutations",
        POST(_req, ctx) { ctx.realtime.dispose(); return jsonResponse({ retired: true }); },
      },
    },
    websockets: {
      pair: {
        open(socket) {
          try {
            stops.set(socket, app.realtime.observeInterests(socket.data.userId!, interests => {
              if (interests.some(interest => interest.targets?.["source"] === "unavailable")) {
                throw new Error("Upstream source policy cannot admit this interest");
              }
              if (socket.send(JSON.stringify({ type: "interests", interests })) === 0) {
                throw new Error("Paired interest delivery failed");
              }
            }, { onError: () => socket.close(1011, "interest_forwarding_failed") }));
          } catch {
            // The admission exception is reported by the observer or by this peer's close.
            socket.close(1013, "interest_observer_unavailable");
          }
        },
        message(socket) { socket.send(JSON.stringify({ type: "pong" })); },
        close(socket) { stops.get(socket)?.(); stops.delete(socket); },
      },
      foreign: {
        open: socket => app.realtime.add(socket),
        message: (socket, bytes) => app.realtime.message(socket, bytes),
        close: socket => app.realtime.remove(socket),
      },
    },
  });
  const server = await app.start();
  const base = server.url.origin.replace("http:", "ws:");
  const peers: Awaited<ReturnType<typeof frames>>[] = [];
  const connect = async (path: string, raw = false) => {
    const peer = await frames(`${base}${path}`, raw ? value => value : undefined);
    peers.push(peer);
    return peer;
  };
  const subscribe = async (peer: Awaited<ReturnType<typeof frames>>, id: string, interest: unknown) => {
    peer.send({ type: "subscribe", subscriptionId: id, generation: 1, interest });
    expect(await peer.next()).toMatchObject({ type: "subscribed", subscriptionId: id });
  };
  try {
    const pair = await connect("/api/pair", true);
    expect(await pair.next()).toEqual({ type: "interests", interests: [] });
    const excessPair = await connect("/api/pair", true);
    expect(await bounded(excessPair.closed, "observer capacity rejects an additional paired source")).toBe(1013);
    const browser = await connect("/api/ws");
    const cli = await connect("/api/ws");
    const foreign = await connect("/api/foreign");
    await subscribe(foreign, "private", { kinds: ["content"], types: ["other-user.delta"] });
    pair.send({ type: "ping" });
    expect(await pair.next()).toEqual({ type: "pong" });
    const list = { kinds: ["state"], resources: ["documents"] };
    await subscribe(browser, "list", list);
    expect(await pair.next()).toEqual({ type: "interests", interests: [list] });
    await subscribe(cli, "shared-list", list);
    pair.send({ type: "ping" });
    expect(await pair.next()).toEqual({ type: "pong" });
    const stream = { kinds: ["content"], types: ["document.delta"], ids: ["remote:active"] };
    await subscribe(cli, "stream", stream);
    const snapshot = await pair.next();
    expect(snapshot).toEqual({ type: "interests", interests: expect.arrayContaining([list, stream]) });
    browser.send({ type: "unsubscribe", subscriptionId: "list", generation: 2 });
    expect(await browser.next()).toMatchObject({ type: "unsubscribed" });
    pair.send({ type: "ping" });
    expect(await pair.next()).toEqual({ type: "pong" });
    cli.send({ type: "unsubscribe", subscriptionId: "shared-list", generation: 2 });
    expect(await cli.next()).toMatchObject({ type: "unsubscribed" });
    expect(await pair.next()).toEqual({ type: "interests", interests: [stream] });
    pair.socket.close();
    await bounded(pair.closed, "paired transport cleanup");
    const reconnectedPair = await connect("/api/pair", true);
    expect(await reconnectedPair.next()).toEqual({ type: "interests", interests: [stream] });
    cli.socket.close();
    await bounded(cli.closed, "CLI disconnect");
    expect(await reconnectedPair.next()).toEqual({ type: "interests", interests: [] });
    reconnectedPair.send({ type: "ping" });
    expect(await reconnectedPair.next()).toEqual({ type: "pong" });
    await subscribe(browser, "active", list);
    expect(await reconnectedPair.next()).toEqual({ type: "interests", interests: [list] });
    const retired = await fetch(`${server.url.origin}/api/retire-source-runtime`, {
      method: "POST", signal: AbortSignal.timeout(5_000),
    });
    expect(retired.status).toBe(200);
    expect(await reconnectedPair.next()).toEqual({ type: "interests", interests: [] });
    const nextPair = await connect("/api/pair", true);
    expect(await nextPair.next()).toEqual({ type: "interests", interests: [] });
    const nextBrowser = await connect("/api/ws");
    await subscribe(nextBrowser, "failed-source", {
      kinds: ["content"], targets: { source: "unavailable" },
    });
    expect(await bounded(nextPair.closed, "failed source propagation closes its paired transport")).toBe(1011);
    nextBrowser.send({ type: "ping" });
    expect(await nextBrowser.next()).toEqual({ type: "pong" });
  } finally {
    for (const peer of peers) peer.socket.close();
    await app.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
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
