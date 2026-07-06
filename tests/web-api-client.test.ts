import { describe, expect, test } from "bun:test";
import {
  WebAppApiError,
  appAbsoluteUrl,
  appFetch,
  appPath,
  appRequest,
  appWebSocketUrl,
  configureWebAppClient,
  getWebAppPublicBasePath,
  onAuthRequired,
  setWebAppPublicBasePath,
} from "../src/web/api-client";

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
      } satisfies Partial<WebAppApiError>);
      expect(events).toEqual(["auth"]);
    } finally {
      unsubscribe();
      globalThis.fetch = previousFetch;
    }
  });
});
