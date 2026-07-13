import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { ConfirmModal } from "../src/web/components";
import type { ApiKeySummary, AuthSessionSummary, ThemePreference, WebAppConfigResponse, WebAppUserSummary } from "../src/contracts";
import { configureWebAppClient, onAuthRequired } from "../src/web/api-client";
import { MOBILE_MEDIA_QUERY } from "../src/web/mobile";
import type { SidebarNode } from "../src/web/sidebar/types";
import { useTheme } from "../src/web/theme";
import { WebAppRoot } from "../src/web/WebAppRoot";
import { configureWebAppRenderer, renderWebApp } from "../src/web/render";

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

function mockConfigFetch(onRequest?: (input: RequestInfo | URL, init?: RequestInit) => void) {
  const previousFetch = globalThis.fetch;
  const config: WebAppConfigResponse = {
    appName: "Test App",
    version: "1.0.0",
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
    deviceAuth: {
      enabled: false,
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
    if (fetchPath(input) === "/api/config") {
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
  const { search = false } = options;
  const view = render(createElement(WebAppRoot, {
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
  }));

  await waitFor(() => expect(view.getByRole("button", { name: /Projects/ })).toBeTruthy());

  return view;
}

async function renderShortcutWebApp({ search = false } = {}) {
  const view = await renderSidebarWebApp({ search });

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
      onRouteChange: (route) => routeChanges.push(`${route.view}:${route.projectId ?? ""}`),
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

test("sidebar toggle control changes the accessible action", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();

    fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
    await waitFor(() => expect(view.queryByRole("button", { name: "Collapse sidebar" })).toBeNull());
    expect(view.getAllByRole("button", { name: "Show sidebar" }).length).toBeGreaterThan(0);

    fireEvent.click(view.getAllByRole("button", { name: "Show sidebar" })[0]);
    await waitFor(() => expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy());
  } finally {
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

    fireEvent.click(view.getByRole("button", { name: "Close sidebar" }));

    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("false"));
  } finally {
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
