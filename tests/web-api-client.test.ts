import { afterEach, describe, expect, test } from "bun:test";
import {
  WebAppApiError,
  appAbsoluteUrl,
  appFetch,
  appJson,
  appPagePath,
  appPath,
  appRequest,
  appWebSocketUrl,
  configureWebAppClient,
  getWebAppPublicBasePath,
  isWebAppPublicBasePath,
  onAuthRequired,
  setWebAppPublicBasePath,
} from "../src/web/api-client";

afterEach(() => {
  configureWebAppClient();
});

function installDom(url = "https://example.test/", baseHref?: string): void {
  Object.defineProperty(globalThis, "window", { value: { location: { href: url } }, configurable: true });
  Object.defineProperty(globalThis, "document", {
    value: {
      querySelector: (selector: string) => selector === "base" && baseHref
        ? { getAttribute: (name: string) => name === "href" ? baseHref : null }
        : null,
    },
    configurable: true,
  });
}

afterEach(() => {
  configureWebAppClient();
});

describe("web API client", () => {
  test("builds app-relative URLs from the current document path by default", () => {
    configureWebAppClient();
    installDom("https://example.test/prefix/workspaces");

    expect(appPath("/api/items")).toBe("https://example.test/prefix/api/items");
    expect(appAbsoluteUrl("/#/workspace")).toBe("https://example.test/prefix/#/workspace");
    expect(appWebSocketUrl("/api/ws")).toBe("wss://example.test/prefix/api/ws");
  });

  test("builds app-relative HTTP and websocket URLs", () => {
    configureWebAppClient();
    installDom("https://example.test/prefix/", "https://example.test/prefix/");

    expect(appPath("/api/items")).toBe("https://example.test/prefix/api/items");
    expect(appWebSocketUrl("/api/ws")).toBe("wss://example.test/prefix/api/ws");
  });

  test("resolves public page, API, and websocket paths under root and prefixes", () => {
    installDom("https://example.test/tools/notes/setup?token=setup-token#stale");
    configureWebAppClient({ publicBasePath: "/tools/notes" });

    expect(appPagePath("/")).toBe("/tools/notes/");
    expect(appPagePath("/setup")).toBe("/tools/notes/setup");
    expect(appPagePath("/device?user_code=AB CD#fragment")).toBe("/tools/notes/device?user_code=AB%20CD#fragment");
    expect(appPath("/api/items?tag=one#fragment")).toBe("https://example.test/tools/notes/api/items?tag=one#fragment");
    expect(appWebSocketUrl("/api/ws")).toBe("wss://example.test/tools/notes/api/ws");

    installDom("https://example.test/");
    configureWebAppClient({ publicBasePath: "/" });
    expect(appPagePath("/setup")).toBe("/setup");
    expect(appPath("/api/items")).toBe("https://example.test/api/items");
    expect(appWebSocketUrl("/api/ws")).toBe("wss://example.test/api/ws");
  });

  test("rejects public base paths with literal or encoded dot segments", () => {
    expect(isWebAppPublicBasePath("/")).toBe(true);
    expect(isWebAppPublicBasePath("/tools/notes")).toBe(true);

    for (const value of [
      "/.",
      "/..",
      "/tools/./notes",
      "/tools/../notes",
      "/tools/%2e/notes",
      "/tools/%2E%2E/notes",
    ]) {
      expect(isWebAppPublicBasePath(value)).toBe(false);
    }
  });

  test("uses configured public and API base URLs", async () => {
    installDom("https://example.test/ignored");
    configureWebAppClient({
      publicBasePath: "/configured",
      apiBaseUrl: "https://api.example.test/root/",
      wsBaseUrl: "https://ws.example.test/socket-root/",
    });
    const previousFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    try {
      expect(getWebAppPublicBasePath()).toBe("/configured");
      expect(appPath("/api/items")).toBe("https://api.example.test/api/items");
      expect(appAbsoluteUrl("/#/workspace")).toBe("https://example.test/configured/#/workspace");
      expect(appWebSocketUrl("/api/ws")).toBe("wss://ws.example.test/api/ws");
      expect((await appRequest("/api/items")).ok).toBe(true);
      expect(requested).toEqual(["https://api.example.test/api/items"]);
    } finally {
      globalThis.fetch = previousFetch;
      setWebAppPublicBasePath(undefined);
      configureWebAppClient();
    }
  });

  test("preserves explicit websocket protocols", () => {
    installDom("https://example.test/");

    configureWebAppClient({ wsBaseUrl: "wss://ws.example.test/root" });
    expect(appWebSocketUrl("/api/ws")).toBe("wss://ws.example.test/api/ws");

    configureWebAppClient({ wsBaseUrl: "ws://localhost:1234/root" });
    expect(appWebSocketUrl("/api/ws")).toBe("ws://localhost:1234/api/ws");

    configureWebAppClient();
    expect(appWebSocketUrl("wss://external.example.test/socket")).toBe("wss://external.example.test/socket");
    expect(appWebSocketUrl("ws://localhost:1234/socket")).toBe("ws://localhost:1234/socket");
  });

  test("appJson uses configured URLs and preserves request headers", async () => {
    installDom("https://example.test/ignored");
    configureWebAppClient({ apiBaseUrl: "https://api.example.test/root" });
    const previousFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    try {
      await expect(appJson<{ ok: boolean }>("/api/items", {
        method: "POST",
        body: "{}",
        headers: {
          accept: "text/plain",
          "content-type": "application/custom+json",
          "x-request-id": "request-1",
        },
      })).resolves.toEqual({ ok: true });
      expect(requestedUrl).toBe("https://api.example.test/api/items");
      expect(requestedInit?.credentials).toBe("same-origin");
      const headers = new Headers(requestedInit?.headers);
      expect(headers.get("accept")).toBe("text/plain");
      expect(headers.get("content-type")).toBe("application/custom+json");
      expect(headers.get("x-request-id")).toBe("request-1");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("appJson only sets a default content type when a request has a body", async () => {
    configureWebAppClient({ apiBaseUrl: "https://api.example.test" });
    installDom();
    const previousFetch = globalThis.fetch;
    const requestHeaders: Headers[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders.push(new Headers(init?.headers));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    try {
      await appJson("/api/items");
      await appJson("/api/items", { method: "POST", body: "{}" });

      expect(requestHeaders[0]?.get("content-type")).toBeNull();
      expect(requestHeaders[1]?.get("content-type")).toBe("application/json");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("appJson rejects successful responses without a JSON body", async () => {
    configureWebAppClient();
    installDom();
    const previousFetch = globalThis.fetch;
    const responses = [
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response(null, { status: 204 }),
    ];
    globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;

    try {
      await expect(appJson("/api/non-json")).rejects.toBeInstanceOf(SyntaxError);
      await expect(appJson("/api/empty")).rejects.toBeInstanceOf(SyntaxError);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("normalizes JSON errors and emits auth-required events", async () => {
    configureWebAppClient();
    installDom("https://example.test/prefix/", "https://example.test/prefix/");
    const previousFetch = globalThis.fetch;
    const events: string[] = [];
    const unsubscribe = onAuthRequired(() => events.push("auth"));
    globalThis.fetch = (async () => Response.json(
      { error: "authentication_required", message: "Login required", details: { reason: "passkey" } },
      { status: 401, headers: { "x-webapp-passkey-required": "true" } },
    )) as unknown as typeof fetch;

    try {
      await expect(appFetch("/api/items")).rejects.toMatchObject({
        name: "WebAppApiError",
        status: 401,
        error: "authentication_required",
        message: "Login required",
        details: { reason: "passkey" },
      } satisfies Partial<WebAppApiError>);
      expect(events).toEqual(["auth"]);
    } finally {
      unsubscribe();
      globalThis.fetch = previousFetch;
    }
  });
});
