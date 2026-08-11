import { describe, expect, test } from "bun:test";
import {
  runWebSocketCliCommand,
  type CliWebSocket,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";

function credentials(): StoredDeviceCredentials {
  const now = new Date().toISOString();
  return {
    baseUrl: "https://app.example.test",
    clientId: "cli",
    accessToken: "access",
    refreshToken: "refresh",
    tokenType: "Bearer",
    scope: "*",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

class TestWebSocket implements CliWebSocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: never) => void>>();

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: ((event: never) => void) | (() => void),
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event: never) => void);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: unknown = undefined): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as never);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.emit("message", { data: "{\"received\":true}" });
    this.emit("close", { code, reason });
  }
}

describe("raw websocket CLI command", () => {
  test("uses profile auth, sends JSON lines, and writes text frames unchanged", async () => {
    const socket = new TestWebSocket();
    const output: string[] = [];
    let requestUrl = "";
    let authorized = false;
    const resultPromise = runWebSocketCliCommand({
      credentials: {
        read: async () => credentials(),
        write: async () => undefined,
      },
      realtimePath: "/api/custom-realtime",
      input: {
        async *[Symbol.asyncIterator]() {
          yield "{\"first\":1}\n{\"second\":2}\n";
        },
      },
      output: { write: (chunk) => output.push(chunk) },
      createWebSocket: (url, options) => {
        requestUrl = url;
        authorized = options.headers.has("authorization");
        queueMicrotask(() => socket.emit("open"));
        return socket;
      },
      signals: {
        on: () => undefined,
        off: () => undefined,
      },
    });

    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(requestUrl).toBe("wss://app.example.test/api/custom-realtime");
    expect(authorized).toBe(true);
    expect(socket.sent).toEqual(["{\"first\":1}", "{\"second\":2}"]);
    expect(output.join("")).toBe("{\"received\":true}");
  });

  test("adds the authenticated origin to websocket requests", async () => {
    const socket = new TestWebSocket();
    let origin = "";
    const resultPromise = runWebSocketCliCommand({
      credentials: {
        read: async () => credentials(),
        write: async () => undefined,
      },
      realtimePath: "/api/ws",
      input: {
        async *[Symbol.asyncIterator]() {
          return;
        },
      },
      output: { write: () => undefined },
      createWebSocket: (_url, options) => {
        origin = options.headers.get("origin") ?? "";
        queueMicrotask(() => socket.emit("open"));
        return socket;
      },
      signals: {
        on: () => undefined,
        off: () => undefined,
      },
    });

    expect(await resultPromise).toEqual({ exitCode: 0 });
    expect(origin).toBe("https://app.example.test");
  });

  test("reports abnormal closes without interpreting application events", async () => {
    const socket = new TestWebSocket();
    socket.close = () => undefined;
    const resultPromise = runWebSocketCliCommand({
      credentials: {
        read: async () => credentials(),
        write: async () => undefined,
      },
      realtimePath: "/api/ws",
      input: {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => undefined);
        },
      },
      output: { write: () => undefined },
      createWebSocket: () => {
        queueMicrotask(() => socket.emit("close", {
          code: 1006,
          reason: "network lost",
        }));
        return socket;
      },
      signals: {
        on: () => undefined,
        off: () => undefined,
      },
    });

    expect(await resultPromise).toEqual({
      exitCode: 1,
      error: "WebSocket closed abnormally (1006: network lost)",
    });
  });

  test("closes cleanly on signals and reports connection errors", async () => {
    const signalSocket = new TestWebSocket();
    let signal: (() => void) | undefined;
    const signaled = runWebSocketCliCommand({
      credentials: {
        read: async () => credentials(),
        write: async () => undefined,
      },
      realtimePath: "/api/ws",
      input: {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => undefined);
        },
      },
      output: { write: () => undefined },
      createWebSocket: () => {
        queueMicrotask(() => {
          signalSocket.emit("open");
          signal?.();
        });
        return signalSocket;
      },
      signals: {
        on: (name, listener) => {
          if (name === "SIGINT") signal = listener;
        },
        off: () => undefined,
      },
    });

    expect(await signaled).toEqual({ exitCode: 0 });

    const errorSocket = new TestWebSocket();
    const failed = runWebSocketCliCommand({
      credentials: {
        read: async () => credentials(),
        write: async () => undefined,
      },
      realtimePath: "/api/ws",
      input: {
        async *[Symbol.asyncIterator]() {
          return;
        },
      },
      output: { write: () => undefined },
      createWebSocket: () => {
        queueMicrotask(() => errorSocket.emit("error"));
        return errorSocket;
      },
      signals: {
        on: () => undefined,
        off: () => undefined,
      },
    });

    expect(await failed).toEqual({
      exitCode: 1,
      error: "WebSocket connection failed",
    });
  });
});
