import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createWebAppServer, defineRoutes, jsonResponse, parseJson, parseOptionalJson, sqliteWebAppStore } from "@pablozaiden/webapp/server";

function testStore(name: string) {
  return sqliteWebAppStore({ dataDir: `.cache/tests/${name}-${crypto.randomUUID()}` });
}

async function responseJson<T>(response: Response | undefined): Promise<T> {
  expect(response).toBeDefined();
  return await response!.json() as T;
}

describe("request body validation", () => {
  test("accepts valid schema-backed application input", async () => {
    const itemSchema = z.object({ title: z.string().min(1) });
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_REQUEST_VALIDATION_VALID",
      store: testStore("request-validation-valid"),
      auth: { passkeys: false },
      routes: defineRoutes({
        "/api/items": {
          auth: "public",
          sameOrigin: "never",
          requestSchema: itemSchema,
          POST: async (req) => jsonResponse({ item: await parseJson(req, itemSchema) }),
        },
      }),
    });

    const response = await app.handleRequest(new Request("http://localhost/api/items", {
      method: "POST",
      body: JSON.stringify({ title: "First item" }),
    }));

    expect(response?.status).toBe(200);
    expect(await responseJson<{ item: { title: string } }>(response)).toEqual({ item: { title: "First item" } });
  });

  test("returns 400 for malformed JSON instead of accepting a default body", async () => {
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_REQUEST_VALIDATION_DEVICE",
      store: testStore("request-validation-device"),
      auth: { passkeys: false, deviceAuth: true },
      routes: defineRoutes({}),
    });

    const malformed = await app.handleRequest(new Request("http://localhost/api/auth/device", {
      method: "POST",
      body: "{",
    }));
    expect(malformed?.status).toBe(400);
    expect(await responseJson<{ error: string; message: string }>(malformed)).toEqual({
      error: "invalid_json",
      message: "Request body must be valid JSON",
    });

    const valid = await app.handleRequest(new Request("http://localhost/api/auth/device", {
      method: "POST",
      body: "{}",
    }));
    expect(valid?.status).toBe(200);
    expect(await valid?.json()).toMatchObject({ device_code: expect.any(String), user_code: expect.any(String) });
  });

  test("returns 400 for whitespace-only optional JSON bodies", async () => {
    const webhookSchema = z.object({ title: z.string().optional() });
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_REQUEST_VALIDATION_OPTIONAL",
      store: testStore("request-validation-optional"),
      auth: { passkeys: false },
      routes: defineRoutes({
        "/api/webhooks": {
          auth: "public",
          sameOrigin: "never",
          requestSchema: webhookSchema,
          POST: async (req) => jsonResponse({ body: (await parseOptionalJson(req, webhookSchema)) ?? null }),
        },
      }),
    });

    const whitespace = await app.handleRequest(new Request("http://localhost/api/webhooks", {
      method: "POST",
      body: " \n\t",
    }));
    expect(whitespace?.status).toBe(400);
    expect(await responseJson<{ error: string; message: string }>(whitespace)).toEqual({
      error: "invalid_json",
      message: "Request body must be valid JSON",
    });

    const empty = await app.handleRequest(new Request("http://localhost/api/webhooks", {
      method: "POST",
    }));
    expect(empty?.status).toBe(200);
    expect(await responseJson<{ body: null }>(empty)).toEqual({ body: null });
  });

  test("returns field details for schema-invalid application input", async () => {
    const itemSchema = z.object({ title: z.string().min(1) });
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_REQUEST_VALIDATION_INVALID",
      store: testStore("request-validation-invalid"),
      auth: { passkeys: false },
      routes: defineRoutes({
        "/api/items": {
          auth: "public",
          sameOrigin: "never",
          POST: async (req) => jsonResponse({ item: await parseJson(req, itemSchema) }),
        },
      }),
    });

    const response = await app.handleRequest(new Request("http://localhost/api/items", {
      method: "POST",
      body: JSON.stringify({ title: 42 }),
    }));
    const body = await responseJson<{ error: string; details: Array<{ path: Array<string | number> }> }>(response);

    expect(response?.status).toBe(400);
    expect(body.error).toBe("invalid_request_body");
    expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["title"] })]));
  });

  test("validates JSON content type and request byte limits", async () => {
    const itemSchema = z.object({ title: z.string().min(1) });
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_REQUEST_VALIDATION_LIMITS",
      store: testStore("request-validation-limits"),
      auth: { passkeys: false },
      routes: defineRoutes({
        "/api/items": {
          auth: "public",
          sameOrigin: "never",
          POST: async (req) => jsonResponse({
            item: await parseJson(req, itemSchema, { maxBytes: 100, requireContentType: true }),
          }),
        },
      }),
    });

    const valid = await app.handleRequest(new Request("http://localhost/api/items", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ title: "First item" }),
    }));
    expect(valid?.status).toBe(200);

    const invalidContentType = await app.handleRequest(new Request("http://localhost/api/items", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ title: "First item" }),
    }));
    expect(invalidContentType?.status).toBe(400);
    expect(await responseJson<{ error: string }>(invalidContentType)).toMatchObject({
      error: "invalid_request_content_type",
    });

    const declaredOversized = await app.handleRequest(new Request("http://localhost/api/items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "101",
      },
      body: JSON.stringify({ title: "First item" }),
    }));
    expect(declaredOversized?.status).toBe(413);
    expect(await responseJson<{ error: string }>(declaredOversized)).toMatchObject({
      error: "request_body_too_large",
    });

    const streamedOversized = await app.handleRequest(new Request("http://localhost/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"title":"'));
          controller.enqueue(new TextEncoder().encode("x".repeat(100)));
          controller.close();
        },
      }),
    }));
    expect(streamedOversized?.status).toBe(413);
    expect(await responseJson<{ error: string }>(streamedOversized)).toMatchObject({
      error: "request_body_too_large",
    });
  });

  test("rejects malformed content length as a structured client error", async () => {
    const itemSchema = z.object({ title: z.string().min(1) });
    const app = createWebAppServer({
      appName: "Test",
      envPrefix: "TEST_REQUEST_VALIDATION_LENGTH",
      store: testStore("request-validation-length"),
      auth: { passkeys: false },
      routes: defineRoutes({
        "/api/items": {
          auth: "public",
          sameOrigin: "never",
          POST: async (req) => jsonResponse({
            item: await parseJson(req, itemSchema, { maxBytes: 100 }),
          }),
        },
      }),
    });

    const response = await app.handleRequest(new Request("http://localhost/api/items", {
      method: "POST",
      headers: { "content-length": "not-a-number" },
      body: JSON.stringify({ title: "First item" }),
    }));
    expect(response?.status).toBe(400);
    expect(await responseJson<{ error: string }>(response)).toMatchObject({
      error: "invalid_request_content_length",
    });
  });

  test("validates framework preference fields at runtime", async () => {
    const envKey = "TEST_REQUEST_VALIDATION_PREFERENCE_DISABLE_PASSKEY";
    const previous = process.env[envKey];
    process.env[envKey] = "true";
    try {
      const app = createWebAppServer({
        appName: "Test",
        envPrefix: "TEST_REQUEST_VALIDATION_PREFERENCE",
        store: testStore("request-validation-preference"),
        auth: { passkeys: true },
        routes: defineRoutes({}),
      });

      const valid = await app.handleRequest(new Request("http://localhost/api/preferences/theme", {
        method: "PUT",
        headers: { origin: "http://localhost" },
        body: JSON.stringify({ theme: "dark" }),
      }));
      expect(valid?.status).toBe(200);
      expect(await responseJson<{ theme: string }>(valid)).toEqual({ theme: "dark" });

      const invalid = await app.handleRequest(new Request("http://localhost/api/preferences/theme", {
        method: "PUT",
        headers: { origin: "http://localhost" },
        body: JSON.stringify({ theme: "purple" }),
      }));
      expect(invalid?.status).toBe(400);
      expect(await responseJson<{ error: string }>(invalid)).toMatchObject({ error: "invalid_request_body" });

      const validLogLevel = await app.handleRequest(new Request("http://localhost/api/preferences/log-level", {
        method: "PUT",
        headers: { origin: "http://localhost" },
        body: JSON.stringify({ level: "debug" }),
      }));
      expect(validLogLevel?.status).toBe(200);
      expect(await responseJson<{ level: string }>(validLogLevel)).toEqual({ level: "debug" });

      const invalidLogLevel = await app.handleRequest(new Request("http://localhost/api/preferences/log-level", {
        method: "PUT",
        headers: { origin: "http://localhost" },
        body: JSON.stringify({ level: "verbose" }),
      }));
      expect(invalidLogLevel?.status).toBe(400);
      expect(await responseJson<{ error: string }>(invalidLogLevel)).toMatchObject({ error: "invalid_request_body" });
    } finally {
      if (previous === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previous;
      }
    }
  });
});
