import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { StrictMode, act, createElement, createRef, startTransition, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { ConfirmDialog, ConfirmModal } from "../src/web/components";
import type { ApiKeySummary, AuthSessionSummary, ThemePreference, WebAppConfigResponse, WebAppUserSummary } from "../src/contracts";
import { configureWebAppClient, onAuthRequired } from "../src/web/api-client";
import { MOBILE_MEDIA_QUERY } from "../src/web/mobile";
import type { SidebarNode } from "../src/web/sidebar/types";
import { useWebAppConfig } from "../src/web/webapp-config";
import { useTheme, type WebAppRootController } from "../src/web";
import { WebAppRoot } from "../src/web/WebAppRoot";
import { PasskeyAuthScreen, UserSetupScreen } from "../src/web/auth-screens";
import { configureWebAppRenderer, renderWebApp } from "../src/web/render";
import { replaceWebAppRoute, routeToHash, useRoute } from "../src/web/routing";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
configureWebAppRenderer(createRoot);

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

type MockConfigFetchOptions = {
  publicBasePath?: string;
  deviceAuthEnabled?: boolean;
  onResponse?: (input: RequestInfo | URL, init?: RequestInit) => Response | undefined;
};

function mockConfigFetch(onRequest?: (input: RequestInfo | URL, init?: RequestInit) => void, options: MockConfigFetchOptions = {}) {
  const previousFetch = globalThis.fetch;
  const publicBasePath = options.publicBasePath ?? "/";
  const config: WebAppConfigResponse = {
    appName: "Test App",
    version: "1.0.0",
    publicBasePath,
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
      enabled: options.deviceAuthEnabled ?? false,
    },
    apiKeys: {
      enabled: false,
    },
  };

  function fetchPath(input: RequestInfo | URL) {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return new URL(String(rawUrl), "http://localhost").pathname;
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    onRequest?.(input, init);
    const response = options.onResponse?.(input, init);
    if (response) {
      return response;
    }
    const configPath = publicBasePath === "/" ? "/api/config" : `${publicBasePath}/api/config`;
    if (fetchPath(input) === configPath) {
      return Response.json(config);
    }
    return Response.json({ error: "Not found", message: "Not found" }, { status: 404 });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = previousFetch;
  };
}

function mockSettingsFetch(sessions: Array<{ id: string; clientId: string; scope: string; createdAt: string; updatedAt: string; expiresAt: string; active: boolean }>) {
  const previousFetch = globalThis.fetch;
  const config: WebAppConfigResponse = {
    appName: "Test App",
    version: "1.0.0",
    publicBasePath: "/",
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
      enabled: true,
    },
    apiKeys: {
      enabled: false,
    },
  };

  function fetchPath(input: RequestInfo | URL) {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return new URL(String(rawUrl), "http://localhost").pathname;
  }

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = fetchPath(input);
    if (path === "/api/config") {
      return Response.json(config);
    }
    if (path === "/api/auth/sessions") {
      return Response.json(sessions);
    }
    return Response.json({ error: "Not found", message: "Not found" }, { status: 404 });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = previousFetch;
  };
}

type BuiltInResponsePath = "/api/users" | "/api/api-keys" | "/api/auth/sessions" | "/api/preferences/theme";
type BuiltInFetchOptions = {
  userManagement?: boolean;
  apiKeysEnabled?: boolean;
  deviceAuthEnabled?: boolean;
  users?: WebAppUserSummary[];
  apiKeys?: ApiKeySummary[];
  sessions?: AuthSessionSummary[];
  theme?: ThemePreference;
  responses?: Partial<Record<BuiltInResponsePath, Array<() => Response>>>;
};

function mockBuiltInFetch(options: BuiltInFetchOptions = {}) {
  const previousFetch = globalThis.fetch;
  const responseSequences = new Map<string, Array<() => Response>>(
    Object.entries(options.responses ?? {}).map(([path, responses]) => [path, [...responses]]),
  );
  const requestCounts = new Map<string, number>();
  const config: WebAppConfigResponse = {
    appName: "Test App",
    version: "1.0.0",
    publicBasePath: "/",
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
      enabled: Boolean(options.userManagement),
      canManageUsers: Boolean(options.userManagement),
    },
    logLevel: {
      level: "info",
      fromEnv: false,
    },
    inMemoryLogs: {
      enabled: false,
    },
    deviceAuth: {
      enabled: Boolean(options.deviceAuthEnabled),
    },
    apiKeys: {
      enabled: Boolean(options.apiKeysEnabled),
    },
  };

  function fetchPath(input: RequestInfo | URL) {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return new URL(String(rawUrl), "http://localhost").pathname;
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = fetchPath(input);
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
    const queuedResponse = responseSequences.get(path)?.shift();
    if (queuedResponse) {
      return queuedResponse();
    }
    if (path === "/api/config") {
      return Response.json(config);
    }
    if (path === "/api/users" && (init?.method ?? "GET") === "GET") {
      return Response.json(options.users ?? []);
    }
    if (path === "/api/api-keys" && (init?.method ?? "GET") === "GET") {
      return Response.json(options.apiKeys ?? []);
    }
    if (path === "/api/auth/sessions" && (init?.method ?? "GET") === "GET") {
      return Response.json(options.sessions ?? []);
    }
    if (path === "/api/preferences/theme" && (init?.method ?? "GET") === "GET") {
      return Response.json({ theme: options.theme ?? "system" });
    }
    if (path.startsWith("/api/users/") || path.startsWith("/api/api-keys/") || path.startsWith("/api/auth/sessions/")) {
      return Response.json({});
    }
    return Response.json({ error: "Not found", message: "Not found" }, { status: 404 });
  }) as typeof fetch;

  return {
    restoreFetch() {
      globalThis.fetch = previousFetch;
    },
    requestCount(path: BuiltInResponsePath) {
      return requestCounts.get(path) ?? 0;
    },
  };
}

function mockMobileMediaQuery(matches: boolean) {
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => {
    const mediaQuery = previousMatchMedia.call(window, query);
    if (query === MOBILE_MEDIA_QUERY) {
      Object.defineProperty(mediaQuery, "matches", { configurable: true, value: matches });
    }
    return mediaQuery;
  }) as typeof window.matchMedia;

  return () => {
    window.matchMedia = previousMatchMedia;
  };
}

