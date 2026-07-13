import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useToast, type ToastService } from "../src/web";
import { renderWebApp, configureWebAppRenderer } from "../src/web/render";
import { ToastProvider } from "../src/web/toast";

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
configureWebAppRenderer(createRoot);

afterEach(() => {
  cleanup();
  if (typeof document !== "undefined" && document.body) {
    document.body.innerHTML = "";
  }
});

afterAll(async () => {
  cleanup();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

function renderToastService() {
  let currentService: ToastService | undefined;
  function Consumer() {
    currentService = useToast();
    return null;
  }

  const view = render(createElement(ToastProvider, null, createElement(Consumer)));
  return {
    ...view,
    getService() {
      if (!currentService) {
        throw new Error("Toast service was not initialized.");
      }
      return currentService;
    },
  };
}

function trackClearTimeout() {
  const previousClearTimeout = globalThis.clearTimeout;
  const calls: Array<ReturnType<typeof setTimeout>> = [];
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    calls.push(handle);
    previousClearTimeout(handle);
  }) as typeof globalThis.clearTimeout;
  return {
    calls,
    restore() {
      globalThis.clearTimeout = previousClearTimeout;
    },
  };
}

describe("framework toast service", () => {
  test("shows all supported variants with semantic live-region roles", () => {
    const { getService } = renderToastService();

    act(() => {
      getService().success("Saved successfully.", { duration: 0 });
      getService().error("Save failed.", { duration: 0 });
      getService().warning("This may take a moment.", { duration: 0 });
      getService().info("A new update is available.", { duration: 0 });
    });

    const body = within(document.body);
    expect(body.getByRole("alert").textContent).toContain("Save failed.");
    expect(body.getAllByRole("status")).toHaveLength(3);
    expect(body.getByRole("region", { name: "Notifications" })).toBeTruthy();
  });

  test("supports explicit dismissal and dismiss-all", () => {
    const { getService } = renderToastService();

    act(() => {
      getService().success("Dismiss me.", { duration: 0 });
    });
    fireEvent.click(within(document.body).getByRole("button", { name: "Dismiss notification" }));
    expect(within(document.body).queryByRole("region", { name: "Notifications" })).toBeNull();

    act(() => {
      getService().success("First.", { duration: 0 });
      getService().info("Second.", { duration: 0 });
    });
    act(() => {
      getService().dismissAll();
    });
    expect(within(document.body).queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  test("keeps stable IDs and replaces records with caller-provided IDs", () => {
    const { getService } = renderToastService();
    let generatedId = "";
    let replacementId = "";

    act(() => {
      replacementId = getService().success("First state.", { id: "save-status", duration: 0 });
      generatedId = getService().info("Generated ID.", { duration: 0 });
      expect(getService().error("Replacement state.", { id: "save-status", duration: 0 })).toBe(replacementId);
    });

    const records = getService().toasts;
    expect(records).toHaveLength(2);
    expect(records.find((toast) => toast.id === "save-status")?.message).toBe("Replacement state.");
    expect(records.find((toast) => toast.id === generatedId)?.message).toBe("Generated ID.");
  });

  test("bounds the active queue to the five most recent notifications", () => {
    const { getService } = renderToastService();

    act(() => {
      for (let index = 0; index < 6; index += 1) {
        getService().info(`Notification ${index}`, { duration: 0 });
      }
    });

    expect(getService().toasts.map((toast) => toast.message)).toEqual([
      "Notification 1",
      "Notification 2",
      "Notification 3",
      "Notification 4",
      "Notification 5",
    ]);
  });

  test("auto-dismisses timed notifications while keeping duration-zero records persistent", async () => {
    const { getService } = renderToastService();

    act(() => {
      getService().info("Short-lived.", { id: "short-lived", duration: 10 });
      getService().info("Persistent.", { id: "persistent", duration: 0 });
    });

    expect(getService().toasts.find((toast) => toast.id === "persistent")?.duration).toBe(0);
    await waitFor(() => {
      expect(getService().toasts.some((toast) => toast.id === "short-lived")).toBe(false);
    }, { timeout: 1_000 });
    expect(getService().toasts.some((toast) => toast.id === "persistent")).toBe(true);
  });

  test("clears timers when records are replaced, dismissed, evicted, or unmounted", () => {
    const tracker = trackClearTimeout();
    try {
      const view = renderToastService();

      act(() => {
        view.getService().info("Dismissed timer.", { id: "dismissed", duration: 1_000 });
      });
      act(() => {
        view.getService().dismiss("dismissed");
      });
      expect(tracker.calls.length).toBeGreaterThan(0);

      const callsAfterDismiss = tracker.calls.length;
      act(() => {
        view.getService().info("Replaced timer.", { id: "replaced", duration: 1_000 });
        view.getService().success("Persistent replacement.", { id: "replaced", duration: 0 });
      });
      expect(tracker.calls.length).toBeGreaterThan(callsAfterDismiss);

      const callsAfterReplace = tracker.calls.length;
      act(() => {
        for (let index = 0; index < 6; index += 1) {
          view.getService().info(`Evicted ${index}`, { duration: 1_000 });
        }
      });
      expect(tracker.calls.length).toBeGreaterThan(callsAfterReplace);

      const callsBeforeUnmount = tracker.calls.length;
      view.unmount();
      expect(tracker.calls.length).toBeGreaterThan(callsBeforeUnmount);
    } finally {
      tracker.restore();
    }
  });

  test("provides the toast hook through the standard renderWebApp runtime", () => {
    let currentService: ToastService | undefined;
    function Application() {
      currentService = useToast();
      return createElement("p", null, "Application");
    }

    const container = document.createElement("div");
    document.body.append(container);
    let root: Root | undefined;
    act(() => {
      root = renderWebApp(createElement(Application), container);
    });
    expect(currentService).toBeTruthy();
    expect(container.textContent).toBe("Application");

    act(() => {
      currentService?.info("Runtime notification.", { duration: 0 });
    });
    expect(within(document.body).getByRole("status").textContent).toContain("Runtime notification.");
    expect(within(document.body).getAllByRole("region", { name: "Notifications" })).toHaveLength(1);

    act(() => {
      root?.unmount();
    });
  });
});
