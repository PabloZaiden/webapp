import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ApiKeySummary, CreatedApiKeyResponse, CreatedUserResponse, DeviceVerificationDetails, WebAppConfigResponse, WebAppUserSummary } from "../src/contracts";
import { DeviceVerificationScreen } from "../src/web/auth-screens";
import { configureWebAppClient } from "../src/web/api-client";
import { SecuritySection } from "../src/web/settings/security-section";
import { UserManagement } from "../src/web/settings/user-management";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost/" });
}

async function ensureHappyDom() {
  if (
    GlobalRegistrator.isRegistered
    && typeof document !== "undefined"
    && document.body
    && typeof window !== "undefined"
    && typeof window.history?.replaceState === "function"
  ) {
    return;
  }
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
  GlobalRegistrator.register({ url: "http://localhost/" });
}

beforeEach(ensureHappyDom);

afterEach(() => {
  cleanup();
  if (typeof document !== "undefined" && document.body) {
    document.body.innerHTML = "";
  }
  localStorage.clear();
  configureWebAppClient();
  window.history.replaceState(null, "", "http://localhost/");
});

afterAll(async () => {
  cleanup();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function requestPath(input: RequestInfo | URL): string {
  return requestUrl(input).pathname;
}

function requestUrl(input: RequestInfo | URL): URL {
  const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  return new URL(String(rawUrl), "http://localhost");
}

function requestMethod(init?: RequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(input, "value")?.set;
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  act(() => {
    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function deviceDetails(userCode: string, clientId: string): DeviceVerificationDetails {
  return {
    userCode,
    clientId,
    scope: "*",
    status: "pending",
    expiresAt: "2026-08-30T00:00:00.000Z",
    passkeyRequired: false,
  };
}

function apiKey(id: string): ApiKeySummary {
  return {
    id,
    name: "Browser key",
    prefix: "wapp_test",
    scopes: ["*"],
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

function createdUser(id: string): WebAppUserSummary {
  return {
    id,
    username: "alice",
    role: "user",
    passkeyConfigured: false,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function settingsConfig(overrides: Partial<WebAppConfigResponse> = {}): WebAppConfigResponse {
  return {
    appName: "Test App",
    version: "1.0.0",
    currentUser: { id: "owner", username: "owner", role: "owner", isOwner: true, isAdmin: true },
    passkeyAuth: {
      enabled: false,
      passkeyConfigured: false,
      passkeyDisabled: true,
      passkeyRequired: false,
      authenticated: true,
      bootstrapRequired: false,
      ownerPasskeySetupRequired: false,
    },
    userManagement: {
      enabled: false,
      canManageUsers: false,
    },
    logLevel: {
      level: "info",
      fromEnv: false,
    },
    inMemoryLogs: {
      enabled: false,
    },
    deviceAuth: {
      enabled: false,
    },
    apiKeys: {
      enabled: false,
    },
    ...overrides,
  };
}

test("device verification ignores an older lookup and gates actions on the current normalized code", async () => {
  const previousFetch = globalThis.fetch;
  const lookups = new Map<string, Deferred<Response>>();
  const requests: Array<{ path: string; method: string }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    const method = requestMethod(init);
    requests.push({ path, method });
    if (path === "/api/auth/device/verification") {
      const code = requestUrl(input).searchParams.get("user_code") ?? "";
      const response = deferred<Response>();
      lookups.set(code, response);
      return response.promise;
    }
    return Promise.resolve(Response.json({ error: "not_found", message: "Not found" }, { status: 404 }));
  }) as typeof fetch;

  window.history.replaceState(null, "", "http://localhost/device?user_code=old-code");
  try {
    const view = render(createElement(DeviceVerificationScreen));
    await waitFor(() => expect(lookups.has("OLD-CODE")).toBe(true));

    const input = view.getByLabelText("User code") as HTMLInputElement;
    setInputValue(input, "new-code");
    await waitFor(() => expect(lookups.has("NEW-CODE")).toBe(true));
    expect(input.value).toBe("NEW-CODE");
    expect((view.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      lookups.get("OLD-CODE")!.resolve(Response.json(deviceDetails("OLD-CODE", "old-client")));
    });
    expect(view.queryByText("old-client")).toBeNull();
    expect((view.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      lookups.get("NEW-CODE")!.resolve(Response.json(deviceDetails("NEW-CODE", "new-client")));
    });
    await waitFor(() => expect(view.getByText("new-client")).toBeTruthy());
    expect((view.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);

    setInputValue(input, "different-code");
    expect(view.queryByText("new-client")).toBeNull();
    expect((view.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests.filter((request) => request.path === "/api/auth/device/approve")).toHaveLength(0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("device decisions are single-flight and restore controls after a failure", async () => {
  const previousFetch = globalThis.fetch;
  const decisions = [deferred<Response>(), deferred<Response>()];
  let decisionCount = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (path === "/api/auth/device/verification") {
      return Promise.resolve(Response.json(deviceDetails("ABCD-2345", "test-client")));
    }
    if (path === "/api/auth/device/approve" && requestMethod(init) === "POST") {
      decisionCount += 1;
      return decisions[decisionCount - 1]!.promise;
    }
    return Promise.resolve(Response.json({ error: "not_found", message: "Not found" }, { status: 404 }));
  }) as typeof fetch;

  window.history.replaceState(null, "", "http://localhost/device?user_code=abcd-2345");
  try {
    const view = render(createElement(DeviceVerificationScreen));
    const approve = await waitFor(() => {
      const button = view.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });

    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(decisionCount).toBe(1);
    expect((view.getByLabelText("User code") as HTMLInputElement).disabled).toBe(true);
    expect((view.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      decisions[0]!.reject(new Error("Decision unavailable"));
    });
    await waitFor(() => expect(view.getByText("Decision unavailable")).toBeTruthy());
    expect((view.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(view.getByRole("button", { name: "Approve" }));
    expect(decisionCount).toBe(2);
    await act(async () => {
      decisions[1]!.resolve(Response.json({ ...deviceDetails("ABCD-2345", "test-client"), status: "approved" }));
    });
    await waitFor(() => expect(view.getByText("approved")).toBeTruthy());
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("API-key creation ignores repeated activation and displays the only created token", async () => {
  const previousFetch = globalThis.fetch;
  const creation = deferred<Response>();
  let createCount = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (path === "/api/api-keys" && requestMethod(init) === "GET") {
      return Promise.resolve(Response.json([]));
    }
    if (path === "/api/api-keys" && requestMethod(init) === "POST") {
      createCount += 1;
      return creation.promise;
    }
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;

  const errors: string[] = [];
  try {
    const view = render(createElement(SecuritySection, {
      config: settingsConfig({ apiKeys: { enabled: true } }),
      refresh: async () => {},
      setError: (error: string | undefined) => {
        if (error) {
          errors.push(error);
        }
      },
    }));
    const create = await waitFor(() => view.getByRole("button", { name: "Create API key" }) as HTMLButtonElement);

    fireEvent.click(create);
    fireEvent.click(create);
    expect(createCount).toBe(1);
    expect(create.disabled).toBe(true);

    const result: CreatedApiKeyResponse = { key: apiKey("key-1"), token: "secret-token" };
    await act(async () => {
      creation.resolve(Response.json(result));
    });
    await waitFor(() => expect(view.getByText("secret-token")).toBeTruthy());
    expect(errors).toEqual([]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("API-key creation revokes a successful key when the settings UI unmounts", async () => {
  const previousFetch = globalThis.fetch;
  const creation = deferred<Response>();
  const deletedIds: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (path === "/api/api-keys" && requestMethod(init) === "GET") {
      return Promise.resolve(Response.json([]));
    }
    if (path === "/api/api-keys" && requestMethod(init) === "POST") {
      return creation.promise;
    }
    if (path.startsWith("/api/api-keys/") && requestMethod(init) === "DELETE") {
      deletedIds.push(path.slice("/api/api-keys/".length));
      return Promise.resolve(Response.json({}));
    }
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;

  try {
    const view = render(createElement(SecuritySection, {
      config: settingsConfig({ apiKeys: { enabled: true } }),
      refresh: async () => {},
      setError: () => {},
    }));
    const create = await waitFor(() => view.getByRole("button", { name: "Create API key" }) as HTMLButtonElement);
    fireEvent.click(create);
    view.unmount();

    await act(async () => {
      creation.resolve(Response.json({ key: apiKey("orphaned-key"), token: "unpresentable-token" }));
    });
    await waitFor(() => expect(deletedIds).toEqual(["orphaned-key"]));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("user reset is single-flight and shares pending ownership with setup-link creation", async () => {
  const previousFetch = globalThis.fetch;
  const user = createdUser("user-1");
  const reset = deferred<Response>();
  let resetCount = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    const method = requestMethod(init);
    if (path === "/api/users" && method === "GET") {
      return Promise.resolve(Response.json([user]));
    }
    if (path === "/api/users/user-1/reset" && method === "POST") {
      resetCount += 1;
      return reset.promise;
    }
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;

  try {
    const view = render(createElement(UserManagement, {
      config: settingsConfig({ userManagement: { enabled: true, canManageUsers: true } }),
    }));
    const resetButton = await waitFor(() => view.getByRole("button", { name: "Reset" }) as HTMLButtonElement);
    const createButton = view.getByRole("button", { name: "Create setup link" }) as HTMLButtonElement;

    fireEvent.click(resetButton);
    fireEvent.click(resetButton);
    expect(resetCount).toBe(1);
    expect(resetButton.disabled).toBe(true);
    expect(createButton.disabled).toBe(true);

    const result: CreatedUserResponse = {
      user,
      setupLink: {
        url: "http://localhost/setup?token=current-reset",
        expiresAt: "2026-08-30T00:00:00.000Z",
      },
    };
    await act(async () => {
      reset.resolve(Response.json(result));
    });
    await waitFor(() => expect(view.getByText("http://localhost/setup?token=current-reset")).toBeTruthy());
    expect(resetCount).toBe(1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
