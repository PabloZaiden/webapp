import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Button, ConfirmModal, Modal } from "../src/web/components";
import type { WebAppConfigResponse } from "../src/contracts";
import type { BadgeVariant, SidebarNode } from "../src/web/sidebar/types";
import { WebAppRoot } from "../src/web/WebAppRoot";
import { renderWebApp } from "../src/web/render";

GlobalRegistrator.register();

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.body.style.overflow = "";
  localStorage.clear();
});

function mockConfigFetch() {
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

  globalThis.fetch = (async (input: RequestInfo | URL) => {
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

  const shell = await waitFor(() => {
    const element = view.container.querySelector(".wapp-shell");
    expect(element).toBeTruthy();
    return element as HTMLElement;
  });

  return { ...view, shell };
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

  await waitFor(() => expect(view.container.querySelector(".wapp-shell")).toBeTruthy());

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

  await waitFor(() => expect(view.container.querySelector(".wapp-shell")).toBeTruthy());

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

function cssRule(css: string, selector: string) {
  const ruleStart = css.indexOf(`${selector} {`);
  expect(ruleStart).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", ruleStart);
  const bodyEnd = css.indexOf("}", bodyStart);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return css.slice(bodyStart + 1, bodyEnd);
}

function cssRulesForSelector(css: string, selector: string) {
  const rules: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
    const selectors = match[1]!.split(",").map((part) => part.trim());
    if (selectors.includes(selector)) {
      rules.push(match[2]!);
    }
  }
  expect(rules.length).toBeGreaterThan(0);
  return rules;
}

function selectorHasDeclaration(css: string, selector: string, declaration: string) {
  return cssRulesForSelector(css, selector).some((rule) => rule.includes(declaration));
}

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

test("modal scroll lock remains active until the last stacked modal closes", () => {
  document.body.style.overflow = "auto";
  const modal = (title: string) => createElement(Modal, {
    isOpen: true,
    onClose: () => {},
    title,
    footer: createElement(Button, { type: "button" }, "Close"),
    children: createElement("p", null, title),
  });
  const { rerender, unmount } = render(createElement("div", null, modal("First"), modal("Second")));

  expect(document.body.style.overflow).toBe("hidden");

  rerender(createElement("div", null, modal("First")));
  expect(document.body.style.overflow).toBe("hidden");

  unmount();
  expect(document.body.style.overflow).toBe("auto");
});

test("Ctrl+B toggles the sidebar collapsed state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const { shell } = await renderShortcutWebApp();

    expect(shell.classList.contains("sidebar-collapsed")).toBe(false);

    const collapseDispatched = fireEvent.keyDown(document, { key: "b", ctrlKey: true, cancelable: true });
    expect(collapseDispatched).toBe(false);
    await waitFor(() => expect(shell.classList.contains("sidebar-collapsed")).toBe(true));

    const expandDispatched = fireEvent.keyDown(document, { key: "b", ctrlKey: true, cancelable: true });
    expect(expandDispatched).toBe(false);
    await waitFor(() => expect(shell.classList.contains("sidebar-collapsed")).toBe(false));
  } finally {
    restoreFetch();
  }
});

test("Cmd+B toggles the sidebar collapsed state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const { shell } = await renderShortcutWebApp();

    fireEvent.keyDown(document, { key: "B", metaKey: true });
    await waitFor(() => expect(shell.classList.contains("sidebar-collapsed")).toBe(true));

    fireEvent.keyDown(document, { key: "b", metaKey: true });
    await waitFor(() => expect(shell.classList.contains("sidebar-collapsed")).toBe(false));
  } finally {
    restoreFetch();
  }
});

test("sidebar shortcut ignores non-exact key combinations", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const { shell } = await renderShortcutWebApp();

    fireEvent.keyDown(document, { key: "b" });
    fireEvent.keyDown(document, { key: "b", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document, { key: "b", ctrlKey: true, metaKey: true });
    fireEvent.keyDown(document, { key: "b", ctrlKey: true, repeat: true });
    fireEvent.keyDown(document, { key: "b", ctrlKey: true, isComposing: true });

    expect(shell.classList.contains("sidebar-collapsed")).toBe(false);
  } finally {
    restoreFetch();
  }
});

test("sidebar shortcut ignores text-editing targets", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const { shell } = await renderShortcutWebApp();
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
      expect(shell.classList.contains("sidebar-collapsed")).toBe(false);
    }
  } finally {
    restoreFetch();
  }
});