function createVisualViewportFixture(initialHeight: number) {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let height = initialHeight;
  const viewport = {
    get height() {
      return height;
    },
    offsetTop: 0,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (!listener) {
        return;
      }
      const typeListeners = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (!listener) {
        return;
      }
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    viewport,
    setHeight(nextHeight: number) {
      height = nextHeight;
    },
    emit(type: string) {
      const event = new Event(type);
      for (const listener of listeners.get(type) ?? []) {
        if (typeof listener === "function") {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }
    },
  };
}

async function renderSettingsWebApp() {
  const view = render(createElement(WebAppRoot, {
    appName: "Test App",
    homeRoute: { view: "home" },
    sidebar: {
      search: false,
      pinning: false,
      getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
    },
    routes: {
      home: createElement("p", null, "Home"),
    },
  }));

  fireEvent.click(await waitFor(() => view.getByLabelText("Open settings")));
  await waitFor(() => expect(view.getByText("Device auth sessions")).toBeTruthy());

  return view;
}

async function renderBuiltInSettingsWebApp() {
  const view = render(createElement(WebAppRoot, {
    appName: "Test App",
    homeRoute: { view: "home" },
    sidebar: {
      search: false,
      pinning: false,
      getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
    },
    routes: {
      home: createElement("p", null, "Home"),
    },
  }));

  fireEvent.click(await waitFor(() => view.getByLabelText("Open settings")));
  await waitFor(() => expect(view.getByText("Display Settings")).toBeTruthy());

  return view;
}

function ThemeStateProbe() {
  const { preference, resolvedTheme } = useTheme();
  return createElement("p", { "aria-label": "theme state" }, `${preference}:${resolvedTheme}`);
}

type SidebarFixtureOptions = {
  search?: boolean;
  sectionDefaultCollapsed?: boolean;
  controllerRef?: { current: WebAppRootController | null };
  strictMode?: boolean;
};

function createSidebarFixtureNodes({ sectionDefaultCollapsed = false }: SidebarFixtureOptions = {}): SidebarNode[] {
  return [
    {
      type: "section" as const,
      id: "projects",
      title: "Projects",
      defaultCollapsed: sectionDefaultCollapsed,
      children: [{ type: "item" as const, id: "alpha", title: "Alpha", route: { view: "alpha" } }],
    },
  ];
}

function filterSidebarNodesByTitle(nodes: SidebarNode[], search: string): SidebarNode[] {
  const query = search.trim().toLowerCase();
  if (!query) return nodes;

  return nodes.flatMap((node) => {
    const children = node.children ? filterSidebarNodesByTitle(node.children, search) : undefined;
    const matches = node.title.toLowerCase().includes(query);
    if (!matches && !children?.length) return [];
    return [{ ...node, ...(children ? { children } : {}) }];
  });
}

async function renderSidebarWebApp(options: SidebarFixtureOptions = {}) {
  const { search = false, controllerRef } = options;
  const root = createElement(WebAppRoot, {
    ref: controllerRef,
    appName: "Test App",
    homeRoute: { view: "home" },
    sidebar: {
      search,
      pinning: false,
      getNodes: ({ search: query }) => filterSidebarNodesByTitle(createSidebarFixtureNodes(options), query),
    },
    routes: {
      home: createElement("p", null, "Home"),
      alpha: createElement("p", null, "Alpha"),
    },
  });
  const view = render(options.strictMode ? createElement(StrictMode, null, root) : root);

  await waitFor(() => expect(view.getByRole("button", { name: /Projects/ })).toBeTruthy());

  return view;
}

async function renderShortcutWebApp(options: SidebarFixtureOptions = {}) {
  const view = await renderSidebarWebApp(options);

  await waitFor(() => expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy());
  await act(async () => {});

  return view;
}

async function renderCollapsibleSidebarWebApp({ defaultCollapsed = false } = {}) {
  return renderSidebarWebApp({ sectionDefaultCollapsed: defaultCollapsed });
}

async function renderSearchableCollapsibleSidebarWebApp({ sectionDefaultCollapsed = true } = {}) {
  return renderSidebarWebApp({ search: true, sectionDefaultCollapsed });
}

function typeSearch(input: HTMLElement, value: string) {
  const searchInput = input as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(searchInput, "value")?.set;
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(searchInput), "value")?.set;
  act(() => {
    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(searchInput, value);
    } else {
      searchInput.value = value;
    }
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("sidebar keeps two app actions beside its framework actions", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        topActions: [
          { id: "activity", title: "Activity", route: { view: "activity" } },
          { id: "inbox", title: "Inbox", route: { view: "inbox" } },
        ],
        getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
      },
      routes: {
        home: createElement("p", null, "Home"),
        activity: createElement("p", null, "Activity"),
        inbox: createElement("p", null, "Inbox"),
      },
    }));

    await waitFor(() => expect(view.getByRole("button", { name: "Activity" })).toBeTruthy());
    expect(view.getByRole("button", { name: "Inbox" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Open settings" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    expect(view.getByText("v1.0.0")).toBeTruthy();
    expect(view.queryByRole("tab")).toBeNull();
  } finally {
    restoreFetch();
  }
});

test("sidebar brand renders SVG and PNG sources and navigates home", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const appIcons: Array<[string | URL, string]> = [
      ["  /icons/app.svg  ", "/icons/app.svg"],
      [new URL("http://localhost/icons/app.png"), "http://localhost/icons/app.png"],
    ];
    for (const [appIcon, expectedSource] of appIcons) {
      window.history.replaceState(null, "", "http://localhost/#/details");
      const view = render(createElement(WebAppRoot, {
        appName: "Test App",
        appIcon,
        homeRoute: { view: "home" },
        sidebar: {
          search: false,
          pinning: false,
          getNodes: () => [],
        },
        routes: {
          home: createElement("p", null, "Home route"),
          details: createElement("p", null, "Details route"),
        },
      }));

      const brand = await waitFor(() => view.getByRole("button", { name: "Test App" }));
      const image = brand.querySelector("img");
      expect(image).toBeTruthy();
      expect(image?.getAttribute("src")).toBe(expectedSource);
      expect(brand.getAttribute("title")).toBe("Test App");
      expect(brand.textContent.trim()).toBe("");

      fireEvent.click(brand);
      await waitFor(() => expect(view.getByText("Home route")).toBeTruthy());
      view.unmount();
    }
  } finally {
    restoreFetch();
  }
});

test("sidebar brand ignores invalid runtime app icon values", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    for (const appIcon of [null, {}, 42]) {
      const view = render(createElement(WebAppRoot, {
        appName: "Test App",
        // Deliberately bypass the TypeScript prop contract to exercise runtime callers.
        appIcon: appIcon as string | URL,
        homeRoute: { view: "home" },
        sidebar: {
          search: false,
          pinning: false,
          getNodes: () => [],
        },
        routes: {
          home: createElement("p", null, "Home route"),
        },
      }));

      const brand = await waitFor(() => view.getByRole("button", { name: "Test App" }));
      expect(brand.querySelector("img")).toBeNull();
      expect(brand.textContent).toContain("Test App");
      view.unmount();
    }
  } finally {
    restoreFetch();
  }
});

test("sidebar brand keeps the application title when no icon is configured", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    window.history.replaceState(null, "", "http://localhost/#/details");
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        getNodes: () => [],
      },
      routes: {
        home: createElement("p", null, "Home route"),
        details: createElement("p", null, "Details route"),
      },
    }));

    const brand = await waitFor(() => view.getByRole("button", { name: "Test App" }));
    expect(brand.textContent).toBe("Test App");
    expect(brand.querySelector("img")).toBeNull();

    fireEvent.click(brand);
    await waitFor(() => expect(view.getByText("Home route")).toBeTruthy());
  } finally {
    restoreFetch();
  }
});

