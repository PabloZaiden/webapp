import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { isDestructiveActionMenuItem, submitActionMenuForm } from "../action-menu-item";
import { isTopmostOverlayElement } from "../overlay";
import type { ActionMenuItem } from "./types";

type SwipeStart = {
  pointerId: number;
  captureTarget: Element;
  x: number;
  y: number;
  offset: number;
  intent: "pending" | "horizontal" | "vertical";
};

const DIRECTION_THRESHOLD = 8;
const REVEAL_THRESHOLD = 48;

export function SidebarSwipeActions({
  title,
  actions,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  actions: ActionMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<SwipeStart | null>(null);
  const suppressClickRef = useRef(false);
  const [width, setWidth] = useState(0);
  const [dragOffset, setDragOffset] = useState<number>();
  const offset = dragOffset ?? (open ? -width : 0);

  useLayoutEffect(() => {
    const tray = trayRef.current;
    if (!tray) return;
    const measure = () => setWidth(tray.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tray);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rowRef.current && !event.composedPath().includes(rowRef.current)) onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const row = rowRef.current;
      if (!row || row.closest("[inert], [hidden], [aria-hidden='true']")
        || row.getClientRects().length === 0 || isTopmostOverlayElement(row) === false) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      contentRef.current?.querySelector("button")?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, onOpenChange]);

  function releasePointer(start: SwipeStart): void {
    if (start.captureTarget.hasPointerCapture(start.pointerId)) start.captureTarget.releasePointerCapture(start.pointerId);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClickRef.current = false;
    const captureTarget = event.target instanceof Element ? event.target : event.currentTarget;
    captureTarget.setPointerCapture(event.pointerId);
    startRef.current = {
      pointerId: event.pointerId,
      captureTarget,
      x: event.clientX,
      y: event.clientY,
      offset: open ? -width : 0,
      intent: "pending",
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = startRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (start.intent === "pending") {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < DIRECTION_THRESHOLD) return;
      start.intent = Math.abs(deltaX) > Math.abs(deltaY) * 1.2 ? "horizontal" : "vertical";
    }
    suppressClickRef.current = true;
    if (start.intent !== "horizontal") return;
    setDragOffset(Math.max(-width, Math.min(0, start.offset + deltaX)));
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = startRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    startRef.current = null;
    releasePointer(start);
    setDragOffset(undefined);
    if (start.intent === "horizontal") {
      const nextOffset = Math.max(-width, Math.min(0, start.offset + event.clientX - start.x));
      onOpenChange(width > 0 && -nextOffset >= Math.min(REVEAL_THRESHOLD, width / 2));
    }
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = startRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    startRef.current = null;
    releasePointer(start);
    setDragOffset(undefined);
  }

  const orderedActions = [
    ...actions.filter((action) => !isDestructiveActionMenuItem(action)),
    ...actions.filter(isDestructiveActionMenuItem),
  ];
  return (
    <div ref={rowRef} className="wapp-sidebar-swipe">
      <div
        ref={trayRef}
        className="wapp-sidebar-swipe-actions"
        role="group"
        aria-label={`Actions for ${title}`}
        aria-hidden={!open}
        inert={!open || dragOffset !== undefined}
        style={{ clipPath: `inset(0 0 0 ${Math.max(0, width + offset)}px)` }}
      >
        {orderedActions.map((action, index) => (
          <button
            key={action.id ?? `${action.label}:${index}`}
            type="button"
            className={`wapp-sidebar-swipe-action${isDestructiveActionMenuItem(action) ? " danger" : ""}`}
            data-action-id={action.id}
            disabled={action.disabled}
            onClick={() => {
              onOpenChange(false);
              contentRef.current?.querySelector("button")?.focus({ preventScroll: true });
              if (action.form !== undefined) {
                submitActionMenuForm(action);
              }
              action.onAction?.();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
      <div
        ref={contentRef}
        className={`wapp-sidebar-swipe-content${dragOffset !== undefined ? " is-dragging" : ""}`}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={(event) => {
          if (event.target === startRef.current?.captureTarget) handlePointerCancel(event);
        }}
        onClickCapture={(event) => {
          if (event.detail === 0 || (!suppressClickRef.current && !open)) return;
          event.preventDefault();
          event.stopPropagation();
          if (!suppressClickRef.current) onOpenChange(false);
          suppressClickRef.current = false;
        }}
        onContextMenuCapture={() => onOpenChange(false)}
      >
        {children}
      </div>
    </div>
  );
}
