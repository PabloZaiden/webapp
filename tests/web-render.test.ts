import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Button, ConfirmModal, Modal } from "../src/web/components";
import type { WebAppConfigResponse } from "../src/contracts";
import { WebAppRoot } from "../src/web/WebAppRoot";
import { renderWebApp } from "../src/web/render";

GlobalRegistrator.register();

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.body.style.overflow = "";
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

function cssRule(css: string, selector: string) {
  const ruleStart = css.indexOf(`${selector} {`);
  expect(ruleStart).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", ruleStart);
  const bodyEnd = css.indexOf("}", bodyStart);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return css.slice(bodyStart + 1, bodyEnd);
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