test("passkey screen offers a masked API-key fallback only when enabled", async () => {
  const status = {
    enabled: true,
    passkeyConfigured: true,
    passkeyDisabled: false,
    passkeyRequired: true,
    authenticated: false,
    bootstrapRequired: false,
    ownerPasskeySetupRequired: false,
  };
  const view = render(createElement(PasskeyAuthScreen, {
    status,
    apiKeysEnabled: true,
    refresh: async () => undefined,
  }));

  expect(view.container.querySelector('input[type="password"]')).toBeNull();
  expect(view.getByRole("button", { name: "Authenticate" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Use API Key instead" }));
  const input = view.container.querySelector('input[type="password"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  expect(input.type).toBe("password");
  expect(view.getByRole("button", { name: "Use Passkey instead" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Use Passkey instead" }));
  expect(view.container.querySelector('input[type="password"]')).toBeNull();
  view.rerender(createElement(PasskeyAuthScreen, {
    status,
    apiKeysEnabled: false,
    refresh: async () => undefined,
  }));
  expect(view.queryByRole("button", { name: "Use API Key instead" })).toBeNull();
  expect(view.container.querySelector("form")).toBeNull();
  view.rerender(createElement(PasskeyAuthScreen, {
    status,
    apiKeysEnabled: true,
    refresh: async () => undefined,
  }));
  await waitFor(() => expect(view.getByRole("button", { name: "Use API Key instead" })).toBeTruthy());
  expect(view.container.querySelector("form")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Use API Key instead" }));
  expect((view.container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
});

test("WebAppRoot renders setup and device pages under a public base path", async () => {
  const requested: string[] = [];
  const restoreFetch = mockConfigFetch((input) => requested.push(String(input)), {
    publicBasePath: "/tools/notes",
    deviceAuthEnabled: true,
    onResponse: (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/tools/notes/api/auth/device/verification") {
        return Response.json({
          userCode: url.searchParams.get("user_code"),
          clientId: "notes-cli",
          scope: "read",
          status: "pending",
          expiresAt: "2099-01-01T00:00:00.000Z",
          passkeyRequired: false,
        });
      }
      return undefined;
    },
  });

  const renderRoot = () => createElement(WebAppRoot, {
    appName: "Test App",
    homeRoute: { view: "home" },
    sidebar: {
      search: false,
      pinning: false,
      getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
    },
    routes: {
      home: createElement("p", null, "Home"),
    },
  });

  try {
    window.history.replaceState(null, "", "http://localhost/tools/notes/setup?token=setup-token#stale");
    const setupView = render(renderRoot());
    await waitFor(() => expect(setupView.getByText("Finish user setup")).toBeTruthy());
    expect(requested.some((input) => new URL(input).pathname === "/tools/notes/api/config")).toBe(true);
    setupView.unmount();

    window.history.replaceState(null, "", "http://localhost/tools/notes/device?user_code=ABCD-2345");
    const deviceView = render(renderRoot());
    await waitFor(() => expect(deviceView.getByText("Authorize device")).toBeTruthy());
    await waitFor(() => expect(deviceView.getByText("notes-cli")).toBeTruthy());
    expect(requested.some((input) => new URL(input).pathname === "/tools/notes/api/auth/device/verification")).toBe(true);
  } finally {
    restoreFetch();
  }
});

test("UserSetupScreen redirects to the prefixed application root without setup state", async () => {
  const previousFetch = globalThis.fetch;
  const previousPublicKeyCredential = Object.getOwnPropertyDescriptor(globalThis, "PublicKeyCredential");
  const previousCredentials = Object.getOwnPropertyDescriptor(navigator, "credentials");
  const requested: string[] = [];
  configureWebAppClient({ publicBasePath: "/tools/notes" });
  window.history.replaceState(null, "", "http://localhost/tools/notes/setup?token=setup-token#stale");

  const credentialResponse = {
    attestationObject: new Uint8Array([1]),
    clientDataJSON: new Uint8Array([2]),
    getTransports: () => [],
  };
  const credential = {
    id: "credential-id",
    rawId: new Uint8Array([3]).buffer,
    response: credentialResponse,
    type: "public-key",
    getClientExtensionResults: () => ({}),
  };
  Object.defineProperty(globalThis, "PublicKeyCredential", {
    configurable: true,
    value: class PublicKeyCredential {},
  });
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { create: async () => credential },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    requested.push(`${init?.method ?? "GET"} ${url.toString()}`);
    if (url.pathname === "/tools/notes/api/user-setup") {
      return Response.json({
        username: "owner",
        role: "user",
        kind: "invite",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }
    if (url.pathname === "/tools/notes/api/user-setup/options") {
      return Response.json({
        challenge: "AQ",
        rp: { name: "Test App" },
        user: { id: "AQ", name: "owner", displayName: "owner" },
      });
    }
    if (url.pathname === "/tools/notes/api/user-setup/verify") {
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
  }) as typeof fetch;

  try {
    const view = render(createElement(UserSetupScreen, { refresh: async () => undefined }));
    await waitFor(() => expect(view.getByText("Username: owner")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Set up passkey" }));

    await waitFor(() => expect(window.location.pathname).toBe("/tools/notes/"));
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
    expect(requested.some((input) => input.includes("POST http://localhost/tools/notes/api/user-setup/options"))).toBe(true);
    expect(requested.some((input) => input.includes("POST http://localhost/tools/notes/api/user-setup/verify"))).toBe(true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPublicKeyCredential) {
      Object.defineProperty(globalThis, "PublicKeyCredential", previousPublicKeyCredential);
    } else {
      Reflect.deleteProperty(globalThis, "PublicKeyCredential");
    }
    if (previousCredentials) {
      Object.defineProperty(navigator, "credentials", previousCredentials);
    } else {
      Reflect.deleteProperty(navigator, "credentials");
    }
  }
});

function RouteProbe({ onRoute }: { onRoute: (route: Record<string, string | undefined>) => void }) {
  const { route } = useRoute({ view: "home" });
  useEffect(() => {
    onRoute(route);
  }, [onRoute, route]);
  return createElement("output", { "aria-label": "active route" }, route.view);
}

test("hash routes preserve string values, encoding, unknown keys, and deterministic ordering", async () => {
  window.history.replaceState(null, "", "http://localhost/#/items?count=42&enabled=true&unknown=a%2Fb");
  const routes: Array<Record<string, string | undefined>> = [];
  const onRoute = (route: Record<string, string | undefined>) => routes.push(route);
  const nextRoute = {
    view: "items",
    count: "42",
    enabled: "true",
    encoded: "a/b &",
    omitted: undefined,
  };

  expect(routeToHash(nextRoute)).toBe("#/items?count=42&enabled=true&encoded=a%2Fb+%26");
  const view = render(createElement(RouteProbe, { onRoute }));

  await waitFor(() => expect(routes.at(-1)).toEqual({
    view: "items",
    count: "42",
    enabled: "true",
    unknown: "a/b",
  }));
  expect(view.getByLabelText("active route").textContent).toBe("items");

  act(() => {
    replaceWebAppRoute(nextRoute);
  });
  await waitFor(() => expect(routes.at(-1)).toEqual({
    view: "items",
    count: "42",
    encoded: "a/b &",
    enabled: "true",
  }));
  expect(window.location.hash).toBe("#/items?count=42&enabled=true&encoded=a%2Fb+%26");

  view.unmount();
  const reloadedRoutes: Array<Record<string, string | undefined>> = [];
  render(createElement(RouteProbe, { onRoute: (route) => reloadedRoutes.push(route) }));
  await waitFor(() => expect(reloadedRoutes.at(-1)).toEqual({
    view: "items",
    count: "42",
    encoded: "a/b &",
    enabled: "true",
  }));
});

test("sidebar tabs select the first item, update the node context, and persist selection", async () => {
  const restoreFetch = mockConfigFetch();
  let lastContext: { search: string; activeTab?: string } | undefined;
  const renderTabApp = () => render(createElement(WebAppRoot, {
    appName: "Test App",
    homeRoute: { view: "home" },
    sidebar: {
      search: true,
      pinning: false,
      tabs: [
        { id: "work", title: "Work", icon: "W" },
        { id: "notes", title: "notes" },
        { id: "admin", title: "Administration", label: "Admin", icon: "A" },
        { id: "text", title: "Text only", icon: null },
      ],
      getNodes: ({ search, activeTab }) => {
        lastContext = { search, activeTab };
        return [{
          type: "item" as const,
          id: `item:${activeTab ?? "none"}`,
          title: activeTab === "notes" ? "Notes item" : activeTab === "admin" ? "Admin item" : "Work item",
          route: { view: "home" },
        }];
      },
    },
    routes: {
      home: createElement("p", null, "Home"),
    },
  }));

  try {
    let view = renderTabApp();
    await waitFor(() => expect(view.getByText("Work item")).toBeTruthy());
    expect(view.getByRole("tab", { name: "Work" }).getAttribute("aria-selected")).toBe("true");
    expect(view.getByRole("tab", { name: "Work" }).getAttribute("tabindex")).toBe("0");
    expect(view.getByRole("tab", { name: "notes" }).getAttribute("tabindex")).toBe("-1");
    expect(view.getByText("N")).toBeTruthy();
    expect(view.getByText("Admin")).toBeTruthy();
    expect(view.getByText("Text only")).toBeTruthy();

    fireEvent.click(view.getByRole("tab", { name: "notes" }));
    await waitFor(() => expect(view.getByText("Notes item")).toBeTruthy());
    expect(lastContext).toEqual({ search: "", activeTab: "notes" });
    expect(view.getByRole("tab", { name: "notes" }).getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(view.getByRole("tab", { name: "notes" }), { key: "ArrowRight" });
    await waitFor(() => expect(lastContext).toEqual({ search: "", activeTab: "admin" }));
    expect(document.activeElement).toBe(view.getByRole("tab", { name: "Administration" }));

    fireEvent.keyDown(view.getByRole("tab", { name: "Administration" }), { key: "End" });
    await waitFor(() => expect(lastContext).toEqual({ search: "", activeTab: "text" }));
    expect(document.activeElement).toBe(view.getByRole("tab", { name: "Text only" }));

    fireEvent.keyDown(view.getByRole("tab", { name: "Text only" }), { key: "Home" });
    await waitFor(() => expect(lastContext).toEqual({ search: "", activeTab: "work" }));
    expect(document.activeElement).toBe(view.getByRole("tab", { name: "Work" }));

    fireEvent.click(view.getByRole("tab", { name: "notes" }));
    await waitFor(() => expect(lastContext).toEqual({ search: "", activeTab: "notes" }));
    typeSearch(view.getByRole("textbox", { name: "Search" }), "query");
    await waitFor(() => expect(lastContext).toEqual({ search: "query", activeTab: "notes" }));

    view.unmount();
    view = renderTabApp();
    await waitFor(() => expect(view.getByText("Notes item")).toBeTruthy());
    expect(view.getByRole("tab", { name: "notes" }).getAttribute("aria-selected")).toBe("true");
  } finally {
    restoreFetch();
  }
});

test("sidebar supports application-owned custom item renderers", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        getNodes: () => [
          {
            type: "item" as const,
            id: "custom",
            title: "Custom item",
            route: { view: "custom" },
            render: ({ node, active }) => createElement(
              "span",
              null,
              active ? "Custom active" : node.title,
            ),
          },
          {
            type: "item" as const,
            id: "fallback",
            title: "Fallback item",
            render: () => null,
          },
        ],
      },
      routes: {
        home: createElement("p", null, "Home"),
        custom: createElement("p", null, "Custom detail view"),
      },
    }));

    await waitFor(() => expect(view.getByRole("button", { name: "Custom item" })).toBeTruthy());
    expect(view.getByRole("button", { name: "Fallback item" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Custom item" }));
    await waitFor(() => expect(view.getByText("Custom detail view")).toBeTruthy());
    expect(view.getByRole("button", { name: "Custom active" }).textContent).toBe("Custom active");
  } finally {
    restoreFetch();
  }
});

test("pinned routes retain their header actions across sidebar tabs", async () => {
  const restoreFetch = mockConfigFetch();
  localStorage.setItem("webapp.test-app.sidebar.pins", JSON.stringify([{
    id: "notes-item",
    title: "Stored note",
    route: { view: "note" },
  }]));
  try {
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        tabs: [
          { id: "work", title: "Work" },
          { id: "notes", title: "Notes" },
        ],
        getNodes: ({ activeTab }) => [{
          type: "item" as const,
          id: activeTab === "notes" ? "notes-item" : "work-item",
          title: activeTab === "notes" ? "Live note" : "Work item",
          route: { view: activeTab === "notes" ? "note" : "home" },
          actions: activeTab === "notes"
            ? [{ id: "inspect", label: "Inspect note", onAction: () => undefined }]
            : undefined,
          pinnable: true,
        }],
      },
      routes: {
        home: createElement("p", null, "Home"),
        note: createElement("p", null, "Note"),
      },
    }));

    await waitFor(() => expect(view.getByRole("button", { name: "Live note" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Live note" }));
    await waitFor(() => expect(view.getByText("Note")).toBeTruthy());
    fireEvent.click(await waitFor(() => view.getByLabelText("Actions for note")));
    await waitFor(() => expect(view.getAllByRole("menuitem", { name: "Inspect note" })).toHaveLength(1));
  } finally {
    restoreFetch();
  }
});

test("legacy pinned routes retain string values while discarding invalid parameters", async () => {
  const restoreFetch = mockConfigFetch();
  localStorage.setItem("webapp.test-app.sidebar.pins", JSON.stringify([{
    id: "legacy-item",
    title: "Legacy item",
    route: {
      view: "legacy",
      kept: "true",
      numeric: 42,
      boolean: false,
      object: { nested: "value" },
      nullValue: null,
    },
  }]));

  try {
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        getNodes: () => ({ nodes: [], ready: false }),
      },
      routes: {
        home: createElement("p", null, "Home"),
        legacy: (route) => createElement(
          "p",
          null,
          `${route["kept"] ?? "missing"}:${route["numeric"] ?? "missing"}:${route["boolean"] ?? "missing"}:${route["object"] ?? "missing"}`,
        ),
      },
    }));

    fireEvent.click(await waitFor(() => view.getByRole("button", { name: "Legacy item" })));
    await waitFor(() => expect(view.getByText("true:missing:missing:missing")).toBeTruthy());
  } finally {
    restoreFetch();
  }
});

test("native pinning waits for a ready snapshot and reconciles current node metadata", async () => {
  const restoreFetch = mockConfigFetch();
  const storedPins = [
    { id: "valid", title: "Old title", route: { view: "valid" } },
    { id: "missing", title: "Missing item", route: { view: "missing" } },
  ];
  const storedValue = JSON.stringify(storedPins);
  localStorage.setItem("webapp.test-app.sidebar.pins", storedValue);
  let snapshotReady = false;

  const renderApp = () => createElement(WebAppRoot, {
    appName: "Test App",
    homeRoute: { view: "home" },
    sidebar: {
      search: false,
      getNodes: () => ({
        nodes: snapshotReady
          ? [
            { type: "item" as const, id: "valid", title: "Current title", route: { view: "valid" }, pinnable: true, actions: [{ id: "inspect-valid", label: "Inspect valid", onAction: () => undefined }] },
            { type: "item" as const, id: "candidate", title: "Candidate", route: { view: "candidate" }, pinnable: true, actions: [{ id: "inspect-candidate", label: "Inspect candidate", onAction: () => undefined }] },
          ]
          : [
            { type: "item" as const, id: "valid", title: "Loading title", route: { view: "valid" }, pinnable: true, actions: [{ id: "inspect-valid", label: "Inspect valid", onAction: () => undefined }] },
            { type: "item" as const, id: "candidate", title: "Candidate", route: { view: "candidate" }, pinnable: true, actions: [{ id: "inspect-candidate", label: "Inspect candidate", onAction: () => undefined }] },
          ],
        ready: snapshotReady,
      }),
    },
    routes: {
      home: createElement("p", null, "Home"),
      valid: createElement("p", null, "Valid"),
      candidate: createElement("p", null, "Candidate"),
      missing: createElement("p", null, "Missing"),
    },
  });

  try {
    const view = render(renderApp());
    await waitFor(() => expect(view.getByRole("button", { name: "Old title" })).toBeTruthy());
    expect(view.getByRole("button", { name: "Missing item" })).toBeTruthy();
    expect(localStorage.getItem("webapp.test-app.sidebar.pins")).toBe(storedValue);
    fireEvent.contextMenu(view.getByRole("button", { name: "Candidate" }));
    await waitFor(() => expect(view.getByRole("menuitem", { name: "Inspect candidate" })).toBeTruthy());
    expect(view.queryByRole("menuitem", { name: "Pin to sidebar" })).toBeNull();
    fireEvent.contextMenu(view.getByRole("button", { name: "Old title" }));
    await waitFor(() => expect(view.getByRole("menuitem", { name: "Inspect valid" })).toBeTruthy());
    expect(view.queryByRole("menuitem", { name: "Unpin from sidebar" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });

    snapshotReady = true;
    view.rerender(renderApp());

    await waitFor(() => expect(view.getAllByRole("button", { name: "Current title" })).toHaveLength(2));
    expect(view.queryByRole("button", { name: "Old title" })).toBeNull();
    expect(view.queryByRole("button", { name: "Missing item" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("webapp.test-app.sidebar.pins") ?? "null")).toEqual([{
      id: "valid",
      title: "Current title",
      route: { view: "valid" },
    }]);
    fireEvent.contextMenu(view.getByRole("button", { name: "Candidate" }));
    await waitFor(() => expect(view.getByRole("menuitem", { name: "Pin to sidebar" })).toBeTruthy());
  } finally {
    restoreFetch();
  }
});

test("public sidebar controller selects tabs without remounting the current route", async () => {
  const restoreFetch = mockConfigFetch();
  const controllerRef = createRef<WebAppRootController>();
  const routeChanges: string[] = [];
  const selectTabForRoute = (route: { view: string }) => {
    const targetTab = route.view === "home" ? "notes" : "work";
    controllerRef.current?.sidebar.selectTab(targetTab);
  };
  function StatefulRoute() {
    const [count, setCount] = useState(0);
    return createElement(
      "div",
      null,
      createElement("p", null, `Route state: ${count}`),
      createElement("button", { type: "button", onClick: () => setCount((current) => current + 1) }, "Increment route"),
    );
  }

  try {
    const view = render(createElement(WebAppRoot, {
      ref: controllerRef,
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        tabs: [
          { id: "work", title: "Work" },
          { id: "notes", title: "Notes" },
        ],
        getNodes: ({ activeTab }) => [{
          type: "item" as const,
          id: `${activeTab ?? "none"}-item`,
          title: `${activeTab === "notes" ? "Notes" : "Work"} item`,
          route: { view: "home" },
        }],
      },
      routes: {
        home: createElement(StatefulRoute),
      },
      onRouteChange: (route) => routeChanges.push(route.view),
    }));

    await waitFor(() => expect(view.getByText("Work item")).toBeTruthy());
    await waitFor(() => expect(controllerRef.current).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Increment route" }));
    expect(view.getByText("Route state: 1")).toBeTruthy();

    const initialHash = window.location.hash;
    const initialRouteChangeCount = routeChanges.length;
    act(() => {
      selectTabForRoute({ view: "home" });
    });

    await waitFor(() => expect(view.getByText("Notes item")).toBeTruthy());
    expect(view.getByRole("tab", { name: "Notes" }).getAttribute("aria-selected")).toBe("true");
    expect(view.getByText("Route state: 1")).toBeTruthy();
    expect(window.location.hash).toBe(initialHash);
    expect(routeChanges).toHaveLength(initialRouteChangeCount);
    await waitFor(() => expect(localStorage.getItem("webapp.test-app.sidebar.tab")).toBe("notes"));

    act(() => {
      controllerRef.current?.sidebar.selectTab("unknown");
    });
    expect(view.getByRole("tab", { name: "Notes" }).getAttribute("aria-selected")).toBe("true");
    expect(localStorage.getItem("webapp.test-app.sidebar.tab")).toBe("notes");
  } finally {
    restoreFetch();
  }
});

test("public sidebar controller opens and focuses search on desktop", async () => {
  const restoreFetch = mockConfigFetch();
  const controllerRef = createRef<WebAppRootController>();

  try {
    const view = render(createElement(WebAppRoot, {
      ref: controllerRef,
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: true,
        pinning: false,
        getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
      },
      routes: {
        home: createElement("p", null, "Home"),
      },
    }));

    const searchInput = await waitFor(() => view.getByRole("textbox", { name: "Search" }));
    await waitFor(() => expect(controllerRef.current).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
    await waitFor(() => expect(view.queryByRole("button", { name: "Collapse sidebar" })).toBeNull());

    act(() => {
      controllerRef.current?.sidebar.open();
    });
    await waitFor(() => expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy());

    fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
    await waitFor(() => expect(view.queryByRole("button", { name: "Collapse sidebar" })).toBeNull());
    act(() => {
      controllerRef.current?.sidebar.focusSearch();
    });

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
      expect(document.activeElement).toBe(searchInput);
    });
    await act(async () => {});
  } finally {
    restoreFetch();
  }
});

test("public sidebar controller focuses search when a config refresh retains the previous config", async () => {
  const restoreFetch = mockConfigFetch();
  const controllerRef = createRef<WebAppRootController>();
  function ConfigRefreshProbe() {
    const { error, refresh } = useWebAppConfig();
    return createElement(
      "div",
      null,
      createElement("button", { type: "button", onClick: () => { void refresh(); } }, "Refresh config"),
      error ? createElement("p", null, "Config refresh failed") : null,
    );
  }

  try {
    const view = render(createElement(WebAppRoot, {
      ref: controllerRef,
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: true,
        pinning: false,
        getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
      },
      routes: {
        home: createElement(ConfigRefreshProbe),
      },
    }));

    const searchInput = await waitFor(() => view.getByRole("textbox", { name: "Search" }));
    await waitFor(() => expect(controllerRef.current).toBeTruthy());
    const delegatedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (new URL(String(rawUrl), "http://localhost").pathname === "/api/config") {
        return Response.json({ message: "Config refresh unavailable" }, { status: 503 });
      }
      return delegatedFetch(input, init);
    }) as typeof fetch;

    fireEvent.click(view.getByRole("button", { name: "Refresh config" }));
    await waitFor(() => expect(view.getByText("Config refresh failed")).toBeTruthy());
    expect(view.getByText("Home")).toBeTruthy();

    act(() => {
      controllerRef.current?.sidebar.focusSearch();
    });
    await waitFor(() => expect(document.activeElement).toBe(searchInput));
    await act(async () => {});
  } finally {
    restoreFetch();
  }
});

test("public sidebar controller opens and focuses search on mobile", async () => {
  const restoreFetch = mockConfigFetch();
  const restoreMediaQuery = mockMobileMediaQuery(true);
  const controllerRef = createRef<WebAppRootController>();

  try {
    const view = render(createElement(WebAppRoot, {
      ref: controllerRef,
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: true,
        pinning: false,
        getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
      },
      routes: {
        home: createElement("p", null, "Home"),
      },
    }));

    const searchInput = await waitFor(() => view.getByRole("textbox", { name: "Search" }));
    await waitFor(() => expect(controllerRef.current).toBeTruthy());
    act(() => {
      controllerRef.current?.sidebar.focusSearch();
    });

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Close sidebar" })).toBeTruthy();
      expect(document.activeElement).toBe(searchInput);
    });
    await act(async () => {});
  } finally {
    restoreMediaQuery();
    restoreFetch();
  }
});

