import { useCallback, useEffect, useState } from "react";
import type { WebAppRoute } from "./sidebar/types";

export function routeToHash(route: WebAppRoute): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(route)) {
    if (key !== "view" && value !== undefined) {
      params.set(key, String(value));
    }
  }
  return `#/${route.view}${params.size ? `?${params.toString()}` : ""}`;
}

export function replaceHashRoute(hash: string): boolean {
  const normalizedHash = hash.startsWith("#") ? hash : `#${hash}`;
  if (window.location.hash === normalizedHash) {
    return false;
  }

  const previousUrl = window.location.href;
  let hashChangeEmitted = false;
  const markHashChangeEmitted = () => {
    hashChangeEmitted = true;
  };
  window.addEventListener("hashchange", markHashChangeEmitted, { once: true });
  window.history.replaceState(window.history.state, "", normalizedHash);
  window.removeEventListener("hashchange", markHashChangeEmitted);
  if (!hashChangeEmitted) {
    window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: previousUrl, newURL: window.location.href }));
  }
  return true;
}

export function replaceWebAppRoute(route: WebAppRoute): boolean {
  return replaceHashRoute(routeToHash(route));
}

function parseRoute(defaultRoute: WebAppRoute): WebAppRoute {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) {
    return defaultRoute;
  }
  const [view = defaultRoute.view, query = ""] = hash.split("?", 2);
  const params = Object.fromEntries(new URLSearchParams(query).entries());
  return { view: view.replace(/^\//, ""), ...params };
}

export function useRoute(defaultRoute: WebAppRoute) {
  const [route, setRoute] = useState(() => parseRoute(defaultRoute));
  useEffect(() => {
    const listener = () => setRoute(parseRoute(defaultRoute));
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, [defaultRoute]);
  const navigate = useCallback((next: WebAppRoute) => {
    if (replaceWebAppRoute(next)) {
      setRoute(next);
    }
  }, []);
  return { route, navigate };
}
