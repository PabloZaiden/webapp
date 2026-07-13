import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { ConfirmModal } from "../src/web/components";
import type { ApiKeySummary, AuthSessionSummary, ThemePreference, WebAppConfigResponse, WebAppUserSummary } from "../src/contracts";
import { configureWebAppClient, onAuthRequired } from "../src/web/api-client";
import { MOBILE_MEDIA_QUERY } from "../src/web/mobile";
import type { SidebarNode } from "../src/web/sidebar/types";
import { WebAppRoot } from "../src/web/WebAppRoot";
import { configureWebAppRenderer, renderWebApp } from "../src/web/render";

GlobalRegistrator.register({ url: "http://localhost/" });
configureWebAppRenderer(createRoot);

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  localStorage.clear();
  configureWebAppClient();
  window.history.replaceState(null, "", "http://localhost/");
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

async function renderShortcutWebApp() {
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

  await waitFor(() => expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy());
  await act(async () => {});

  return view;
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

async function renderCollapsibleSidebarWebApp({ defaultCollapsed = false } = {}) {
  const view = render(createElement(WebAppRoot, {
    appName: "Test App",
    homeRoute: { view: "home" },
    sidebar: {
      search: false,
      pinning: false,
      getNodes: () => [
        {
          type: "section" as const,
          id: "projects",
          title: "Projects",
          defaultCollapsed,
          children: [{ type: "item" as const, id: "alpha", title: "Alpha", route: { view: "alpha" } }],
        },
        {
          type: "item" as const,
          id: "group",
          title: "Group",
          children: [{ type: "item" as const, id: "child", title: "Child", route: { view: "child" } }],
        },
      ],
    },
    routes: {
      home: createElement("p", null, "Home"),
      alpha: createElement("p", null, "Alpha"),
      child: createElement("p", null, "Child"),
    },
  }));

  await waitFor(() => expect(view.getByText("Projects")).toBeTruthy());

  return view;
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

async function renderSearchableCollapsibleSidebarWebApp({ sectionDefaultCollapsed = true, groupDefaultCollapsed = true } = {}) {
  const view = render(createElement(WebAppRoot, {
    appName: "Test App",
    homeRoute: { view: "home" },
    sidebar: {
      search: true,
      pinning: false,
      getNodes: ({ search }) => filterSidebarNodesByTitle([
        {
          type: "section" as const,
          id: "projects",
          title: "Projects",
          defaultCollapsed: sectionDefaultCollapsed,
          children: [{ type: "item" as const, id: "alpha", title: "Alpha", route: { view: "alpha" } }],
        },
        {
          type: "item" as const,
          id: "group",
          title: "Group",
          defaultCollapsed: groupDefaultCollapsed,
          children: [{ type: "item" as const, id: "child", title: "Child", route: { view: "child" } }],
        },
      ], search),
    },
    routes: {
      home: createElement("p", null, "Home"),
      alpha: createElement("p", null, "Alpha"),
      child: createElement("p", null, "Child"),
    },
  }));

  await waitFor(() => expect(view.getByText("Projects")).toBeTruthy());

  return view;
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

test("renderWebApp reuses the existing React root for the same container", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };

  try {
    const firstRoot = renderWebApp(createElement("div", null, "first"), container);
    const secondRoot = renderWebApp(createElement("div", null, "second"), container);

    expect(secondRoot).toBe(firstRoot);
    expect(messages.some((message) => message.includes("createRoot() on a container"))).toBe(false);
  } finally {
    console.error = originalError;
  }
});

test("mockConfigFetch matches config requests from string, URL, and Request inputs", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    await expect(fetch("/api/config").then((response) => response.json())).resolves.toMatchObject({ appName: "Test App" });
    await expect(fetch(new URL("http://localhost/api/config")).then((response) => response.json())).resolves.toMatchObject({ appName: "Test App" });
    await expect(fetch(new Request("http://localhost/api/config")).then((response) => response.json())).resolves.toMatchObject({ appName: "Test App" });
  } finally {
    restoreFetch();
  }
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

test("Ctrl+B toggles the sidebar collapsed state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();

    expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();

    const collapseDispatched = fireEvent.keyDown(document, { key: "b", ctrlKey: true, cancelable: true });
    expect(collapseDispatched).toBe(false);
    await waitFor(() => expect(view.queryAllByRole("button", { name: "Collapse sidebar" })).toHaveLength(0));

    const expandDispatched = fireEvent.keyDown(document, { key: "b", ctrlKey: true, cancelable: true });
    expect(expandDispatched).toBe(false);
    await waitFor(() => expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy());
  } finally {
    restoreFetch();
  }
});

