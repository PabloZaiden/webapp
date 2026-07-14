import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useTheme, type WebAppThemeState } from "../src/web";
import { ThemeProvider } from "../src/web/theme";

const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

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
  localStorage.clear();
});

afterAll(async () => {
  cleanup();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

function installThemeMediaQuery(initialMatches: boolean) {
  const previousMatchMedia = window.matchMedia;
  const mediaQuery = previousMatchMedia.call(window, THEME_MEDIA_QUERY);
  let matches = initialMatches;
  let addCount = 0;
  let removeCount = 0;
  const listeners = new Set<EventListener>();

  Object.defineProperty(mediaQuery, "matches", {
    configurable: true,
    get: () => matches,
  });
  mediaQuery.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === "change") {
      addCount += 1;
      listeners.add(listener as EventListener);
    }
  }) as typeof mediaQuery.addEventListener;
  mediaQuery.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === "change") {
      removeCount += 1;
      listeners.delete(listener as EventListener);
    }
  }) as typeof mediaQuery.removeEventListener;
  window.matchMedia = ((query: string) => query === THEME_MEDIA_QUERY
    ? mediaQuery
    : previousMatchMedia.call(window, query)) as typeof window.matchMedia;

  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media: THEME_MEDIA_QUERY } as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    },
    get addCount() {
      return addCount;
    },
    get removeCount() {
      return removeCount;
    },
    get activeListenerCount() {
      return listeners.size;
    },
    restore() {
      window.matchMedia = previousMatchMedia;
    },
  };
}

function renderTheme(options: { userId?: string } = {}) {
  let currentState: WebAppThemeState | undefined;
  function Consumer() {
    currentState = useTheme();
    return createElement("p", { "aria-label": "theme state" }, `${currentState.preference}:${currentState.resolvedTheme}`);
  }

  const view = render(createElement(ThemeProvider, { ...options, children: createElement(Consumer) }));
  return {
    ...view,
    getState() {
      if (!currentState) {
        throw new Error("Theme state was not initialized.");
      }
      return currentState;
    },
  };
}

test("exposes explicit preferences and concrete resolved themes", () => {
  localStorage.setItem("webapp.theme", "light");
  const media = installThemeMediaQuery(true);
  try {
    const view = renderTheme();
    expect(view.getByLabelText("theme state").textContent).toBe("light:light");

    act(() => {
      view.getState().setPreference("dark");
    });
    expect(view.getByLabelText("theme state").textContent).toBe("dark:dark");

    act(() => {
      view.getState().setPreference("system");
    });
    expect(view.getByLabelText("theme state").textContent).toBe("system:dark");
  } finally {
    media.restore();
  }
});

test("follows operating-system changes in system mode and cleans up listeners", () => {
  localStorage.setItem("webapp.theme", "system");
  const media = installThemeMediaQuery(false);
  try {
    const view = renderTheme();
    expect(view.getByLabelText("theme state").textContent).toBe("system:light");
    expect(media.addCount).toBe(1);

    act(() => {
      media.setMatches(true);
    });
    expect(view.getByLabelText("theme state").textContent).toBe("system:dark");

    view.unmount();
    expect(media.removeCount).toBe(1);
    expect(media.activeListenerCount).toBe(0);
  } finally {
    media.restore();
  }
});

test("normalizes invalid local preference values to system", () => {
  localStorage.setItem("webapp.theme", "purple");
  const media = installThemeMediaQuery(true);
  try {
    const view = renderTheme();
    expect(view.getByLabelText("theme state").textContent).toBe("system:dark");
  } finally {
    media.restore();
  }
});

test("preserves the local preference and reports invalid saved responses", async () => {
  localStorage.setItem("webapp.theme", "light");
  const media = installThemeMediaQuery(false);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ theme: "purple" })) as typeof fetch;
  try {
    const view = renderTheme({ userId: "owner" });

    await waitFor(() => expect(view.getState().error?.message).toBe("Theme preference response was invalid."));
    expect(view.getState().preference).toBe("light");
    expect(view.getByLabelText("theme state").textContent).toBe("light:light");
  } finally {
    globalThis.fetch = previousFetch;
    media.restore();
  }
});
