import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { MOTION_FAST_MS, usePresence, type MotionPresenceState } from "./motion";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

type OverlayToken = symbol;

type OverlayRecord = {
  token: OverlayToken;
  surface: HTMLElement;
  layer: HTMLElement;
  order: number;
};

const overlayStack: OverlayRecord[] = [];

function registerOverlay(token: OverlayToken, surface: HTMLElement, layer: HTMLElement): OverlayRecord {
  const usedOrders = new Set(overlayStack.map((record) => record.order));
  let order = 0;
  while (usedOrders.has(order)) {
    order += 1;
  }
  const record = { token, surface, layer, order };
  overlayStack.push(record);
  return record;
}

function unregisterOverlay(token: OverlayToken): void {
  const index = overlayStack.findIndex((record) => record.token === token);
  if (index >= 0) {
    overlayStack.splice(index, 1);
  }
}

function isTopmostOverlay(token: OverlayToken): boolean {
  return overlayStack.at(-1)?.token === token;
}

function overlayForElement(element: Element): OverlayRecord | undefined {
  return [...overlayStack].reverse().find((record) => record.surface === element || record.surface.contains(element));
}

export function isTopmostOverlayElement(element: Element): boolean | undefined {
  const record = overlayForElement(element);
  if (!record) {
    return undefined;
  }
  return overlayStack.at(-1) === record;
}