test("sidebar toggle label reflects the current action", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    const { container } = await renderShortcutWebApp();

    expect(container.querySelectorAll('[aria-label="Collapse sidebar"]')).toHaveLength(1);

    fireEvent.keyDown(document, { key: "b", ctrlKey: true });
    await waitFor(() => expect(container.querySelectorAll('[aria-label="Collapse sidebar"]')).toHaveLength(0));
    expect(container.querySelectorAll('[aria-label="Show sidebar"]').length).toBeGreaterThan(0);
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

test("settings device sessions omit inactive state labels", async () => {
  const now = new Date().toISOString();
  const restoreFetch = mockSettingsFetch([{
    id: "session-1",
    clientId: "cli",
    scope: "*",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    active: true,
  }]);
  try {
    const { container, getByText } = await renderSettingsWebApp();

    expect(getByText("cli")).toBeTruthy();
    expect(container.textContent).not.toContain("inactive");
    expect(container.textContent).not.toContain("active ·");
  } finally {
    restoreFetch();
  }
});

test("settings device sessions show empty state when no active sessions are returned", async () => {
  const restoreFetch = mockSettingsFetch([]);
  try {
    const { getByText } = await renderSettingsWebApp();

    expect(getByText("No device sessions")).toBeTruthy();
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

test("sidebar search clearing restores stored collapsed section state", async () => {
  const restoreFetch = mockConfigFetch();
  try {
    localStorage.setItem("webapp.test-app.sidebar.collapsed", JSON.stringify({ projects: true }));
    const { getByLabelText, getByPlaceholderText, queryByText } = await renderSearchableCollapsibleSidebarWebApp({ sectionDefaultCollapsed: false });
    const searchInput = getByPlaceholderText("Search");

    typeSearch(searchInput, "alpha");
    const disabledProjectsToggle = await waitFor(() => getByLabelText("Toggling unavailable during search for Projects"));
    expect((disabledProjectsToggle as HTMLButtonElement).disabled).toBe(true);

    typeSearch(searchInput, "");

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
    const { container, getByLabelText, shell } = await renderShortcutWebApp();

    fireEvent.click(getByLabelText("Show sidebar"));
    await waitFor(() => expect(shell.classList.contains("sidebar-open")).toBe(true));

    const backdrop = container.querySelector(".wapp-mobile-backdrop");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);

    await waitFor(() => expect(shell.classList.contains("sidebar-open")).toBe(false));
  } finally {
    restoreFetch();
  }
});

test("mobile sidebar backdrop uses the modal overlay blur tokens", () => {
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  const rootRule = cssRule(css, ":root");
  const mobileBackdropRule = cssRule(css, ".wapp-mobile-backdrop");
  const modalOverlayRule = cssRule(css, ".wapp-modal-overlay");

  expect(rootRule).toContain("--wapp-overlay-bg: rgb(0 0 0 / 0.5);");
  expect(rootRule).toContain("--wapp-overlay-blur: blur(4px);");
  expect(mobileBackdropRule).toContain("background: var(--wapp-overlay-bg);");
  expect(mobileBackdropRule).toContain("backdrop-filter: var(--wapp-overlay-blur);");
  expect(modalOverlayRule).toContain("background: var(--wapp-overlay-bg);");
  expect(modalOverlayRule).toContain("backdrop-filter: var(--wapp-overlay-blur);");
});

test("sidebar compact badges use the badge variant foreground token", () => {
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  const badgeRule = cssRule(css, ".wapp-badge");
  const lightForegrounds: Record<Exclude<BadgeVariant, "default">, string> = {
    success: "rgb(22 101 52)",
    warning: "rgb(146 64 14)",
    error: "rgb(153 27 27)",
    info: "rgb(30 64 175)",
    disabled: "rgb(31 41 55)",
    idle: "rgb(31 41 55)",
    planning: "rgb(21 94 117)",
    running: "rgb(30 64 175)",
    completed: "rgb(22 101 52)",
    stopped: "rgb(31 41 55)",
    failed: "rgb(153 27 27)",
    merged: "rgb(107 33 168)",
    pushed: "rgb(55 48 163)",
    deleted: "rgb(107 114 128)",
    plan_ready: "rgb(146 64 14)",
  };
  const darkForegrounds: Record<Exclude<BadgeVariant, "default">, string> = {
    success: "rgb(134 239 172)",
    warning: "rgb(252 211 77)",
    error: "rgb(252 165 165)",
    info: "rgb(147 197 253)",
    disabled: "rgb(209 213 219)",
    idle: "rgb(209 213 219)",
    planning: "rgb(103 232 249)",
    running: "rgb(147 197 253)",
    completed: "rgb(134 239 172)",
    stopped: "rgb(209 213 219)",
    failed: "rgb(252 165 165)",
    merged: "rgb(216 180 254)",
    pushed: "rgb(165 180 252)",
    deleted: "rgb(107 114 128)",
    plan_ready: "rgb(252 211 77)",
  };

  expect(badgeRule).toContain("--wapp-badge-fg: var(--wapp-muted);");
  expect(badgeRule).toContain("color: var(--wapp-badge-fg);");
  expect(selectorHasDeclaration(css, ".wapp-badge.wapp-sidebar-badge", "background: var(--wapp-badge-fg);")).toBe(true);
  expect(selectorHasDeclaration(css, ":root.dark .wapp-badge.wapp-sidebar-badge", "background: var(--wapp-badge-fg);")).toBe(true);
  expect(cssRulesForSelector(css, ".wapp-sidebar-badge").some((rule) => rule.includes("background: currentColor;"))).toBe(false);

  for (const [variant, foreground] of Object.entries(lightForegrounds)) {
    const selector = `.wapp-badge-${variant}`;
    expect(selectorHasDeclaration(css, selector, `--wapp-badge-fg: ${foreground};`)).toBe(true);
    expect(selectorHasDeclaration(css, selector, "color: var(--wapp-badge-fg);")).toBe(true);
  }

  for (const [variant, foreground] of Object.entries(darkForegrounds)) {
    const selector = `:root.dark .wapp-badge-${variant}`;
    expect(selectorHasDeclaration(css, selector, `--wapp-badge-fg: ${foreground};`)).toBe(true);
    expect(selectorHasDeclaration(css, selector, "color: var(--wapp-badge-fg);")).toBe(true);
  }
});