test("Cmd+B toggles the sidebar collapsed state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();

    fireEvent.keyDown(document, { key: "B", metaKey: true });
    await waitFor(() => expect(view.queryAllByRole("button", { name: "Collapse sidebar" })).toHaveLength(0));

    fireEvent.keyDown(document, { key: "b", metaKey: true });
    await waitFor(() => expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy());
  } finally {
    restoreFetch();
  }
});

test("sidebar shortcut ignores non-exact key combinations", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();

    fireEvent.keyDown(document, { key: "b" });
    fireEvent.keyDown(document, { key: "b", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document, { key: "b", ctrlKey: true, metaKey: true });
    fireEvent.keyDown(document, { key: "b", ctrlKey: true, repeat: true });
    fireEvent.keyDown(document, { key: "b", ctrlKey: true, isComposing: true });

    expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
  } finally {
    restoreFetch();
  }
});

test("sidebar shortcut ignores text-editing targets", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();
    const targets = [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("select"),
      document.createElement("div"),
    ];
    targets[3].setAttribute("contenteditable", "true");
    document.body.append(...targets);

    for (const target of targets) {
      target.focus();
      const dispatched = fireEvent.keyDown(target, { key: "b", ctrlKey: true, cancelable: true });
      expect(dispatched).toBe(true);
      expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    }
  } finally {
    restoreFetch();
  }
});

test("sidebar toggle label reflects the current action", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const view = await renderShortcutWebApp();

    expect(view.getAllByRole("button", { name: "Collapse sidebar" })).toHaveLength(1);

    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    await waitFor(() => expect(view.queryAllByRole("button", { name: "Collapse sidebar" })).toHaveLength(0));
    expect(view.getAllByRole("button", { name: "Show sidebar" }).length).toBeGreaterThan(0);
  } finally {
    restoreFetch();
  }
});

test("sidebar tree collapsed state persists across remounts", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const storageKey = "webapp.test-app.sidebar.collapsed";
    const firstView = await renderCollapsibleSidebarWebApp();
    const collapseProjects = await waitFor(() => firstView.getByLabelText("Collapse Projects"));

    fireEvent.click(collapseProjects);

    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({ projects: true }));
    firstView.unmount();

    const secondView = await renderCollapsibleSidebarWebApp();
    const expandProjects = await waitFor(() => secondView.getByLabelText("Expand Projects"));

    expect(expandProjects.getAttribute("aria-expanded")).toBe("false");
  } finally {
    restoreFetch();
  }
});

test("sidebar tree persists item collapsed state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const storageKey = "webapp.test-app.sidebar.collapsed";
    const { getByLabelText } = await renderCollapsibleSidebarWebApp();

    fireEvent.click(await waitFor(() => getByLabelText("Collapse Group")));

    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({ group: true }));
  } finally {
    restoreFetch();
  }
});

test("sidebar tree rapid toggles use the latest collapsed state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const storageKey = "webapp.test-app.sidebar.collapsed";
    const { getByLabelText } = await renderCollapsibleSidebarWebApp();
    const collapseProjects = await waitFor(() => getByLabelText("Collapse Projects"));

    await act(async () => {
      collapseProjects.click();
      collapseProjects.click();
    });

    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({ projects: false }));
    const stillExpandedProjects = await waitFor(() => getByLabelText("Collapse Projects"));
    expect(stillExpandedProjects.getAttribute("aria-expanded")).toBe("true");
  } finally {
    restoreFetch();
  }
});

test("sidebar tree uses defaultCollapsed when no stored state exists", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const { getByLabelText } = await renderCollapsibleSidebarWebApp({ defaultCollapsed: true });
    const expandProjects = await waitFor(() => getByLabelText("Expand Projects"));

    expect(expandProjects.getAttribute("aria-expanded")).toBe("false");
  } finally {
    restoreFetch();
  }
});

test("sidebar tree stored expanded state overrides defaultCollapsed", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    localStorage.setItem("webapp.test-app.sidebar.collapsed", JSON.stringify({ projects: false }));

    const { getByLabelText } = await renderCollapsibleSidebarWebApp({ defaultCollapsed: true });
    const collapseProjects = await waitFor(() => getByLabelText("Collapse Projects"));

    expect(collapseProjects.getAttribute("aria-expanded")).toBe("true");
  } finally {
    restoreFetch();
  }
});

