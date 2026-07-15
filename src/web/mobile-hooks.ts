import { useEffect, useState } from "react";
import {
  MOBILE_MEDIA_QUERY,
  MOBILE_STATE_ATTRIBUTE,
  MOBILE_VIEWPORT_FINAL_SETTLE_DELAY_MS,
  MOBILE_VIEWPORT_FIRST_SETTLE_DELAY_MS,
} from "./mobile";

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isEditableElement(element: Element | null): boolean {
  if (!element) {
    return false;
  }
  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }
  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && !NON_TEXT_INPUT_TYPES.has(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

export function useMobileBreakpoint(): boolean {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_MEDIA_QUERY).matches);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const root = document.documentElement;
    const sync = () => {
      const next = query.matches;
      setIsMobile(next);
      root.toggleAttribute(MOBILE_STATE_ATTRIBUTE, next);
    };

    sync();
    query.addEventListener("change", sync);
    return () => {
      query.removeEventListener("change", sync);
      root.removeAttribute(MOBILE_STATE_ATTRIBUTE);
    };
  }, []);

  return isMobile;
}

export function useMobileViewportHeight(isMobile: boolean): void {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = document.documentElement;
    const viewport = window.visualViewport;
    const usesDynamicViewportUnit = typeof window.CSS?.supports === "function"
      && window.CSS.supports("height", "100dvh");
    const timers = new Set<number>();
    let frame = 0;

    const clearViewportHeight = () => {
      root.style.removeProperty("--wapp-viewport-height");
    };

    const shouldOverrideDynamicViewportHeight = () => {
      if (!usesDynamicViewportUnit || !viewport || !isEditableElement(document.activeElement)) {
        return false;
      }
      return viewport.height + 1 < window.innerHeight;
    };

    const sync = () => {
      frame = 0;
      if (!isMobile) {
        clearViewportHeight();
        return;
      }

      const shouldUseVisualViewport = !usesDynamicViewportUnit || shouldOverrideDynamicViewportHeight();
      if (!shouldUseVisualViewport) {
        clearViewportHeight();
      } else {
        const height = Math.round(viewport?.height ?? window.innerHeight);
        if (height > 0) {
          root.style.setProperty("--wapp-viewport-height", `${height}px`);
        }
      }

      const scrollingElement = document.scrollingElement;
      if (scrollingElement && scrollingElement.scrollTop !== 0) {
        scrollingElement.scrollTop = 0;
      }
    };

    const scheduleSync = () => {
      if (frame) {
        return;
      }
      frame = requestAnimationFrame(sync);
    };

    const scheduleViewportRetry = (delay: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        scheduleSync();
      }, delay);
      timers.add(timer);
    };

    const handleViewportTransition = () => {
      scheduleSync();
      if (isMobile) {
        scheduleViewportRetry(MOBILE_VIEWPORT_FIRST_SETTLE_DELAY_MS);
        scheduleViewportRetry(MOBILE_VIEWPORT_FINAL_SETTLE_DELAY_MS);
      }
    };

    scheduleSync();
    viewport?.addEventListener("resize", scheduleSync);
    viewport?.addEventListener("scroll", scheduleSync);
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("orientationchange", handleViewportTransition);
    document.addEventListener("focusin", handleViewportTransition);
    document.addEventListener("focusout", handleViewportTransition);

    return () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      for (const timer of timers) {
        clearTimeout(timer);
      }
      viewport?.removeEventListener("resize", scheduleSync);
      viewport?.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("orientationchange", handleViewportTransition);
      document.removeEventListener("focusin", handleViewportTransition);
      document.removeEventListener("focusout", handleViewportTransition);
      clearViewportHeight();
    };
  }, [isMobile]);
}

const SIDEBAR_SWIPE_EDGE_WIDTH = 24;
const SIDEBAR_SWIPE_DISTANCE = 64;
const SIDEBAR_SWIPE_VERTICAL_TOLERANCE = 48;

export function useMobileSidebarSwipe(isMobile: boolean, sidebarOpen: boolean, setSidebarOpen: (open: boolean) => void): void {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    let tracking = false;
    let startX = 0;
    let startY = 0;

    const reset = () => {
      tracking = false;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (sidebarOpen || !isMobile || event.touches.length !== 1) {
        reset();
        return;
      }

      const touch = event.touches[0];
      if (!touch || touch.clientX > SIDEBAR_SWIPE_EDGE_WIDTH) {
        reset();
        return;
      }

      tracking = true;
      startX = touch.clientX;
      startY = touch.clientY;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!tracking) {
        return;
      }
      if (event.touches.length !== 1) {
        reset();
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        reset();
        return;
      }

      const deltaX = touch.clientX - startX;
      const deltaY = Math.abs(touch.clientY - startY);
      if (deltaX <= 0 || deltaY > SIDEBAR_SWIPE_VERTICAL_TOLERANCE || deltaY > deltaX) {
        reset();
        return;
      }
      if (deltaX < SIDEBAR_SWIPE_DISTANCE) {
        return;
      }

      event.preventDefault();
      setSidebarOpen(true);
      reset();
    };

    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchmove", handleTouchMove, { passive: false });
    document.addEventListener("touchend", reset);
    document.addEventListener("touchcancel", reset);
    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", reset);
      document.removeEventListener("touchcancel", reset);
    };
  }, [isMobile, setSidebarOpen, sidebarOpen]);
}