test("sidebar navigation replaces hash history entries", async () => {
  const restoreFetch = mockConfigFetch();
  window.location.hash = "#/home";
  window.history.replaceState({ marker: "initial" }, "", window.location.href);
  const initialLength = window.history.length;
  const hashChanges: HashChangeEvent[] = [];
  const routeChanges: string[] = [];
  const onHashChange = (event: HashChangeEvent) => hashChanges.push(event);

  try {
    const { getByRole, getByText } = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        getNodes: () => [
          { type: "item" as const, id: "home", title: "Home", route: { view: "home" } },
          { type: "item" as const, id: "target", title: "Target", route: { view: "target", projectId: "project-1" } },
        ],
      },
      routes: {
        home: createElement("p", null, "Home view"),
        target: createElement("p", null, "Target screen"),
      },
      onRouteChange: (route) => routeChanges.push(`${route.view}:${route["projectId"] ?? ""}`),
    }));

    await waitFor(() => expect(getByText("Home view")).toBeTruthy());

    const initialUrl = window.location.href;
    window.addEventListener("hashchange", onHashChange);
    fireEvent.click(getByRole("button", { name: "Target" }));

    await waitFor(() => expect(getByText("Target screen")).toBeTruthy());
    expect(window.location.hash).toBe("#/target?projectId=project-1");
    expect(window.history.length).toBe(initialLength);
    expect(window.history.state).toEqual({ marker: "initial" });
    expect(hashChanges.some((event) => event.oldURL === initialUrl && event.newURL === window.location.href)).toBe(true);
    expect(routeChanges).toContain("target:project-1");
  } finally {
    window.removeEventListener("hashchange", onHashChange);
    restoreFetch();
  }
});

