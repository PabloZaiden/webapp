import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { LogLevelName, WebAppConfigResponse } from "../src/contracts";
import { configureWebAppClient } from "../src/web/api-client";
import { useLogLevel } from "../src/web";
import { WebAppRoot } from "../src/web/WebAppRoot";
import { configureWebAppRenderer } from "../src/web/render";
import type { WebAppRootProps } from "../src/web/root-types";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
configureWebAppRenderer(createRoot);

beforeEach(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
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

function makeConfig(level: LogLevelName = "info", fromEnv = false, inMemoryLogsEnabled = false, isAdmin = true): WebAppConfigResponse {
  return {
    appName: "Test App",
    version: "1.0.0",
    currentUser: {
      id: isAdmin ? "owner" : "user",
      username: isAdmin ? "owner" : "user",
      role: isAdmin ? "owner" : "user",
      isOwner: isAdmin,
      isAdmin,
    },
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
    logLevel: { level, fromEnv },
    inMemoryLogs: { enabled: inMemoryLogsEnabled },
    deviceAuth: { enabled: false },
    apiKeys: { enabled: false },
  };
}

function fetchPath(input: RequestInfo | URL): string {
  const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  return new URL(String(rawUrl), "http://localhost").pathname;
}

type FetchHandler = (path: string, init?: RequestInit) => Response | Promise<Response>;

function installFetch(handler: FetchHandler): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(fetchPath(input), init)) as typeof fetch;
  return () => {
    globalThis.fetch = previousFetch;
  };
}

function LogLevelProbe() {
  const { level, fromEnv, loading, error, retry } = useLogLevel();
  const state = error
    ? `error:${level ?? "missing"}`
    : loading
      ? "loading"
      : `${level ?? "missing"}:${fromEnv ? "locked" : "open"}`;
  return createElement(
    "div",
    null,
    createElement("p", { "aria-label": "log level state" }, state),
    createElement("button", { type: "button", onClick: () => void retry() }, "Refresh log level"),
  );
}

function renderApp(settings?: WebAppRootProps["settings"]) {
  return render(createElement(WebAppRoot, {
    appName: "Test App",
    homeRoute: { view: "home" },
    sidebar: {
      search: false,
      pinning: false,
      getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
    },
    routes: {
      home: createElement(LogLevelProbe),
    },
    settings,
  }));
}

