import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { createWebAppServer, defineRoutes, jsonResponse, memoryWebAppStore } from "@pablozaiden/webapp/server";
import { realtimeServerMessageSchema, type RealtimeServerMessage } from "@pablozaiden/webapp/contracts";
import { createRealtimeRuntime } from "../src/web/realtime/connection";
import { createVersionedSyncController, type VersionedSyncState } from "../src/web/realtime/versioned-sync";
import { createLiveQueryController } from "../src/web/realtime/query-controller";

function deferred<T>() {
  return Promise.withResolvers<T>();
}
async function bounded<T>(promise: Promise<T>, condition: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${condition}`)), 5_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(maxBufferedBytes?: number) {
  const directory = resolve(".cache/tests", `realtime-${crypto.randomUUID()}`);
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  let epoch = "first";
  let revision = 0;
  let text = "";
  let deferredDelta: Delta | undefined;
  let hold: ReturnType<typeof deferred<void>> | undefined;
  let snapshotStarted = deferred<void>();
  const app = createWebAppServer<Delta>({
    appName: "Realtime contract", envPrefix: "TEST_REALTIME", web: false,
    store: memoryWebAppStore(),
    runtimeConfig: {
      appName: "Realtime contract", envPrefix: "TEST_REALTIME", host: "127.0.0.1", port,
      dataDir: directory, logLevel: "error", logLevelFromEnv: false,
      passkeyDisabled: true, sameOriginDisabled: true,
      trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
    },
    realtime: { maxBufferedBytes },
    routes: defineRoutes<Delta>({
      "/api/document": {
        auth: "user", sameOrigin: "mutations",
        async GET() {
          const cut = { epoch, revision, data: text };
          snapshotStarted.resolve();
          if (hold) await hold.promise;
          return jsonResponse(cut);
        },
        async POST(req, ctx) {
          const input = await req.json() as { text: string; otherOwner?: boolean; defer?: boolean };
          const baseRevision = revision++;
          text += input.text;
          const delta: Delta = { type: "document.delta", epoch, baseRevision, revision, text: input.text };
          if (input.defer) deferredDelta = delta;
          else ctx.realtime.publish(delta, { target: { userId: input.otherOwner ? "another-owner" : ctx.requireUser().id, documentId: "active" } });
          ctx.userRealtime.publishEntityChanged("documents", "active", { scope: "workspace" });
          return jsonResponse({ revision });
        },
      },
      "/api/document/owner": {
        auth: "user", sameOrigin: "mutations",
        async POST(req, ctx) {
          const input = await req.json() as { epoch: string };
          epoch = input.epoch;
          revision = 0;
          ctx.userRealtime.publishEntityChanged("documents", "active");
          return jsonResponse({ epoch });
        },
      },
      "/api/document/flush": {
        auth: "user", sameOrigin: "mutations",
        POST(_req, ctx) {
          if (deferredDelta) {
            ctx.realtime.publish(deferredDelta, { target: { userId: ctx.requireUser().id, documentId: "active" } });
            deferredDelta = undefined;
          }
          return jsonResponse({ ok: true });
        },
      },
      "/api/connections": {
        auth: "user", sameOrigin: "mutations",
        GET: (_req, ctx) => jsonResponse({ count: ctx.realtime.connectionCount }),
      },
    }),
  });
  let server = await app.start();
  const base = server.url.origin;
  const sockets: WebSocket[] = [];
  return {
    app, base, url: base.replace("http:", "ws:") + "/api/ws",
    sockets,
    async mutate(value: string, otherOwner = false, defer = false) {
      const response = await fetch(`${base}/api/document`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: value, otherOwner, defer }), signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(200);
      await response.text();
    },
    hold() { hold = deferred<void>(); snapshotStarted = deferred<void>(); },
    observeSnapshot() { snapshotStarted = deferred<void>(); },
    started() { return bounded(snapshotStarted.promise, "snapshot request reached the server"); },
    release() { hold?.resolve(); hold = undefined; },
    async owner(nextEpoch: string) {
      const response = await fetch(`${base}/api/document/owner`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ epoch: nextEpoch }), signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(200);
      await response.text();
    },
    async flush() {
      const response = await fetch(`${base}/api/document/flush`, { method: "POST", signal: AbortSignal.timeout(5_000) });
      expect(response.status).toBe(200);
      await response.text();
    },
    async restart() {
      await app.stop(true);
      epoch = "second";
      revision = 0;
      text = "after restart";
      server = await app.start();
    },
    async cleanup() {
      hold?.resolve();
      for (const socket of sockets) socket.close();
      await app.stop(true);
      rmSync(directory, { force: true, recursive: true });
    },
  };
}
interface Delta {
  type: string;
  epoch: string;
  revision: number;
  baseRevision: number;
  text: string;
}
async function frames(url: string, sockets: WebSocket[]) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const opened = deferred<void>();
  const queue: RealtimeServerMessage[] = [];
  let notify = deferred<void>();
  socket.onopen = () => opened.resolve();
  socket.onerror = () => opened.reject(new Error("WebSocket failed to open"));
  socket.onmessage = event => {
    queue.push(realtimeServerMessageSchema.parse(JSON.parse(String(event.data))));
    notify.resolve();
  };
  await bounded(opened.promise, "WebSocket open");
  return {
    socket,
    send(frame: unknown) { socket.send(JSON.stringify(frame)); },
    async next(): Promise<RealtimeServerMessage> {
      while (!queue.length) {
        notify = deferred<void>();
        await bounded(notify.promise, "next WebSocket frame");
      }
      return queue.shift()!;
    },
  };
}

// Product contract: concurrent interests share a transport; server selectors only narrow
// authenticated delivery, and retirement/backpressure never silently lose live state.
test("dynamic authenticated interests, deduplicated routing, retirement and delivery failure", async () => {
  const running = await fixture(2_048);
  try {
    const client = await frames(running.url, running.sockets);
    await running.mutate("before subscriptions");
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    client.send({ type: "subscribe", subscriptionId: "list", generation: 1, interest: {
      kinds: ["state"], resources: ["documents"], actions: ["changed"], ids: ["active"], scopes: ["workspace"], types: ["documents.changed"],
    } });
    expect(await client.next()).toMatchObject({ type: "subscribed", subscriptionId: "list", generation: 1 });
    client.send({ type: "subscribe", subscriptionId: "detail", generation: 1, interest: {
      kinds: ["content"], types: ["document.delta"], targets: { documentId: ["active"] },
    } });
    expect(await client.next()).toMatchObject({ type: "subscribed", subscriptionId: "detail" });
    await running.mutate("visible");
    const content = await client.next();
    expect(content).toMatchObject({ type: "event", subscriptions: [{ subscriptionId: "detail", generation: 1 }], event: { text: "visible" } });
    expect(await client.next()).toMatchObject({ type: "event", subscriptions: [{ subscriptionId: "list", generation: 1 }] });
    client.send({ type: "subscribe", subscriptionId: "detail-overlap", generation: 1, interest: {
      kinds: ["content"], types: ["document.delta"],
    } });
    expect(await client.next()).toMatchObject({ type: "subscribed" });
    await running.mutate("overlap");
    expect(await client.next()).toMatchObject({
      type: "event", subscriptions: [{ subscriptionId: "detail", generation: 1 }, { subscriptionId: "detail-overlap", generation: 1 }],
      event: { text: "overlap" },
    });
    await client.next(); // The independently subscribed collection invalidation.
    await running.mutate("private", true);
    expect(await client.next()).toMatchObject({ type: "event", subscriptions: [{ subscriptionId: "list", generation: 1 }] });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    for (const subscriptionId of ["list", "detail", "detail-overlap"]) {
      client.send({ type: "unsubscribe", subscriptionId, generation: 2 });
      expect(await client.next()).toMatchObject({ type: "unsubscribed", subscriptionId, generation: 2 });
    }
    await running.mutate("no interests");
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    client.send({ type: "subscribe", subscriptionId: "large", generation: 1, interest: { kinds: ["content"], types: ["document.delta"] } });
    expect(await client.next()).toMatchObject({ type: "subscribed" });
    const closed = deferred<number>();
    client.socket.onclose = event => closed.resolve(event.code);
    await running.mutate("x".repeat(4_096));
    expect(await client.next()).toMatchObject({ type: "error", code: "backpressure" });
    expect(await bounded(closed.promise, "backpressured socket closes")).toBe(1013);

    const invalid = await frames(running.url, running.sockets);
    invalid.send({ type: "subscribe", subscriptionId: "ownership", generation: 1, interest: {
      kinds: ["content"], targets: { userId: "another-owner" },
    } });
    expect(await invalid.next()).toMatchObject({ type: "error", code: "invalid_message" });
  } finally {
    await running.cleanup();
  }
});

// Product contract: acknowledged activation precedes the baseline; mutations during
// reads are applied once, and reconnect/owner retirement establish authoritative epochs
// while late delivery from the previous owner cannot duplicate or roll back content.
test("one runtime synchronizes concurrent projections through snapshot races and server restart", async () => {
  const running = await fixture();
  const runtime = createRealtimeRuntime({ url: running.url });
  let state: VersionedSyncState<string> = { status: "idle" };
  let changed = deferred<void>();
  const errors: Error[] = [];
  const sync = createVersionedSyncController<string, Delta>({
    load: async ({ signal }) => {
      const response = await fetch(`${running.base}/api/document`, { signal });
      return await response.json() as { epoch: string; revision: number; data: string };
    },
    version: event => event,
    reduce: (value, event) => value + event.text,
    onChange: next => { state = next; changed.resolve(); },
    maxBufferedEvents: 2,
  });
  async function waitState(predicate: () => boolean, condition: string) {
    while (!predicate()) {
      changed = deferred<void>();
      await bounded(changed.promise, `${condition}; last state=${JSON.stringify(state)}`);
    }
  }
  running.hold();
  const unsubscribeDetail = runtime.subscribe<Delta>({
    interest: { kinds: ["content"], types: ["document.delta"], targets: { documentId: "active" } },
    onSubscribed: activation => sync.activate(activation),
    onStatus: status => { if (status !== "open") sync.deactivate(); },
    onEvent: event => sync.receive(event), onError: error => errors.push(error),
  });
  const activated = deferred<void>();
  const unsubscribeList = runtime.subscribe({
    interest: { kinds: ["state"], resources: ["documents"] },
    onSubscribed: () => activated.resolve(), onEvent: () => {}, onError: error => errors.push(error),
  });
  try {
    await bounded(activated.promise, "second subscription activates on shared socket");
    expect(await (await fetch(`${running.base}/api/connections`)).json()).toEqual({ count: 1 });
    await running.started();
    const queuedRefresh = sync.refresh();
    await running.mutate("during read");
    running.release();
    await queuedRefresh;
    await waitState(() => state.status === "live" && state.revision === 1, "snapshot and buffered delta converge");
    expect(state.data).toBe("during read");
    await running.mutate(" live");
    await waitState(() => state.revision === 2, "live delta advances");
    expect(state.data).toBe("during read live");
    running.hold();
    const refreshing = sync.refresh();
    await running.started();
    await running.mutate(" one");
    await running.mutate(" two");
    await running.mutate(" three");
    running.release();
    await refreshing;
    await waitState(() => state.status === "live" && state.revision === 5, "a full temporary buffer recovers an authoritative baseline");
    expect(state.data).toBe("during read live one two three");
    await running.restart();
    await waitState(() => state.status === "live" && state.epoch === "second", "reconnect establishes a new baseline");
    expect(state.data).toBe("after restart");
    expect(state.revision).toBe(0);
    await running.mutate(" restored");
    await waitState(() => state.epoch === "second" && state.revision === 1, "restored interest receives live deltas");
    expect(state.data).toBe("after restart restored");
    await running.owner("cold");
    await sync.refresh();
    expect(state).toMatchObject({ status: "live", epoch: "cold", revision: 0, data: "after restart restored" });
    running.hold();
    const replacingOwner = sync.refresh();
    await running.started();
    await running.owner("active-next");
    await running.mutate(" tail");
    await running.owner("cold-next");
    running.release();
    await replacingOwner;
    expect(state).toMatchObject({ status: "live", epoch: "cold-next", revision: 0, data: "after restart restored tail" });
    await running.owner("active-final");
    await sync.refresh();
    await running.mutate(" delayed", false, true);
    await running.owner("cold-final");
    await sync.refresh();
    running.observeSnapshot();
    await running.flush();
    await running.started();
    await sync.refresh();
    expect(state).toMatchObject({ status: "live", epoch: "cold-final", revision: 0, data: "after restart restored tail delayed" });
  } finally {
    unsubscribeDetail();
    unsubscribeList();
    sync.dispose();
    runtime.dispose();
    await running.cleanup();
  }
});

// Product contract: authoritative collections preserve loaded data while recovering,
// coalesce invalidations, and never undo a mutation with a preceding HTTP read.
test("authoritative queries coalesce reads and serialize mutation reconciliation", async () => {
  const running = await fixture();
  const runtime = createRealtimeRuntime({ url: running.url });
  const query = createLiveQueryController<{ data: string }>({
    load: async (signal) => {
      const response = await fetch(`${running.base}/api/document`, { signal });
      return await response.json() as { data: string };
    },
    onChange: () => {},
  });
  const activated = deferred<void>();
  running.hold();
  const unsubscribe = runtime.subscribe({
    interest: { kinds: ["state"], resources: ["documents"] },
    onSubscribed: async () => { await query.activate(); activated.resolve(); },
    onStatus: status => { if (status !== "open") query.deactivate(); },
    onEvent: () => { void query.invalidate(); },
  });
  try {
    await running.started();
    await running.mutate("A");
    await running.mutate("B");
    running.release();
    await bounded(activated.promise, "dirty authoritative query converges");
    expect(query.getState()).toMatchObject({ data: { data: "AB" }, loading: false });
    running.hold();
    const precedingRead = query.invalidate();
    await running.started();
    const mutationFinished = deferred<void>();
    const mutation = query.mutate(async signal => {
      expect(signal.aborted).toBe(false);
      await running.mutate("C");
      mutationFinished.resolve();
      return "C";
    }, (previous, result) => ({ data: previous!.data + result }));
    await bounded(mutationFinished.promise, "mutation request completes before releasing older snapshot");
    running.release();
    await bounded(mutation, "mutation and queued authoritative refresh complete");
    await precedingRead;
    expect(query.getState()).toMatchObject({ data: { data: "ABC" }, loading: false });
  } finally {
    unsubscribe();
    query.deactivate();
    runtime.dispose();
    await running.cleanup();
  }
});
