import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { WebAppRoute } from "./sidebar/types";

type ViewTransitionUpdate = () => void;
type ViewTransitionStarter = (updateCallback: ViewTransitionUpdate) => unknown;
type ViewTransitionScopeRef = { readonly current: HTMLElement | null };
export const ROUTE_CHANGE_REQUEST = "wapp:route-change-request";
let approvedHash: string | undefined;

function requestRouteChange(hash: string): boolean {
  return window.dispatchEvent(new CustomEvent<string>(ROUTE_CHANGE_REQUEST, { detail: hash, cancelable: true }));
}

type ViewTransitionElement = HTMLElement & {
  startViewTransition?: ViewTransitionStarter;
};

export function routeToHash(route: WebAppRoute): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(route).filter((entry) => entry !== "view").sort()) {
    const value = route[key];
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  return `#/${route.view}${params.size ? `?${params.toString()}` : ""}`;
}

export function replaceHashRoute(hash: string): boolean {
  const normalizedHash = hash.startsWith("#") ? hash : `#${hash}`;
  if (window.location.hash === normalizedHash) {
    return false;
  }
  if (!requestRouteChange(normalizedHash)) {
    return false;
  }

  const previousUrl = window.location.href;
  let hashChangeEmitted = false;
  const markHashChangeEmitted = () => {
    hashChangeEmitted = true;
  };
  window.addEventListener("hashchange", markHashChangeEmitted, { once: true });
  const previousApprovedHash = approvedHash;
  approvedHash = normalizedHash;
  try {
    window.history.replaceState(window.history.state, "", normalizedHash);
    window.removeEventListener("hashchange", markHashChangeEmitted);
    if (!hashChangeEmitted) {
      window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: previousUrl, newURL: window.location.href }));
    }
  } finally {
    approvedHash = previousApprovedHash;
    window.removeEventListener("hashchange", markHashChangeEmitted);
  }
  return true;
}

export function replaceWebAppRoute(route: WebAppRoute): boolean {
  return replaceHashRoute(routeToHash(route));
}

export function supportsViewTransitions(): boolean {
  return typeof document !== "undefined"
    && typeof document.startViewTransition === "function";
}

export function supportsElementViewTransitions(): boolean {
  if (typeof document === "undefined" || typeof Element === "undefined") {
    return false;
  }
  const prototype = Element.prototype as ViewTransitionElement;
  return typeof prototype.startViewTransition === "function";
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function updateRoute(
  setRoute: (route: WebAppRoute) => void,
  route: WebAppRoute,
  transitionScopeRef?: ViewTransitionScopeRef,
): void {
  const transitionScope = transitionScopeRef?.current;
  const startViewTransition = transitionScope
    ? (transitionScope as ViewTransitionElement).startViewTransition
    : undefined;
  const isDocumentHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  if (typeof startViewTransition !== "function" || isDocumentHidden || prefersReducedMotion()) {
    setRoute(route);
    return;
  }

  startViewTransition.call(transitionScope, () => {
    flushSync(() => setRoute(route));
  });
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

export function useRoute(defaultRoute: WebAppRoute, transitionScopeRef?: ViewTransitionScopeRef) {
  const [route, setRoute] = useState(() => parseRoute(defaultRoute));
  const committedHash = useRef(window.location.hash);
  const commitRoute = useCallback((nextRoute: WebAppRoute) => {
    updateRoute(setRoute, nextRoute, transitionScopeRef);
  }, [transitionScopeRef]);

  useEffect(() => {
    const listener = () => {
      const hash = window.location.hash;
      if (hash === committedHash.current) return;
      if (hash !== approvedHash && !requestRouteChange(hash)) {
        const url = new URL(window.location.href);
        url.hash = committedHash.current;
        window.history.replaceState(window.history.state, "", url);
        return;
      }
      committedHash.current = hash;
      commitRoute(parseRoute(defaultRoute));
    };
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, [commitRoute, defaultRoute]);

  const navigate = useCallback((next: WebAppRoute) => {
    return replaceWebAppRoute(next);
  }, []);

  return { route, navigate };
}