test("sidebar navigation updates synchronously while the document is hidden", async () => {
  const restoreFetch = mockConfigFetch();
  const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const previousTransitionDescriptor = Object.getOwnPropertyDescriptor(document, "startViewTransition");
  let transitionCalls = 0;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: () => {
      transitionCalls += 1;
      throw new DOMException(
        "View transition was skipped because document visibility state is hidden.",
        "InvalidStateError",
      );
    },
  });

  try {
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        getNodes: () => [
          { type: "item" as const, id: "home", title: "Home", route: { view: "home" } },
          { type: "item" as const, id: "target", title: "Target", route: { view: "target" } },
        ],
      },
      routes: {
        home: createElement("p", null, "Home view"),
        target: createElement("p", null, "Target screen"),
      },
    }));

    await waitFor(() => expect(view.getByText("Home view")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Target" }));

    await waitFor(() => expect(view.getByText("Target screen")).toBeTruthy());
    expect(transitionCalls).toBe(0);
  } finally {
    if (previousVisibilityDescriptor) {
      Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
    if (previousTransitionDescriptor) {
      Object.defineProperty(document, "startViewTransition", previousTransitionDescriptor);
    } else {
      Reflect.deleteProperty(document, "startViewTransition");
    }
    restoreFetch();
  }
});

test("sidebar navigation to the current hash does not emit duplicate hash changes", async () => {
  const restoreFetch = mockConfigFetch();
  window.location.hash = "#/target";
  window.history.replaceState({ marker: "same-route" }, "", window.location.href);
  const initialLength = window.history.length;
  let hashChangeCount = 0;
  const onHashChange = () => {
    hashChangeCount += 1;
  };

  try {
    const { getByRole, getByText } = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        getNodes: () => [
          { type: "item" as const, id: "home", title: "Home", route: { view: "home" } },
          { type: "item" as const, id: "target", title: "Target", route: { view: "target" } },
        ],
      },
      routes: {
        home: createElement("p", null, "Home view"),
        target: createElement("p", null, "Target screen"),
      },
    }));

    await waitFor(() => expect(getByText("Target screen")).toBeTruthy());
    window.addEventListener("hashchange", onHashChange);

    fireEvent.click(getByRole("button", { name: "Target" }));

    expect(window.location.hash).toBe("#/target");
    expect(window.history.length).toBe(initialLength);
    expect(window.history.state).toEqual({ marker: "same-route" });
    expect(hashChangeCount).toBe(0);
  } finally {
    window.removeEventListener("hashchange", onHashChange);
    restoreFetch();
  }
});

test("renderWebApp renders the latest content when called repeatedly", () => {
  const container = document.createElement("div");
  document.body.append(container);

  act(() => {
    renderWebApp(createElement("div", null, "first"), container);
    renderWebApp(createElement("div", null, "second"), container);
  });

  expect(container.textContent).toBe("second");
});

test("WebAppRoot routes built-in requests through the configured API base URL", async () => {
  const requested: string[] = [];
  configureWebAppClient({ apiBaseUrl: "https://api.example.test/root" });
  const restoreFetch = mockConfigFetch((input) => requested.push(String(input)));

  try {
    await renderShortcutWebApp();
    expect(requested).toContain("https://api.example.test/api/config");
  } finally {
    restoreFetch();
  }
});

test("WebAppRoot forwards auth-required responses from built-in requests", async () => {
  const previousFetch = globalThis.fetch;
  const events: string[] = [];
  const unsubscribe = onAuthRequired(() => events.push("auth"));
  configureWebAppClient({ apiBaseUrl: "https://api.example.test" });
  globalThis.fetch = (async () => Response.json(
    { error: "authentication_required", message: "Login required", details: { reason: "passkey" } },
    { status: 401, headers: { "x-webapp-passkey-required": "true" } },
  )) as unknown as typeof fetch;

  try {
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
      },
      routes: {
        home: createElement("p", null, "Home"),
      },
    }));

    await waitFor(() => expect(view.getByText("Unable to load app")).toBeTruthy());
    expect(view.getByText("Login required")).toBeTruthy();
    expect(events).toEqual(["auth"]);
  } finally {
    unsubscribe();
    globalThis.fetch = previousFetch;
  }
});

