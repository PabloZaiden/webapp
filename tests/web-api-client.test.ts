import { describe, expect, test } from "bun:test";
import { WebAppApiError, appPath, appWebSocketUrl, appFetch, onAuthRequired } from "../src/web/api-client";

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
  test("builds app-relative HTTP and websocket URLs", () => {
    installDom("https://example.test/prefix/", "https://example.test/prefix/");

    expect(appPath("/api/items")).toBe("https://example.test/prefix/api/items");
    expect(appWebSocketUrl("/api/ws")).toBe("wss://example.test/prefix/api/ws");
  });

  test("normalizes JSON errors and emits auth-required events", async () => {
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