describe("web log-level state", () => {
  test("exposes effective state from the shared config request without a preference fetch", async () => {
    const requests: string[] = [];
    const restoreFetch = installFetch((path) => {
      requests.push(path);
      if (path === "/api/config") return Response.json(makeConfig("debug", true));
      if (path === "/api/preferences/theme") return Response.json({ theme: "system" });
      return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
    });

    try {
      const view = renderApp();
      await waitFor(() => expect(view.getByLabelText("log level state").textContent).toBe("debug:locked"));
      expect(requests.filter((path) => path === "/api/config")).toHaveLength(1);
      expect(requests.includes("/api/preferences/log-level")).toBe(false);
    } finally {
      restoreFetch();
    }
  });

  test("updates hook consumers after the Settings selector saves a new level", async () => {
    let configCalls = 0;
    let putCalls = 0;
    const restoreFetch = installFetch((path, init) => {
      if (path === "/api/config") {
        configCalls += 1;
        return Response.json(makeConfig(configCalls === 1 ? "info" : "warn"));
      }
      if (path === "/api/preferences/theme") return Response.json({ theme: "system" });
      if (path === "/api/preferences/log-level" && init?.method === "PUT") {
        putCalls += 1;
        return Response.json({ level: "warn" });
      }
      return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
    });

    try {
      const view = renderApp({
        sections: [{
          id: "log-level-probe",
          title: "Log level probe",
          render: () => createElement(LogLevelProbe),
        }],
      });
      await waitFor(() => expect(view.getByLabelText("log level state").textContent).toBe("info:open"));
      fireEvent.click(await waitFor(() => view.getByLabelText("Open settings")));
      const selector = await waitFor(() => view.getByLabelText(/Log level/));
      fireEvent.change(selector, { target: { value: "warn" } });

      await waitFor(() => expect(view.getByLabelText("log level state").textContent).toBe("warn:open"));
      expect((selector as HTMLSelectElement).value).toBe("warn");
      expect(putCalls).toBe(1);
      expect(configCalls).toBe(2);
    } finally {
      restoreFetch();
    }
  });

  test("updates in-memory log storage from the Developer Settings control", async () => {
    let configCalls = 0;
    let putCalls = 0;
    const restoreFetch = installFetch((path, init) => {
      if (path === "/api/config") {
        configCalls += 1;
        return Response.json(makeConfig("info", false, configCalls > 1));
      }
      if (path === "/api/preferences/theme") return Response.json({ theme: "system" });
      if (path === "/api/server/logs/settings" && init?.method === "PUT") {
        putCalls += 1;
        return Response.json({ enabled: true });
      }
      return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
    });

    try {
      const view = renderApp();
      await waitFor(() => expect(view.getByLabelText("log level state").textContent).toBe("info:open"));
      fireEvent.click(view.getByLabelText("Open settings"));
      const checkbox = await waitFor(() => view.getByLabelText(/Store server logs in memory/) as HTMLInputElement);
      expect(checkbox.checked).toBe(false);

      fireEvent.click(checkbox);

      await waitFor(() => expect((view.getByLabelText(/Store server logs in memory/) as HTMLInputElement).checked).toBe(true));
      expect(putCalls).toBe(1);
      expect(configCalls).toBe(2);
    } finally {
      restoreFetch();
    }
  });

  test("keeps environment-controlled levels read-only in Settings", async () => {
    let putCalls = 0;
    const restoreFetch = installFetch((path, init) => {
      if (path === "/api/config") return Response.json(makeConfig("error", true));
      if (path === "/api/preferences/theme") return Response.json({ theme: "system" });
      if (path === "/api/preferences/log-level" && init?.method === "PUT") {
        putCalls += 1;
        return Response.json({ level: "trace" });
      }
      return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
    });

    try {
      const view = renderApp({
        sections: [{
          id: "log-level-probe",
          title: "Log level probe",
          render: () => createElement(LogLevelProbe),
        }],
      });
      await waitFor(() => expect(view.getByLabelText("log level state").textContent).toBe("error:locked"));
      fireEvent.click(view.getByLabelText("Open settings"));
      const selector = await waitFor(() => view.getByLabelText(/Log level/));
      expect((selector as HTMLSelectElement).disabled).toBe(true);
      expect(putCalls).toBe(0);
    } finally {
      restoreFetch();
    }
  });

  test("surfaces malformed initial configuration without a default level", async () => {
    const restoreFetch = installFetch((path) => {
      if (path === "/api/config") {
        return Response.json({ ...makeConfig(), logLevel: { level: "verbose", fromEnv: false } });
      }
      return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
    });

    try {
      const view = renderApp();
      await waitFor(() => expect(view.getByText("Unable to load app")).toBeTruthy());
      expect(view.getByText("Web app configuration response was invalid.")).toBeTruthy();
      expect(view.queryByLabelText("log level state")).toBeNull();
    } finally {
      restoreFetch();
    }
  });

  test("rejects malformed in-memory log configuration", async () => {
    const restoreFetch = installFetch((path) => {
      if (path === "/api/config") {
        return Response.json({ ...makeConfig(), inMemoryLogs: { enabled: "yes" } });
      }
      return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
    });

    try {
      const view = renderApp();
      await waitFor(() => expect(view.getByText("Unable to load app")).toBeTruthy());
      expect(view.getByText("Web app configuration response was invalid.")).toBeTruthy();
      expect(view.queryByLabelText(/Store server logs in memory/)).toBeNull();
    } finally {
      restoreFetch();
    }
  });

  test("hides in-memory log controls from non-admin users", async () => {
    const restoreFetch = installFetch((path) => {
      if (path === "/api/config") return Response.json(makeConfig("info", false, false, false));
      if (path === "/api/preferences/theme") return Response.json({ theme: "system" });
      return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
    });

    try {
      const view = renderApp();
      await waitFor(() => expect(view.getByLabelText("log level state").textContent).toBe("info:open"));
      fireEvent.click(view.getByLabelText("Open settings"));
      expect(view.queryByLabelText(/Store server logs in memory/)).toBeNull();
    } finally {
      restoreFetch();
    }
  });

  test("retains the last valid level while exposing a refresh failure", async () => {
    let configCalls = 0;
    const restoreFetch = installFetch((path) => {
      if (path === "/api/config") {
        configCalls += 1;
        return configCalls === 1
          ? Response.json(makeConfig("info"))
          : Response.json({ error: "unavailable", message: "Configuration unavailable" }, { status: 503 });
      }
      if (path === "/api/preferences/theme") return Response.json({ theme: "system" });
      return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
    });

    try {
      const view = renderApp();
      await waitFor(() => expect(view.getByLabelText("log level state").textContent).toBe("info:open"));
      fireEvent.click(view.getByRole("button", { name: "Refresh log level" }));
      await waitFor(() => expect(view.getByLabelText("log level state").textContent).toBe("error:info"));
    } finally {
      restoreFetch();
    }
  });

  test("ignores stale config responses from an older retry", async () => {
    let configCalls = 0;
    const pending: Array<(response: Response) => void> = [];
    const restoreFetch = installFetch((path) => {
      if (path === "/api/config") {
        configCalls += 1;
        if (configCalls === 1) return Response.json(makeConfig("info"));
        return new Promise<Response>((resolve) => pending.push(resolve));
      }
      if (path === "/api/preferences/theme") return Response.json({ theme: "system" });
      return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
    });

    try {
      const view = renderApp();
      await waitFor(() => expect(view.getByLabelText("log level state").textContent).toBe("info:open"));
      const retry = view.getByRole("button", { name: "Refresh log level" });
      fireEvent.click(retry);
      fireEvent.click(retry);
      await waitFor(() => expect(pending).toHaveLength(2));

      pending[1]!(Response.json(makeConfig("debug")));
      await waitFor(() => expect(view.getByLabelText("log level state").textContent).toBe("debug:open"));

      await act(async () => {
        pending[0]!(Response.json(makeConfig("warn")));
      });
      expect(view.getByLabelText("log level state").textContent).toBe("debug:open");
    } finally {
      restoreFetch();
    }
  });

  test("rejects useLogLevel outside the framework root", () => {
    expect(() => render(createElement(LogLevelProbe))).toThrow("useLogLevel must be used within the framework WebAppRoot.");
  });
});