test("modal Enter shortcut does not confirm while an input is focused", () => {
  let confirmations = 0;
  const { getByLabelText } = render(createElement(ConfirmModal, {
    isOpen: true,
    onClose: () => {},
    onConfirm: () => {
      confirmations += 1;
    },
    title: "Confirm",
    message: "Type a value",
  }, createElement("input", { "aria-label": "Value" })));

  const input = getByLabelText("Value");
  input.focus();
  fireEvent.keyDown(input, { key: "Enter" });

  expect(confirmations).toBe(0);
});

test("confirm dialog exposes long-content actions and closes through confirm, Escape, and presence", async () => {
  let confirmations = 0;
  let cancellations = 0;

  function Harness() {
    const [open, setOpen] = useState(true);
    return createElement(
      "div",
      null,
      createElement("button", { type: "button", onClick: () => setOpen(true) }, "Open confirmation"),
      createElement(ConfirmDialog, {
        open,
        title: "Delete item?",
        message: "This permanently deletes the selected item and all of its associated transcript, metadata, and generated resources.",
        confirmLabel: "Delete selected item",
        danger: true,
        onCancel: () => {
          cancellations += 1;
          setOpen(false);
        },
        onConfirm: () => {
          confirmations += 1;
          setOpen(false);
        },
      }),
    );
  }

  const view = render(createElement(Harness));
  const dialog = view.getByRole("dialog", { name: "Delete item?" });
  expect(within(dialog).getByText(/associated transcript, metadata/)).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Delete selected item" })).toBeTruthy();

  fireEvent.click(within(dialog).getByRole("button", { name: "Delete selected item" }));
  expect(confirmations).toBe(1);
  await waitFor(() => expect(view.queryByRole("dialog", { name: "Delete item?" })).toBeNull());

  fireEvent.click(view.getByRole("button", { name: "Open confirmation" }));
  const reopenedDialog = await waitFor(() => view.getByRole("dialog", { name: "Delete item?" }));
  expect(reopenedDialog.isConnected).toBe(true);
  expect(reopenedDialog.closest('[aria-hidden="true"]')).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(cancellations).toBe(1);
  await waitFor(() => {
    expect(reopenedDialog.isConnected).toBe(false);
    expect(view.queryByRole("dialog", { name: "Delete item?" })).toBeNull();
  });
});

test("sidebar toggle control changes the accessible action", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();

    fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
    await waitFor(() => expect(view.queryByRole("button", { name: "Collapse sidebar" })).toBeNull());
    expect(view.getAllByRole("button", { name: "Show sidebar" }).length).toBeGreaterThan(0);

    fireEvent.click(view.getAllByRole("button", { name: "Show sidebar" })[0]!);
    await waitFor(() => expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy());
  } finally {
    restoreFetch();
  }
});

test("sidebar opening remains authoritative over a queued collapse toggle", async () => {
  const restoreFetch = mockConfigFetch();
  const restoreMobileMediaQuery = mockMobileMediaQuery(true);
  const controllerRef = createRef<WebAppRootController>();

  try {
    const view = await renderShortcutWebApp({ controllerRef, strictMode: true });
    const collapseSidebar = view.getByRole("button", { name: "Collapse sidebar" });

    await act(async () => {
      startTransition(() => collapseSidebar.click());
      controllerRef.current?.sidebar.open();
    });

    const showSidebar = await waitFor(() => view.getByRole("button", { name: "Show sidebar" }));
    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("true"));
  } finally {
    restoreMobileMediaQuery();
    restoreFetch();
  }
});

test("Ctrl+B and Cmd+B toggle the sidebar through one supported shortcut", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();

    const shortcuts = [
      { key: "b", ctrlKey: true },
      { key: "B", metaKey: true },
    ];
    for (const shortcut of shortcuts) {
      const dispatched = fireEvent.keyDown(document, { ...shortcut, cancelable: true });
      expect(dispatched).toBe(false);
      await waitFor(() => expect(view.queryByRole("button", { name: "Collapse sidebar" })).toBeNull());
      expect(view.getAllByRole("button", { name: "Show sidebar" }).length).toBeGreaterThan(0);

      fireEvent.keyDown(document, { ...shortcut, cancelable: true });
      await waitFor(() => expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy());
    }
  } finally {
    restoreFetch();
  }
});

test("sidebar shortcut does not interrupt editing in the search field", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp({ search: true });
    const searchInput = view.getByRole("textbox", { name: "Search" });
    searchInput.focus();

    const dispatched = fireEvent.keyDown(searchInput, { key: "b", ctrlKey: true, cancelable: true });
    expect(dispatched).toBe(true);
    expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
  } finally {
    restoreFetch();
  }
});

test("sidebar tree collapsed state persists across remounts", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const storageKey = "webapp.test-app.sidebar.collapsed";
    const firstView = await renderCollapsibleSidebarWebApp();
    const collapseProjects = await waitFor(() => firstView.getByRole("button", { name: /Projects/ }));

    fireEvent.click(collapseProjects);

    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({ projects: true }));
    firstView.unmount();

    const secondView = await renderCollapsibleSidebarWebApp();
    const expandProjects = await waitFor(() => secondView.getByRole("button", { name: /Projects/ }));

    expect(expandProjects.getAttribute("aria-expanded")).toBe("false");
  } finally {
    restoreFetch();
  }
});

test("sidebar tree honors default and persisted initialization state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const storageKey = "webapp.test-app.sidebar.collapsed";
    const scenarios = [
      { stored: undefined, expectedExpanded: false },
      { stored: JSON.stringify({ projects: false }), expectedExpanded: true },
      { stored: "{", expectedExpanded: false },
    ];

    for (const scenario of scenarios) {
      localStorage.removeItem(storageKey);
      if (scenario.stored !== undefined) {
        localStorage.setItem(storageKey, scenario.stored);
      }

      const view = await renderCollapsibleSidebarWebApp({ defaultCollapsed: true });
      const projectsToggle = await waitFor(() => view.getByRole("button", { name: /Projects/ }));

      expect(projectsToggle.getAttribute("aria-expanded")).toBe(String(scenario.expectedExpanded));
      view.unmount();
    }
  } finally {
    restoreFetch();
  }
});

test("sidebar search temporarily reveals matches without changing collapse state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const storageKey = "webapp.test-app.sidebar.collapsed";
    localStorage.setItem(storageKey, JSON.stringify({ projects: true }));
    const view = await renderSearchableCollapsibleSidebarWebApp({ sectionDefaultCollapsed: false });
    const searchInput = view.getByRole("textbox");
    const matchingChild = () => view.queryByRole("button", { name: /alpha/i });

    expect(matchingChild()).toBeNull();

    typeSearch(searchInput, "alpha");

    expect(await waitFor(() => view.getByRole("button", { name: /alpha/i }))).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({ projects: true });

    typeSearch(searchInput, "");
    await waitFor(() => expect(matchingChild()).toBeNull());
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({ projects: true });
  } finally {
    restoreFetch();
  }
});

test("sidebar whitespace-only search uses the empty normalized query", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: true,
        pinning: false,
        getNodes: ({ search }) => {
          return search
            ? [{ type: "item" as const, id: "whitespace-result", title: "Whitespace Result", route: { view: "whitespace" } }]
            : [{ type: "item" as const, id: "empty-result", title: "Empty Search Result", route: { view: "empty" } }];
        },
      },
      routes: {
        home: createElement("p", null, "Home"),
        empty: createElement("p", null, "Empty Search Result"),
        whitespace: createElement("p", null, "Whitespace Result"),
      },
    }));

    await waitFor(() => expect(view.getByRole("button", { name: "Empty Search Result" })).toBeTruthy());

    typeSearch(view.getByRole("textbox", { name: "Search" }), "   ");

    await waitFor(() => expect(view.getByRole("button", { name: "Empty Search Result" })).toBeTruthy());
    expect(view.queryByRole("button", { name: "Whitespace Result" })).toBeNull();
  } finally {
    restoreFetch();
  }
});

test("header actions use unfiltered sidebar nodes when search hides the active item", async () => {
  const restoreFetch = mockConfigFetch();
  window.location.hash = "";
  try {
    const { getByLabelText, getByRole, getByText, queryByRole } = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: true,
        pinning: false,
        getNodes: ({ search }) => filterSidebarNodesByTitle([
          { type: "item" as const, id: "home", title: "Home", route: { view: "home" } },
          {
            type: "item" as const,
            id: "target",
            title: "Hidden Target",
            route: { view: "target" },
            actions: [{ id: "inspect", label: "Inspect target", onAction: () => undefined }],
          },
        ], search),
      },
      routes: {
        home: createElement("p", null, "Home view"),
        target: createElement("p", null, "Target screen"),
      },
    }));

    await waitFor(() => expect(getByText("Home view")).toBeTruthy());

    typeSearch(getByRole("textbox", { name: "Search" }), "no matches");
    await waitFor(() => expect(queryByRole("button", { name: "Hidden Target" })).toBeNull());

    act(() => {
      window.location.hash = "#/target";
      window.dispatchEvent(new Event("hashchange"));
    });

    await waitFor(() => expect(getByText("Target screen")).toBeTruthy());

    fireEvent.click(await waitFor(() => getByLabelText("Actions for target")));

    expect(await waitFor(() => getByRole("menuitem", { name: "Inspect target" }))).toBeTruthy();
  } finally {
    window.location.hash = "";
    restoreFetch();
  }
});

