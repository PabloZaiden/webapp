import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";
import { createLogger } from "../src/web/logger";
import { readStorage, removeStorage, writeStorage } from "../src/web/storage";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost/" });
}

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.localStorage.clear();
  }
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  cleanup();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

function installLocalStorage(descriptor: PropertyDescriptor): () => void {
  const previous = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, ...descriptor });
  return () => {
    if (previous) {
      Object.defineProperty(window, "localStorage", previous);
    } else {
      Reflect.deleteProperty(window, "localStorage");
    }
  };
}

function mapStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

test("safe storage distinguishes missing values and supports get, set, and remove", () => {
  const storage = mapStorage();
  const restore = installLocalStorage({ value: storage });
  try {
    expect(readStorage("preference")).toEqual({ ok: true, value: null });
    expect(writeStorage("preference", "value")).toEqual({ ok: true });
    expect(readStorage("preference")).toEqual({ ok: true, value: "value" });
    expect(removeStorage("preference")).toEqual({ ok: true });
    expect(readStorage("preference")).toEqual({ ok: true, value: null });
  } finally {
    restore();
  }
});

test("safe storage reports an unavailable browser without throwing", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
  try {
    expect(readStorage("preference")).toMatchObject({ ok: false, reason: "unavailable" });
    expect(writeStorage("preference", "value")).toMatchObject({ ok: false, reason: "unavailable" });
    expect(removeStorage("preference")).toMatchObject({ ok: false, reason: "unavailable" });
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("safe storage converts throwing accessors and methods into failures", () => {
  const restoreAccessor = installLocalStorage({
    get() {
      throw new Error("storage blocked");
    },
  });
  try {
    expect(readStorage("preference")).toMatchObject({ ok: false, reason: "error" });
  } finally {
    restoreAccessor();
  }

  const restoreMethods = installLocalStorage({
    value: {
      getItem() {
        throw new Error("read blocked");
      },
      setItem() {
        throw new Error("write blocked");
      },
      removeItem() {
        throw new Error("remove blocked");
      },
    },
  });
  try {
    expect(readStorage("preference")).toMatchObject({ ok: false, reason: "error" });
    expect(writeStorage("preference", "value")).toMatchObject({ ok: false, reason: "error" });
    expect(removeStorage("preference")).toMatchObject({ ok: false, reason: "error" });
  } finally {
    restoreMethods();
  }
});

test("safe storage de-duplicates repeated warnings for one operation and key", () => {
  const key = "deduplicated-storage-warning";
  const logger = createLogger("webapp:storage");
  const warnings: unknown[] = [];
  const detach = logger.attachTransport((record) => {
    warnings.push(record);
  });
  const restore = installLocalStorage({
    value: {
      getItem() {
        throw new Error("read blocked");
      },
    },
  });
  try {
    expect(readStorage(key)).toMatchObject({ ok: false, reason: "error" });
    expect(readStorage(key)).toMatchObject({ ok: false, reason: "error" });
    expect(warnings).toHaveLength(1);
  } finally {
    detach();
    restore();
  }
});
