import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  createWebAppServer, defineRoutes, errorResponse, jsonResponse, memoryWebAppStore, parseJson,
  type DelegatedDispatchOptions,
} from "@pablozaiden/webapp/server";

class DocumentPolicyError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super("Document policy rejected this operation");
    this.name = "DocumentPolicyError";
  }
}

// Public contract: applications map domain failures at the admitted transport
// boundary without converting framework denials or executing rejected writes.
test("delegated application errors map safely before admission and during execution", async () => {
  const directory = resolve(".cache/tests", `delegation-errors-${crypto.randomUUID()}`);
  let text = "original";
  const app = createWebAppServer({
    appName: "Delegated errors", envPrefix: "TEST_DELEGATED_ERRORS", web: false,
    store: memoryWebAppStore(),
    runtimeConfig: {
      appName: "Delegated errors", envPrefix: "TEST_DELEGATED_ERRORS", host: "127.0.0.1", port: 0,
      dataDir: directory, logLevel: "error", logLevelFromEnv: false,
      passkeyDisabled: true, sameOriginDisabled: false,
      trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
    },
    routes: defineRoutes({
      "/api/documents/:id": {
        auth: "user", sameOrigin: "mutations",
        delegation: { resource: "document", action: "write" },
        async PUT(req, ctx) {
          const input = await parseJson(req, z.object({ text: z.string() }));
          if (ctx.params["id"] === "handler-denied") throw new DocumentPolicyError("document_locked", 409);
          if (ctx.params["id"] === "framework-owner") ctx.requireOwner();
          text = input.text;
          return jsonResponse({ text });
        },
      },
      "/api/document": {
        auth: "user", sameOrigin: "mutations",
        GET: () => jsonResponse({ text }),
      },
    }),
  });
  const server = await app.start();
  const options: DelegatedDispatchOptions<{ ownerId: string }> = {
    actor: { id: "guest", username: "Guest", role: "user", isAdmin: false, isOwner: false },
    async authorize(operation) {
      if (operation.params["id"] === "grant-denied") return false;
      if (["unshared document", "hook-failed-authorize"].includes(operation.params["id"]!)) {
        throw new DocumentPolicyError("document_not_shared", 403);
      }
      return { ownerId: "controller-owner" };
    },
    async run(invocation, invoke) {
      if (["admin-change", "hook-failed-run"].includes(invocation.operation.params["id"]!)) {
        throw new DocumentPolicyError("workspace_admin_required", 403);
      }
      return await invoke();
    },
    async onError(error, operation) {
      if (operation.params["id"]?.startsWith("hook-failed")) {
        throw new Error("Private hook failure details must not be disclosed");
      }
      if (error instanceof DocumentPolicyError) {
        return errorResponse(error.status, error.code, "The operation is not permitted", {
          path: operation.path, method: operation.method, id: operation.params["id"],
        });
      }
      // Framework denials and validation must never be replaced by this response.
      return jsonResponse({ mapped: true });
    },
  };
  const relay = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer admitted-relay") return new Response(null, { status: 401 });
      return await app.dispatchDelegated(req, options) ?? new Response(null, { status: 204 });
    },
  });
  const update = (id: string, body = JSON.stringify({ text: "rejected write" })) => fetch(
    `${relay.url.origin}/api/documents/${encodeURIComponent(id)}`,
    {
      method: "PUT", headers: { authorization: "Bearer admitted-relay", "content-type": "application/json" },
      body, signal: AbortSignal.timeout(5_000),
    },
  );
  try {
    for (const [id, status, code] of [
      ["unshared document", 403, "document_not_shared"],
      ["admin-change", 403, "workspace_admin_required"],
      ["handler-denied", 409, "document_locked"],
    ] as const) {
      const response = await update(id);
      expect(response.status, id).toBe(status);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(await response.json()).toMatchObject({
        error: code, details: { path: "/api/documents/:id", method: "PUT", id },
      });
    }
    for (const id of ["hook-failed-authorize", "hook-failed-run"]) {
      const response = await update(id);
      expect(response.status, id).toBe(500);
      expect(await response.json()).toEqual({ error: "request_failed", message: "Request failed" });
    }
    const denied = await update("grant-denied");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "delegation_forbidden" });
    const ownerOnly = await update("framework-owner");
    expect(ownerOnly.status).toBe(403);
    expect(await ownerOnly.json()).toMatchObject({ error: "owner_required" });
    const invalid = await update("invalid-body", "{");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_json" });
    const ordinary = await fetch(`${server.url.origin}/api/documents/handler-denied`, {
      method: "PUT", headers: { origin: server.url.origin, "content-type": "application/json" },
      body: JSON.stringify({ text: "ordinary rejected write" }), signal: AbortSignal.timeout(5_000),
    });
    expect(ordinary.status).toBe(500);
    expect(await ordinary.json()).toEqual({ error: "request_failed", message: "Request failed" });
    const state = await fetch(`${server.url.origin}/api/document`, { signal: AbortSignal.timeout(5_000) });
    expect(await state.json()).toEqual({ text: "original" });
  } finally {
    await relay.stop(true);
    await app.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