test("header actions keep pinning actions from unfiltered active sidebar nodes", async () => {
  const restoreFetch = mockConfigFetch();
  window.location.hash = "";
  try {
    const { getByLabelText, getByRole, getByText, queryByRole } = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: true,
        getNodes: ({ search }) => filterSidebarNodesByTitle([
          { type: "item" as const, id: "home", title: "Home", route: { view: "home" } },
          {
            type: "item" as const,
            id: "target",
            title: "Pinned Target",
            route: { view: "target" },
            pinnable: true,
          },
        ], search),
      },
      routes: {
        home: createElement("p", null, "Home view"),
        target: createElement("p", null, "Target screen"),
      },
    }));

    await waitFor(() => expect(getByText("Home view")).toBeTruthy());

    typeSearch(getByRole("textbox", { name: "Search" }), "no matches");
    await waitFor(() => expect(queryByRole("button", { name: "Pinned Target" })).toBeNull());

    act(() => {
      window.location.hash = "#/target";
      window.dispatchEvent(new Event("hashchange"));
    });

    await waitFor(() => expect(getByText("Target screen")).toBeTruthy());

    fireEvent.click(await waitFor(() => getByLabelText("Actions for target")));

    expect(await waitFor(() => getByRole("menuitem", { name: "Pin to sidebar" }))).toBeTruthy();
  } finally {
    window.location.hash = "";
    restoreFetch();
  }
});

test("settings device sessions show empty state when no active sessions are returned", async () => {
  const restoreFetch = mockSettingsFetch([]);
  try {
    const { getByRole } = await renderSettingsWebApp();

    expect(getByRole("status", { name: "Empty state" })).toBeTruthy();
  } finally {
    restoreFetch();
  }
});

test("settings place app-defined sections before server operations and about", async () => {
  const restoreFetch = mockSettingsFetch([]);
  try {
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
      },
      routes: {
        home: createElement("p", null, "Home"),
      },
      settings: {
        sections: [
          {
            id: "app-settings",
            title: "Application settings",
            rows: [{ id: "sync", title: "Sync status" }],
          },
          {
            id: "advanced-app-settings",
            title: "Advanced application settings",
            rows: [{ id: "retention", title: "Retention" }],
          },
        ],
      },
    }));

    fireEvent.click(await waitFor(() => view.getByLabelText("Open settings")));
    await waitFor(() => expect(view.getByRole("heading", { name: "About", level: 3 })).toBeTruthy());

    const headings = view.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    const applicationSettingsIndex = headings.indexOf("Application settings");
    const advancedApplicationSettingsIndex = headings.indexOf("Advanced application settings");
    const serverOperationsIndex = headings.indexOf("Server operations");
    const aboutIndex = headings.indexOf("About");

    expect(applicationSettingsIndex).toBeGreaterThanOrEqual(0);
    expect(advancedApplicationSettingsIndex).toBeGreaterThanOrEqual(0);
    expect(serverOperationsIndex).toBeGreaterThanOrEqual(0);
    expect(aboutIndex).toBeGreaterThanOrEqual(0);
    expect(applicationSettingsIndex).toBeLessThan(serverOperationsIndex);
    expect(advancedApplicationSettingsIndex).toBeLessThan(serverOperationsIndex);
    expect(aboutIndex).toBe(serverOperationsIndex + 1);
  } finally {
    restoreFetch();
  }
});

test("user-management list failures are distinct from empty results and support retry", async () => {
  const user: WebAppUserSummary = {
    id: "user-1",
    username: "alice",
    role: "user",
    passkeyConfigured: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const mock = mockBuiltInFetch({
    userManagement: true,
    responses: {
      "/api/users": [
        () => Response.json({ message: "Users unavailable" }, { status: 503 }),
        () => Response.json([user]),
      ],
    },
  });
  try {
    const view = await renderBuiltInSettingsWebApp();

    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    const alert = view.getByRole("alert");
    expect(within(alert).getByRole("button")).toBeTruthy();
    expect(view.queryByRole("status", { name: "Empty state" })).toBeNull();

    fireEvent.click(within(alert).getByRole("button"));

    await waitFor(() => expect(view.getByText("alice")).toBeTruthy());
    expect(mock.requestCount("/api/users")).toBe(2);
  } finally {
    mock.restoreFetch();
  }
});

test("successful empty built-in lists render empty states without failures", async () => {
  const mock = mockBuiltInFetch({ apiKeysEnabled: true, deviceAuthEnabled: true });
  try {
    const view = await renderBuiltInSettingsWebApp();

    await waitFor(() => expect(view.getAllByRole("status", { name: "Empty state" })).toHaveLength(2));
    expect(view.queryByRole("alert")).toBeNull();
  } finally {
    mock.restoreFetch();
  }
});

test("API-key failures can be retried without hiding an independent empty session list", async () => {
  const key: ApiKeySummary = {
    id: "key-1",
    name: "Automation key",
    prefix: "wapp_test",
    scopes: ["*"],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const mock = mockBuiltInFetch({
    apiKeysEnabled: true,
    deviceAuthEnabled: true,
    responses: {
      "/api/api-keys": [
        () => Response.json({ message: "API keys unavailable" }, { status: 503 }),
        () => Response.json([key]),
      ],
    },
  });
  try {
    const view = await renderBuiltInSettingsWebApp();

    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    const alert = view.getByRole("alert");
    expect(within(alert).getByRole("button")).toBeTruthy();
    expect(view.getByRole("status", { name: "Empty state" })).toBeTruthy();
    expect(view.getAllByRole("status", { name: "Empty state" })).toHaveLength(1);

    fireEvent.click(within(alert).getByRole("button"));

    await waitFor(() => expect(view.getByText("Automation key")).toBeTruthy());
    expect(view.queryByRole("alert")).toBeNull();
    expect(mock.requestCount("/api/api-keys")).toBe(2);
  } finally {
    mock.restoreFetch();
  }
});

test("Settings renders the sanitized user API-key list", async () => {
  const key: ApiKeySummary = {
    id: "user-key-1",
    name: "Browser key",
    prefix: "wapp_user",
    scopes: ["*"],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const mock = mockBuiltInFetch({ apiKeysEnabled: true, apiKeys: [key] });
  try {
    const view = await renderBuiltInSettingsWebApp();

    await waitFor(() => expect(view.getByText("Browser key")).toBeTruthy());
    expect(view.queryByText("runtime-context")).toBeNull();
    expect(view.queryByText("managed")).toBeNull();
  } finally {
    mock.restoreFetch();
  }
});

test("device-session failures can be retried without treating them as empty", async () => {
  const session: AuthSessionSummary = {
    id: "session-1",
    clientId: "cli",
    scope: "*",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    active: true,
  };
  const mock = mockBuiltInFetch({
    deviceAuthEnabled: true,
    responses: {
      "/api/auth/sessions": [
        () => Response.json({ message: "Sessions unavailable" }, { status: 503 }),
        () => Response.json([session]),
      ],
    },
  });
  try {
    const view = await renderBuiltInSettingsWebApp();

    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    const alert = view.getByRole("alert");
    expect(within(alert).getByRole("button")).toBeTruthy();
    expect(view.queryByRole("status", { name: "Empty state" })).toBeNull();

    fireEvent.click(within(alert).getByRole("button"));

    await waitFor(() => expect(view.getByText("cli")).toBeTruthy());
    expect(mock.requestCount("/api/auth/sessions")).toBe(2);
  } finally {
    mock.restoreFetch();
  }
});

test("failed list refresh preserves previously loaded user data", async () => {
  const user: WebAppUserSummary = {
    id: "user-1",
    username: "alice",
    role: "user",
    passkeyConfigured: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const mock = mockBuiltInFetch({
    userManagement: true,
    responses: {
      "/api/users": [
        () => Response.json([user]),
        () => Response.json({ message: "Users refresh unavailable" }, { status: 503 }),
      ],
    },
  });
  try {
    const view = await renderBuiltInSettingsWebApp();
    const roleSelect = await waitFor(() => view.getByLabelText("Role for alice"));

    fireEvent.change(roleSelect, { target: { value: "admin" } });

    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(view.getByText("alice")).toBeTruthy();
    expect(mock.requestCount("/api/users")).toBe(2);
  } finally {
    mock.restoreFetch();
  }
});

test("authentication-required list responses keep shared auth handling and show failure UI", async () => {
  const events: string[] = [];
  const unsubscribe = onAuthRequired(() => events.push("auth"));
  const mock = mockBuiltInFetch({
    apiKeysEnabled: true,
    responses: {
      "/api/api-keys": [
        () => Response.json(
          { error: "authentication_required", message: "Login required" },
          { status: 401, headers: { "x-webapp-passkey-required": "true" } },
        ),
      ],
    },
  });
  try {
    const view = await renderBuiltInSettingsWebApp();

    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(events).toEqual(["auth"]);
    expect(view.queryByRole("status", { name: "Empty state" })).toBeNull();
  } finally {
    unsubscribe();
    mock.restoreFetch();
  }
});

test("theme preference failures preserve the local theme and can be retried", async () => {
  localStorage.setItem("webapp.theme", "light");
  const mock = mockBuiltInFetch({
    theme: "dark",
    responses: {
      "/api/preferences/theme": [
        () => Response.json({ message: "Theme unavailable" }, { status: 503 }),
        () => Response.json({ theme: "dark" }),
      ],
    },
  });
  try {
    const view = await renderBuiltInSettingsWebApp();
    const theme = await waitFor(() => view.getByLabelText("Theme") as HTMLSelectElement);

    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(theme.value).toBe("light");

    fireEvent.click(within(view.getByRole("alert")).getByRole("button"));

    await waitFor(() => expect((view.getByLabelText("Theme") as HTMLSelectElement).value).toBe("dark"));
    expect(view.queryByRole("alert")).toBeNull();
    expect(mock.requestCount("/api/preferences/theme")).toBe(2);
  } finally {
    mock.restoreFetch();
  }
});

test("public theme hook shares state with framework settings", async () => {
  localStorage.setItem("webapp.theme", "light");
  const mock = mockBuiltInFetch({ theme: "dark" });
  try {
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
      },
      routes: {
        home: createElement("p", null, "Home"),
      },
      settings: {
        sections: [{
          id: "theme-probe",
          title: "Theme probe",
          scope: "user",
          render: () => createElement(ThemeStateProbe),
        }],
      },
    }));

    fireEvent.click(await waitFor(() => view.getByLabelText("Open settings")));
    await waitFor(() => expect(view.getByText("Display Settings")).toBeTruthy());
    await waitFor(() => expect(view.getByLabelText("theme state").textContent).toBe("dark:dark"));

    fireEvent.change(view.getByLabelText("Theme"), { target: { value: "light" } });
    await waitFor(() => expect(view.getByLabelText("theme state").textContent).toBe("light:light"));
  } finally {
    mock.restoreFetch();
  }
});

