import { expect, test } from "bun:test";
import { z } from "zod";
import {
  createWebAppServer, defineRoutes, jsonResponse, parseJson, readRuntimeConfig,
} from "@pablozaiden/webapp/server";

test("app-owned identity, policy and request/socket dispatch compose at the public listener", async () => {
  const config = readRuntimeConfig({ appName: "Core", envPrefix: "CORE_TEST", environment: {
    CORE_TEST_HOST: "127.0.0.1", CORE_TEST_PORT: "0", CORE_TEST_LOG_LEVEL: "error", NODE_ENV: "production",
  } });
  const app = createWebAppServer<unknown, { tenant: string }>({
    appName: "Core", envPrefix: "CORE_TEST", runtimeConfig: config, web: false,
    identity: {
      authenticate: req => req.headers.get("authorization") === "explicit"
        ? { identity: { tenant: "A" }, credential: "explicit" }
        : req.headers.get("cookie") === "app=ambient"
          ? { identity: { tenant: "A" }, credential: "ambient" } : undefined,
      authorize: (_req, identity, operation) => operation.policy === undefined || operation.params["tenant"] === identity.tenant,
    },
    request(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/legacy") return new Response("app dispatch");
      if (path === "/raw" && server?.upgrade(req, { data: { webappSocketHandler: "echo" } })) return undefined;
      return undefined;
    },
    websockets: { echo: { message(socket, message) { socket.send(message); } } },
    routes: defineRoutes<unknown, { tenant: string }>({
      "/api/public": { auth: "public", GET: () => jsonResponse({ public: true }) },
      "/api/tenants/:tenant": { policy: "tenant", GET: (_req, ctx) => jsonResponse(ctx.requireIdentity()) },
      "/api/write": {
        async POST(req, ctx) {
          ctx.requireIdentity();
          return jsonResponse(await parseJson(req, z.object({ name: z.string().min(1) })));
        },
      },
    }),
  });
  const server = await app.start();
  const url = (path: string) => new URL(path, server.url);
  try {
    expect(await (await fetch(url("/legacy"))).text()).toBe("app dispatch");
    expect(await (await fetch(url("/api/public"))).json()).toEqual({ public: true });
    expect((await fetch(url("/api/tenants/A"))).status).toBe(401);
    for (const headers of [new Headers({ authorization: "explicit" }), new Headers({ cookie: "app=ambient" })]) {
      expect((await fetch(url("/api/tenants/A"), { headers })).status).toBe(200);
      expect((await fetch(url("/api/tenants/B"), { headers })).status).toBe(403);
    }
    const body = JSON.stringify({ name: "Allowed", forbidden: "not assigned" });
    expect((await fetch(url("/api/write"), { method: "POST", headers: { cookie: "app=ambient" }, body })).status).toBe(403);
    const write = await fetch(url("/api/write"), {
      method: "POST", headers: { cookie: "app=ambient", origin: server.url.origin }, body,
    });
    expect(await write.json()).toEqual({ name: "Allowed" });
    expect((await fetch(url("/api/write"), { method: "POST", headers: { authorization: "explicit" }, body: "{" })).status).toBe(400);
    expect((await fetch(url("/api/tenants/A"), { method: "DELETE", headers: { authorization: "explicit" } })).status).toBe(405);
    const opened = Promise.withResolvers<string>();
    const socket = new WebSocket(url("/raw").toString().replace("http:", "ws:"));
    socket.onopen = () => socket.send("app socket");
    socket.onmessage = event => opened.resolve(String(event.data));
    socket.onerror = () => opened.reject(new Error("Custom socket failed"));
    try { expect(await opened.promise).toBe("app socket"); } finally { socket.close(); }
  } finally { await app.stop(true); }
});