function focusableElements(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function focusTarget(surface: HTMLElement, preferred: HTMLElement | null): HTMLElement {
  return preferred ?? focusableElements(surface)[0] ?? surface;
}

function canRestoreFocus(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement
    && element.isConnected
    && !element.hasAttribute("disabled")
    && element.getAttribute("aria-hidden") !== "true"
    && !element.closest("[aria-hidden='true']")
    && !element.closest("[inert]");
}

let bodyScrollLock: {
  body: HTMLElement;
  count: number;
  overflow: string;
} | undefined;

function acquireBodyScrollLock(): () => void {
  const body = document.body;
  if (!body) {
    return () => {};
  }

  if (!bodyScrollLock || bodyScrollLock.body !== body) {
    bodyScrollLock = {
      body,
      count: 0,
      overflow: body.style.overflow,
    };
  }
  bodyScrollLock.count += 1;
  body.style.overflow = "hidden";

  let released = false;
  return () => {
    if (released || !bodyScrollLock || bodyScrollLock.body !== body) {
      return;
    }
    released = true;
    bodyScrollLock.count = Math.max(0, bodyScrollLock.count - 1);
    if (bodyScrollLock.count > 0) {
      return;
    }
    body.style.overflow = bodyScrollLock.overflow;
    bodyScrollLock = undefined;
  };
}

type InertElementRecord = {
  count: number;
  ariaHidden: string | null;
  nativeInert?: boolean;
  fallbackTabIndexes: Map<HTMLElement, string | null>;
  observer?: MutationObserver;
};

const inertElements = new WeakMap<HTMLElement, InertElementRecord>();

function applyFallbackTabIndexes(target: HTMLElement, record: InertElementRecord): void {
  const candidates = [
    ...(target.matches(FOCUSABLE_SELECTOR) ? [target] : []),
    ...focusableElements(target),
  ];
  for (const candidate of candidates) {
    if (record.fallbackTabIndexes.has(candidate)) {
      continue;
    }
    record.fallbackTabIndexes.set(candidate, candidate.getAttribute("tabindex"));
    candidate.setAttribute("tabindex", "-1");
  }
}

function acquireInertElement(target: HTMLElement): () => void {
  const existing = inertElements.get(target);
  if (existing) {
    existing.count += 1;
    return () => releaseInertElement(target);
  }

  const record: InertElementRecord = {
    count: 1,
    ariaHidden: target.getAttribute("aria-hidden"),
    fallbackTabIndexes: new Map(),
  };
  if ("inert" in target) {
    record.nativeInert = target.inert;
    target.inert = true;
  } else {
    applyFallbackTabIndexes(target, record);
    if (typeof MutationObserver !== "undefined") {
      record.observer = new MutationObserver(() => applyFallbackTabIndexes(target, record));
      record.observer.observe(target, { childList: true, subtree: true });
    }
  }
  target.setAttribute("aria-hidden", "true");
  inertElements.set(target, record);
  return () => releaseInertElement(target);
}

function releaseInertElement(target: HTMLElement): void {
  const record = inertElements.get(target);
  if (!record) {
    return;
  }
  record.count -= 1;
  if (record.count > 0) {
    return;
  }

  record.observer?.disconnect();
  for (const [element, tabIndex] of record.fallbackTabIndexes) {
    if (tabIndex === null) {
      element.removeAttribute("tabindex");
    } else {
      element.setAttribute("tabindex", tabIndex);
    }
  }
  if (record.nativeInert !== undefined) {
    target.inert = record.nativeInert;
  }
  if (record.ariaHidden === null) {
    target.removeAttribute("aria-hidden");
  } else {
    target.setAttribute("aria-hidden", record.ariaHidden);
  }
  inertElements.delete(target);
}

export function useInertElement(ref: RefObject<HTMLElement | null>, inactive: boolean): void {
  useLayoutEffect(() => {
    if (!inactive) {
      return;
    }
    const target = ref.current;
    if (!target) {
      return;
    }
    return acquireInertElement(target);
  }, [inactive, ref]);
}

function defaultInertTargets(layer: HTMLElement): HTMLElement[] {
  return Array.from(document.body.children)
    .filter((element) => element !== layer && !element.contains(layer))
    .filter((element): element is HTMLElement => element instanceof HTMLElement);
}

export interface OverlayLifecycleOptions {
  open: boolean;
  surfaceRef: RefObject<HTMLElement | null>;
  layerRef: RefObject<HTMLElement | null>;
  onEscape?: () => void;
  onBackdrop?: () => void;
  closeOnBackdrop?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  inertTargets?: readonly (HTMLElement | null)[];
  lockBodyScroll?: boolean;
  duration?: number;
}

export interface OverlayLifecycleState {
  mounted: boolean;
  state: MotionPresenceState;
  zIndex?: number;
  onBackdropPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onBackdropClick: (event: ReactMouseEvent<HTMLElement>) => void;
}

export function useOverlayLifecycle({
  open,
  surfaceRef,
  layerRef,
  onEscape,
  onBackdrop,
  closeOnBackdrop = true,
  initialFocusRef,
  restoreFocusRef,
  inertTargets,
  lockBodyScroll = true,
  duration = MOTION_FAST_MS,
}: OverlayLifecycleOptions): OverlayLifecycleState {
  const presence = usePresence(open, { duration });
  const tokenRef = useRef<OverlayToken>(Symbol("webapp-overlay"));
  const previousFocusRef = useRef<Element | null>(null);
  const restoreFocusPendingRef = useRef<{ target: HTMLElement; surface: HTMLElement } | null>(null);
  const onEscapeRef = useRef(onEscape);
  const onBackdropRef = useRef(onBackdrop);
  const closeOnBackdropRef = useRef(closeOnBackdrop);
  const initialFocusRefRef = useRef(initialFocusRef);
  const restoreFocusRefRef = useRef(restoreFocusRef);
  const inertTargetsRef = useRef(inertTargets);
  const [zIndex, setZIndex] = useState<number>();

  onEscapeRef.current = onEscape;
  onBackdropRef.current = onBackdrop;
  closeOnBackdropRef.current = closeOnBackdrop;
  initialFocusRefRef.current = initialFocusRef;
  restoreFocusRefRef.current = restoreFocusRef;
  inertTargetsRef.current = inertTargets;

  const mounted = open || presence.mounted;
  const state = open && !presence.mounted ? "enter" : presence.state;
  const active = open;

  useLayoutEffect(() => {
    if (!mounted || typeof document === "undefined") {
      return;
    }
    const surface = surfaceRef.current;
    const layer = layerRef.current;
    if (!surface || !layer) {
      return;
    }
    const record = registerOverlay(tokenRef.current, surface, layer);
    setZIndex(80 + record.order);

    return () => {
      unregisterOverlay(record.token);
      setZIndex(undefined);
    };
  }, [layerRef, mounted, surfaceRef]);

  useLayoutEffect(() => {
    if (!active || typeof document === "undefined") {
      return;
    }
    const surface = surfaceRef.current;
    const layer = layerRef.current;
    if (!surface || !layer) {
      return;
    }
    const token = tokenRef.current;
    restoreFocusPendingRef.current = null;
    previousFocusRef.current = restoreFocusRefRef.current?.current
      ?? (document.activeElement instanceof Element ? document.activeElement : null);

    const releaseBodyScroll = lockBodyScroll ? acquireBodyScrollLock() : () => {};
    const targets = (inertTargetsRef.current
      ? inertTargetsRef.current.filter((target): target is HTMLElement => target instanceof HTMLElement)
      : defaultInertTargets(layer))
      .filter((target) => target !== layer && !target.contains(layer));
    const releaseInert = targets.map((target) => acquireInertElement(target));

    const focusCurrentSurface = () => {
      const preferred = initialFocusRefRef.current?.current ?? null;
      focusTarget(surface, preferred).focus();
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!isTopmostOverlay(token) || !(event.target instanceof Node) || surface.contains(event.target)) {
        return;
      }
      focusCurrentSurface();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostOverlay(token)) {
        return;
      }
      if (event.key === "Escape") {
        if (!onEscapeRef.current) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = focusableElements(surface);
      if (focusable.length === 0) {
        event.preventDefault();
        surface.focus();
        return;
      }
      const activeElement = document.activeElement;
      if (!(activeElement instanceof Node) || !surface.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && activeElement === first && last) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last && first) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    focusCurrentSurface();

    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
      for (const release of releaseInert) {
        release();
      }
      releaseBodyScroll();
      const restoreTarget = restoreFocusRefRef.current?.current ?? previousFocusRef.current;
      if (canRestoreFocus(restoreTarget)) {
        restoreTarget.focus();
        restoreFocusPendingRef.current = { target: restoreTarget, surface };
      }
    };
  }, [active, layerRef, lockBodyScroll, surfaceRef]);

  useLayoutEffect(() => {
    const pending = restoreFocusPendingRef.current;
    if (open || presence.mounted || !pending) {
      return;
    }
    restoreFocusPendingRef.current = null;
    if (!canRestoreFocus(pending.target)) {
      return;
    }
    const activeElement = document.activeElement;
    const activeOverlay = activeElement instanceof Element ? overlayForElement(activeElement) : undefined;
    if (
      activeElement !== pending.target
      && (
        activeElement === null
        || activeElement === document.body
        || pending.surface.contains(activeElement)
        || activeOverlay !== undefined
      )
    ) {
      pending.target.focus();
    }
  }, [open, presence.mounted]);

  const onBackdropPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !active || !isTopmostOverlay(tokenRef.current)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (closeOnBackdropRef.current) {
      onBackdropRef.current?.();
    }
  }, [active]);

  const onBackdropClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.detail !== 0 || !active || !isTopmostOverlay(tokenRef.current)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (closeOnBackdropRef.current) {
      onBackdropRef.current?.();
    }
  }, [active]);

  return {
    mounted,
    state,
    zIndex,
    onBackdropPointerDown,
    onBackdropClick,
  };
}