test("settings kill server surfaces failures without starting the shutdown countdown", async () => {
  const restoreFetch = mockSettingsFetch([]);
  try {
    const view = await renderSettingsWebApp();
    fireEvent.click(view.getByRole("button", { name: "Kill server" }));

    const dialog = await waitFor(() => view.getByRole("dialog", { name: "Kill server?" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Kill server" }));

    await waitFor(() => expect(view.getByText("Not found")).toBeTruthy());
    expect(view.queryByText(/Server is shutting down/)).toBeNull();
  } finally {
    restoreFetch();
  }
});

test("mobile sidebar backdrop closes the open sidebar", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();
    const showSidebar = view.getByRole("button", { name: "Show sidebar" });

    expect(showSidebar.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(showSidebar);
    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("true"));

    const backdrop = view.getByRole("button", { name: "Close sidebar" });
    fireEvent.pointerDown(backdrop, { button: 0 });

    await waitFor(() => {
      expect(backdrop.getAttribute("aria-hidden")).toBe("true");
      expect(backdrop.getAttribute("tabindex")).toBe("-1");
    });
    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("false"));
  } finally {
    restoreFetch();
  }
});

test("mobile sidebar opening is not consumed by a late backdrop click", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();
    const showSidebar = view.getByRole("button", { name: "Show sidebar" });

    fireEvent.click(showSidebar);
    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("true"));

    const backdrop = view.getByRole("button", { name: "Close sidebar" });
    fireEvent.click(backdrop, { detail: 1 });
    expect(showSidebar.getAttribute("aria-expanded")).toBe("true");

    fireEvent.pointerDown(backdrop);
    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("false"));
  } finally {
    restoreFetch();
  }
});

test("mobile sidebar backdrop supports non-pointer activation", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();
    const showSidebar = view.getByRole("button", { name: "Show sidebar" });

    fireEvent.click(showSidebar);
    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("true"));

    fireEvent.click(view.getByRole("button", { name: "Close sidebar" }), { detail: 0 });

    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("false"));
  } finally {
    restoreFetch();
  }
});

test("mobile sidebar dismiss does not activate background content", async () => {
  const restoreFetch = mockConfigFetch();
  const restoreMobileMediaQuery = mockMobileMediaQuery(true);
  let backgroundActivations = 0;
  let backgroundPointerDowns = 0;
  const handleBackgroundPointerDown = () => {
    backgroundPointerDowns += 1;
  };
  document.addEventListener("pointerdown", handleBackgroundPointerDown);

  try {
    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
      },
      routes: {
        home: createElement(
          "button",
          { type: "button", onClick: () => { backgroundActivations += 1; } },
          "Background action",
        ),
      },
    }));

    const showSidebar = await waitFor(() => view.getByRole("button", { name: "Show sidebar" }));
    fireEvent.click(showSidebar);
    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("true"));

    const backdrop = view.getByRole("button", { name: "Close sidebar" });
    const backgroundAction = view.getByRole("button", { name: "Background action" });
    fireEvent.pointerDown(backdrop, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(backdrop, { button: 0, pointerId: 1 });
    fireEvent.click(backgroundAction, { detail: 1 });

    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("false"));
    expect(backgroundPointerDowns).toBe(0);
    expect(backgroundActivations).toBe(0);

    await waitFor(() => expect(backdrop.isConnected).toBe(false));
    fireEvent.pointerDown(backgroundAction, { button: 0, pointerId: 2 });
    fireEvent.pointerUp(backgroundAction, { button: 0, pointerId: 2 });
    fireEvent.click(backgroundAction, { detail: 1 });
    expect(backgroundPointerDowns).toBe(1);
    expect(backgroundActivations).toBe(1);
  } finally {
    document.removeEventListener("pointerdown", handleBackgroundPointerDown);
    restoreMobileMediaQuery();
    restoreFetch();
  }
});

test("mobile left-edge swipe opens navigation", async () => {
  const restoreFetch = mockConfigFetch();
  const restoreMobileMediaQuery = mockMobileMediaQuery(true);
  try {
    const view = await renderShortcutWebApp();
    const showSidebar = view.getByRole("button", { name: "Show sidebar" });

    fireEvent.touchStart(document, {
      touches: [{ clientX: 4, clientY: 240 }],
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 128, clientY: 240 }],
      cancelable: true,
    });

    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("true"));
  } finally {
    restoreMobileMediaQuery();
    restoreFetch();
  }
});

test("mobile shell follows the visual viewport while an editable control has focus", async () => {
  const restoreFetch = mockConfigFetch();
  const restoreMobileMediaQuery = mockMobileMediaQuery(true);
  const previousCSSDescriptor = Object.getOwnPropertyDescriptor(window, "CSS");
  const previousVisualViewportDescriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const previousInnerHeightDescriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");
  const visualViewport = createVisualViewportFixture(800);

  try {
    Object.defineProperty(window, "CSS", {
      configurable: true,
      value: { supports: () => true },
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport.viewport,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });

    const view = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: false,
        pinning: false,
        getNodes: () => [{ type: "item" as const, id: "home", title: "Home", route: { view: "home" } }],
      },
      routes: {
        home: createElement("textarea", { "aria-label": "Message" }),
      },
    }));
    const input = await waitFor(() => view.getByRole("textbox", { name: "Message" }));

    input.focus();
    visualViewport.setHeight(420);
    visualViewport.emit("resize");

    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--wapp-viewport-height")).toBe("420px"));

    input.blur();
    visualViewport.setHeight(800);
    visualViewport.emit("resize");

    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--wapp-viewport-height")).toBe(""));
  } finally {
    restoreMobileMediaQuery();
    restoreFetch();
    if (previousCSSDescriptor) {
      Object.defineProperty(window, "CSS", previousCSSDescriptor);
    } else {
      Reflect.deleteProperty(window, "CSS");
    }
    if (previousVisualViewportDescriptor) {
      Object.defineProperty(window, "visualViewport", previousVisualViewportDescriptor);
    } else {
      Reflect.deleteProperty(window, "visualViewport");
    }
    if (previousInnerHeightDescriptor) {
      Object.defineProperty(window, "innerHeight", previousInnerHeightDescriptor);
    } else {
      Reflect.deleteProperty(window, "innerHeight");
    }
  }
});
