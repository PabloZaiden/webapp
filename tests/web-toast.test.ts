import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { useToast, type ToastService } from "../src/web";
import { configureWebAppRenderer, renderWebApp, type WebAppRootHandle } from "../src/web/render";
import { ToastProvider } from "../src/web/toast";
import { installControlledTimers, type ControlledTimers } from "./fixtures/controlled-timers";

let activeTimers: ControlledTimers | undefined;

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

beforeEach(async () => {
  await ensureHappyDom();
  activeTimers = installControlledTimers();
});
configureWebAppRenderer(createRoot);

afterEach(() => {
  cleanup();
  activeTimers?.restore();
  activeTimers = undefined;
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

function timers(): ControlledTimers {
  if (!activeTimers) {
    throw new Error("Controlled timers were not installed.");
  }
  return activeTimers;
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

  test("auto-dismisses timed notifications while keeping duration-zero records persistent", () => {
    const { getService } = renderToastService();

    act(() => {
      getService().info("Short-lived.", { id: "short-lived", duration: 10 });
      getService().info("Persistent.", { id: "persistent", duration: 0 });
    });

    expect(getService().toasts.find((toast) => toast.id === "persistent")?.duration).toBe(0);
    act(() => {
      timers().advanceBy(10);
    });
    expect(getService().toasts.some((toast) => toast.id === "short-lived")).toBe(false);
    expect(getService().toasts.some((toast) => toast.id === "persistent")).toBe(true);
  });

  test("stale timers cannot dismiss a replacement notification", () => {
    const { getService } = renderToastService();

    act(() => {
      getService().info("Original.", { id: "status", duration: 20 });
      getService().success("Replacement.", { id: "status", duration: 0 });
    });
    act(() => {
      timers().advanceBy(20);
    });
    expect(getService().toasts).toEqual([expect.objectContaining({
      id: "status",
      message: "Replacement.",
      duration: 0,
    })]);

    act(() => {
      getService().info("Dismissed.", { id: "status", duration: 20 });
      getService().dismiss("status");
      getService().success("New notification.", { id: "status", duration: 0 });
    });
    act(() => {
      timers().advanceBy(20);
    });
    expect(getService().toasts).toEqual([expect.objectContaining({
      id: "status",
      message: "New notification.",
      duration: 0,
    })]);
  });

  test("provides the toast hook through the standard renderWebApp runtime", async () => {
    let currentService: ToastService | undefined;
    function Application() {
      currentService = useToast();
      return createElement("p", null, "Application");
    }

    const container = document.createElement("div");
    document.body.append(container);
    let root: WebAppRootHandle | undefined;
    act(() => {
      root = renderWebApp(createElement(Application), container);
    });
    expect(currentService).toBeTruthy();

    act(() => {
      currentService?.info("Runtime notification.", { duration: 0 });
    });
    expect(within(document.body).getByRole("status").textContent).toContain("Runtime notification.");
    expect(within(document.body).getAllByRole("region", { name: "Notifications" })).toHaveLength(1);

    await act(async () => {
      root?.unmount();
    });
  });
});
