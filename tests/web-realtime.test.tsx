import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useLiveQuery } from "../src/web/realtime/useRealtime";

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

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emitEvent(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type: "event", event }) });
  }
}

function installFakeWebSocket(): () => void {
  const previousWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  return () => {
    globalThis.WebSocket = previousWebSocket;
  };
}

function liveQueryOutput<TData>(query: { data: TData | undefined; error?: Error; loading: boolean }) {
  return createElement(
    "div",
    null,
    createElement("output", { "aria-label": "result" }, query.data === undefined ? "unset" : String(query.data)),
    createElement("output", { "aria-label": "loading" }, String(query.loading)),
    query.error ? createElement("p", { role: "alert" }, query.error.message) : null,
  );
}

test("inline loaders run once per dependency change", async () => {
  let loadCount = 0;

  function Probe() {
    const [version, setVersion] = useState(0);
    const query = useLiveQuery({
      load: async () => {
        loadCount += 1;
        return version;
      },
      deps: [version],
      realtime: false,
    });
    return createElement(
      "div",
      null,
      liveQueryOutput(query),
      createElement("button", { type: "button", onClick: () => setVersion((current) => current + 1) }, "Next"),
    );
  }

  const view = render(createElement(Probe));
  await waitFor(() => expect(view.getByLabelText("result").textContent).toBe("0"));
  expect(loadCount).toBe(1);

  fireEvent.click(view.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(view.getByLabelText("result").textContent).toBe("1"));
  expect(loadCount).toBe(2);
});

test("only the newest overlapping load can commit data or errors", async () => {
  const loads: Array<Deferred<string>> = [];

  function Probe() {
    const query = useLiveQuery({
      load: () => {
        const nextLoad = deferred<string>();
        loads.push(nextLoad);
        return nextLoad.promise;
      },
      realtime: false,
    });
    return createElement(
      "div",
      null,
      liveQueryOutput(query),
      createElement("button", { type: "button", onClick: () => void query.refresh() }, "Refresh"),
    );
  }

  const view = render(createElement(Probe));
  await waitFor(() => expect(loads).toHaveLength(1));
  const firstLoad = loads[0]!;

  fireEvent.click(view.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(loads).toHaveLength(2));
  const secondLoad = loads[1]!;

  await act(async () => {
    secondLoad.resolve("newest");
    await secondLoad.promise;
  });
  await waitFor(() => {
    expect(view.getByLabelText("result").textContent).toBe("newest");
    expect(view.getByLabelText("loading").textContent).toBe("false");
  });

  await act(async () => {
    firstLoad.reject(new Error("stale failure"));
    await Promise.resolve();
  });
  expect(view.getByLabelText("result").textContent).toBe("newest");
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByLabelText("loading").textContent).toBe("false");
});

test("exposes the current manual refresh failure", async () => {
  let loadCount = 0;

  function Probe() {
    const query = useLiveQuery({
      load: async () => {
        loadCount += 1;
        if (loadCount === 1) return "initial";
        throw new Error("refresh failed");
      },
      realtime: false,
    });
    return createElement(
      "div",
      null,
      liveQueryOutput(query),
      createElement("button", { type: "button", onClick: () => void query.refresh() }, "Refresh"),
    );
  }

  const view = render(createElement(Probe));
  await waitFor(() => expect(view.getByLabelText("result").textContent).toBe("initial"));
  fireEvent.click(view.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(view.getByRole("alert").textContent).toBe("refresh failed"));
  expect(view.getByLabelText("loading").textContent).toBe("false");
});

test("coalesces a realtime burst into one queued follow-up load", async () => {
  const restoreWebSocket = installFakeWebSocket();
  const loads: Array<Deferred<string>> = [];

  function Probe() {
    const query = useLiveQuery({
      load: () => {
        const nextLoad = deferred<string>();
        loads.push(nextLoad);
        return nextLoad.promise;
      },
      realtime: { resources: ["todos"] },
    });
    return liveQueryOutput(query);
  }

  try {
    const view = render(createElement(Probe));
    await waitFor(() => expect(loads).toHaveLength(1));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
    });

    act(() => {
      for (let index = 0; index < 10; index += 1) {
        socket.emitEvent({
          type: "todos.changed",
          resource: "todos",
          action: "changed",
          id: `todo-${index}`,
        });
      }
    });
    expect(loads).toHaveLength(1);

    await act(async () => {
      loads[0]!.resolve("initial");
      await loads[0]!.promise;
    });
    await waitFor(() => expect(loads).toHaveLength(2));
    expect(view.getByLabelText("loading").textContent).toBe("true");

    await act(async () => {
      loads[1]!.resolve("after burst");
      await loads[1]!.promise;
    });
    await waitFor(() => {
      expect(view.getByLabelText("result").textContent).toBe("after burst");
      expect(view.getByLabelText("loading").textContent).toBe("false");
    });
    expect(loads).toHaveLength(2);
  } finally {
    restoreWebSocket();
  }
});