test("sidebar tree ignores corrupt stored collapsed state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    localStorage.setItem("webapp.test-app.sidebar.collapsed", "{");

    const { getByLabelText } = await renderCollapsibleSidebarWebApp({ defaultCollapsed: true });
    const expandProjects = await waitFor(() => getByLabelText("Expand Projects"));

    expect(expandProjects.getAttribute("aria-expanded")).toBe("false");
  } finally {
    restoreFetch();
  }
});

test("sidebar search expands default-collapsed sections with matching children", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const { getByLabelText, getByPlaceholderText, getByText } = await renderSearchableCollapsibleSidebarWebApp();

    expect(await waitFor(() => getByLabelText("Expand Projects"))).toBeTruthy();

    typeSearch(getByPlaceholderText("Search"), "alpha");

    const disabledProjectsToggle = await waitFor(() => getByLabelText("Toggling unavailable during search for Projects"));
    expect(disabledProjectsToggle.getAttribute("aria-expanded")).toBe("true");
    expect((disabledProjectsToggle as HTMLButtonElement).disabled).toBe(true);
    expect(getByText("Alpha")).toBeTruthy();
  } finally {
    restoreFetch();
  }
});

test("sidebar whitespace-only search uses the empty normalized query", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const getNodesSearches: string[] = [];
    const { getByPlaceholderText, getByText, queryByText } = render(createElement(WebAppRoot, {
      appName: "Test App",
      homeRoute: { view: "home" },
      sidebar: {
        search: true,
        pinning: false,
        getNodes: ({ search }) => {
          getNodesSearches.push(search);
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

    await waitFor(() => expect(getByText("Empty Search Result")).toBeTruthy());

    typeSearch(getByPlaceholderText("Search"), "   ");

    await waitFor(() => expect(getByText("Empty Search Result")).toBeTruthy());
    expect(queryByText("Whitespace Result")).toBeNull();
    expect(getNodesSearches).not.toContain("   ");
  } finally {
    restoreFetch();
  }
});

test("header actions use unfiltered sidebar nodes when search hides the active item", async () => {
  const restoreFetch = mockConfigFetch();
  window.location.hash = "";
  try {
    const { getByLabelText, getByPlaceholderText, getByRole, getByText, queryByText } = render(createElement(WebAppRoot, {
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

    typeSearch(getByPlaceholderText("Search"), "no matches");
    await waitFor(() => expect(queryByText("Hidden Target")).toBeNull());

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
    const { getByLabelText, getByPlaceholderText, getByRole, getByText, queryByText } = render(createElement(WebAppRoot, {
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

    typeSearch(getByPlaceholderText("Search"), "no matches");
    await waitFor(() => expect(queryByText("Pinned Target")).toBeNull());

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

test("sidebar search expands stored-collapsed sections without changing storage", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const storageKey = "webapp.test-app.sidebar.collapsed";
    localStorage.setItem(storageKey, JSON.stringify({ projects: true }));
    const { getByLabelText, getByPlaceholderText, getByText } = await renderSearchableCollapsibleSidebarWebApp({ sectionDefaultCollapsed: false });

    typeSearch(getByPlaceholderText("Search"), "alpha");

    const disabledProjectsToggle = await waitFor(() => getByLabelText("Toggling unavailable during search for Projects"));
    expect(disabledProjectsToggle.getAttribute("aria-expanded")).toBe("true");
    expect((disabledProjectsToggle as HTMLButtonElement).disabled).toBe(true);
    expect(getByText("Alpha")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({ projects: true });
  } finally {
    restoreFetch();
  }
});

test("sidebar search toggle clicks do not persist collapsed state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const storageKey = "webapp.test-app.sidebar.collapsed";
    localStorage.setItem(storageKey, JSON.stringify({ projects: true }));
    const { getByLabelText, getByPlaceholderText } = await renderSearchableCollapsibleSidebarWebApp({ sectionDefaultCollapsed: false });

    typeSearch(getByPlaceholderText("Search"), "alpha");
    const disabledProjectsToggle = await waitFor(() => getByLabelText("Toggling unavailable during search for Projects"));
    expect((disabledProjectsToggle as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(disabledProjectsToggle);

    expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({ projects: true });
  } finally {
    restoreFetch();
  }
});

test("sidebar search clear button restores stored collapsed section state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    localStorage.setItem("webapp.test-app.sidebar.collapsed", JSON.stringify({ projects: true }));
    const { getByLabelText, getByPlaceholderText, queryByLabelText, queryByText } = await renderSearchableCollapsibleSidebarWebApp({ sectionDefaultCollapsed: false });
    const searchInput = getByPlaceholderText("Search");

    expect(queryByLabelText("Clear search")).toBeNull();
    typeSearch(searchInput, "alpha");
    const disabledProjectsToggle = await waitFor(() => getByLabelText("Toggling unavailable during search for Projects"));
    expect((disabledProjectsToggle as HTMLButtonElement).disabled).toBe(true);
    expect((searchInput as HTMLInputElement).value).toBe("alpha");

    fireEvent.click(await waitFor(() => getByLabelText("Clear search")));

    await waitFor(() => expect((searchInput as HTMLInputElement).value).toBe(""));
    expect(queryByLabelText("Clear search")).toBeNull();
    const expandProjects = await waitFor(() => getByLabelText("Expand Projects"));
    expect(expandProjects.getAttribute("aria-expanded")).toBe("false");
    expect((expandProjects as HTMLButtonElement).disabled).toBe(false);
    expect(queryByText("Alpha")).toBeNull();
  } finally {
    restoreFetch();
  }
});

test("sidebar search expands item groups with matching children without persisting toggles", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const storageKey = "webapp.test-app.sidebar.collapsed";
    localStorage.setItem(storageKey, JSON.stringify({ group: true }));
    const { getByLabelText, getByPlaceholderText, getByText } = await renderSearchableCollapsibleSidebarWebApp({ groupDefaultCollapsed: false });

    typeSearch(getByPlaceholderText("Search"), "child");

    const disabledGroupToggle = await waitFor(() => getByLabelText("Toggling unavailable during search for Group"));
    expect(disabledGroupToggle.getAttribute("aria-expanded")).toBe("true");
    expect((disabledGroupToggle as HTMLButtonElement).disabled).toBe(true);
    expect(getByText("Child")).toBeTruthy();

    fireEvent.click(disabledGroupToggle);
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toEqual({ group: true });
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

test("mobile left-edge swipe opens the sidebar", async () => {
  const restoreFetch = mockConfigFetch();
  const restoreMobileMediaQuery = mockMobileMediaQuery(true);
  try {
    const view = await renderShortcutWebApp();
    const showSidebar = view.getByRole("button", { name: "Show sidebar" });

    fireEvent.touchStart(document, {
      touches: [{ clientX: 8, clientY: 240 }],
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 80, clientY: 248 }],
      cancelable: true,
    });

    await waitFor(() => expect(showSidebar.getAttribute("aria-expanded")).toBe("true"));
  } finally {
    restoreMobileMediaQuery();
    restoreFetch();
  }
});

test("desktop sidebar ignores left-edge swipe", async () => {
  const restoreFetch = mockConfigFetch();
  const restoreMobileMediaQuery = mockMobileMediaQuery(false);
  try {
    const view = await renderShortcutWebApp();
    const showSidebar = view.getByRole("button", { name: "Show sidebar" });

    fireEvent.touchStart(document, {
      touches: [{ clientX: 8, clientY: 240 }],
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 80, clientY: 248 }],
      cancelable: true,
    });

    expect(showSidebar.getAttribute("aria-expanded")).toBe("false");
  } finally {
    restoreMobileMediaQuery();
    restoreFetch();
  }
});

test("mobile sidebar swipe ignores touches away from the left edge", async () => {
  const restoreFetch = mockConfigFetch();
  const restoreMobileMediaQuery = mockMobileMediaQuery(true);
  try {
    const view = await renderShortcutWebApp();
    const showSidebar = view.getByRole("button", { name: "Show sidebar" });

    fireEvent.touchStart(document, {
      touches: [{ clientX: 40, clientY: 240 }],
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 120, clientY: 240 }],
      cancelable: true,
    });
    expect(showSidebar.getAttribute("aria-expanded")).toBe("false");
  } finally {
    restoreMobileMediaQuery();
    restoreFetch();
  }
});

test("mobile sidebar swipe cancels after diagonal movement", async () => {
  const restoreFetch = mockConfigFetch();
  const restoreMobileMediaQuery = mockMobileMediaQuery(true);
  try {
    const view = await renderShortcutWebApp();
    const showSidebar = view.getByRole("button", { name: "Show sidebar" });

    fireEvent.touchStart(document, {
      touches: [{ clientX: 8, clientY: 240 }],
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 40, clientY: 280 }],
      cancelable: true,
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 80, clientY: 280 }],
      cancelable: true,
    });

    expect(showSidebar.getAttribute("aria-expanded")).toBe("false");
  } finally {
    restoreMobileMediaQuery();
    restoreFetch();
  }
});
