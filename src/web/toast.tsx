import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type ToastVariant = "success" | "error" | "warning" | "info";
export type ToastId = string;

export interface Toast {
  id: ToastId;
  message: string;
  variant: ToastVariant;
  duration: number;
}

export interface ToastOptions {
  id?: ToastId;
  duration?: number;
}

export interface ToastShowOptions extends ToastOptions {
  variant?: ToastVariant;
}

export interface ToastService {
  toasts: readonly Toast[];
  show: (message: string, options?: ToastShowOptions) => ToastId;
  success: (message: string, options?: ToastOptions) => ToastId;
  error: (message: string, options?: ToastOptions) => ToastId;
  warning: (message: string, options?: ToastOptions) => ToastId;
  info: (message: string, options?: ToastOptions) => ToastId;
  dismiss: (id: ToastId) => void;
  dismissAll: () => void;
}

const DEFAULT_TOAST_DURATION_MS = 8_000;
const MAX_TOASTS = 5;

const ToastContext = createContext<ToastService | null>(null);

function isToastVariant(value: unknown): value is ToastVariant {
  return value === "success" || value === "error" || value === "warning" || value === "info";
}

function normalizeMessage(message: string): string {
  if (typeof message !== "string") {
    throw new TypeError("Toast messages must be strings.");
  }
  return message;
}

function normalizeId(id: ToastId | undefined, nextId: () => ToastId): ToastId {
  if (id === undefined) {
    return nextId();
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("Toast IDs must be non-empty strings.");
  }
  return id;
}

function normalizeDuration(duration: number | undefined): number {
  if (duration === undefined) {
    return DEFAULT_TOAST_DURATION_MS;
  }
  if (!Number.isFinite(duration) || duration < 0) {
    throw new RangeError("Toast duration must be a finite, non-negative number.");
  }
  return duration;
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: ToastId) => void }) {
  if (toasts.length === 0) {
    return null;
  }

  return createPortal(
    <div className="wapp-toast-viewport" role="region" aria-label="Notifications">
      {toasts.map((toast) => {
        const isError = toast.variant === "error";
        return (
          <div
            key={toast.id}
            className={`wapp-toast wapp-toast-${toast.variant}`}
            data-toast-variant={toast.variant}
            role={isError ? "alert" : "status"}
            aria-live={isError ? "assertive" : "polite"}
            aria-atomic="true"
          >
            <span className="wapp-toast-message">{toast.message}</span>
            <button type="button" className="wapp-toast-dismiss" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
              ×
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

export function useToast(): ToastService {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within the framework webapp runtime.");
  }
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef(new Map<ToastId, ReturnType<typeof setTimeout>>());
  const nextIdRef = useRef(0);

  const nextId = useCallback((): ToastId => {
    nextIdRef.current += 1;
    return `toast-${nextIdRef.current}`;
  }, []);

  const clearTimer = useCallback((id: ToastId) => {
    const timer = timersRef.current.get(id);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);

  const dismiss = useCallback((id: ToastId) => {
    clearTimer(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, [clearTimer]);

  const dismissAll = useCallback(() => {
    for (const id of Array.from(timersRef.current.keys())) {
      clearTimer(id);
    }
    setToasts([]);
  }, [clearTimer]);

  const scheduleDismiss = useCallback((toast: Toast) => {
    clearTimer(toast.id);
    if (toast.duration === 0) {
      return;
    }

    const timer = setTimeout(() => {
      if (timersRef.current.get(toast.id) !== timer) {
        return;
      }
      timersRef.current.delete(toast.id);
      setToasts((current) => current.filter((item) => item.id !== toast.id));
    }, toast.duration);
    timersRef.current.set(toast.id, timer);
  }, [clearTimer]);

  const show = useCallback((message: string, options?: ToastShowOptions): ToastId => {
    const normalizedMessage = normalizeMessage(message);
    const variant = options?.variant ?? "info";
    if (!isToastVariant(variant)) {
      throw new TypeError(`Unknown toast variant: ${String(variant)}.`);
    }
    const id = normalizeId(options?.id, nextId);
    const duration = normalizeDuration(options?.duration);
    const toast: Toast = { id, message: normalizedMessage, variant, duration };

    clearTimer(id);
    setToasts((current) => {
      const existingIndex = current.findIndex((item) => item.id === id);
      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = toast;
        return next;
      }
      const next = [...current, toast];
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    });
    scheduleDismiss(toast);
    return id;
  }, [clearTimer, nextId, scheduleDismiss]);

  useEffect(() => {
    const activeIds = new Set(toasts.map((toast) => toast.id));
    for (const id of timersRef.current.keys()) {
      if (activeIds.has(id)) {
        continue;
      }
      clearTimer(id);
    }
  }, [clearTimer, toasts]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer);
    }
    timersRef.current.clear();
  }, []);

  const success = useCallback((message: string, options?: ToastOptions) => show(message, { ...options, variant: "success" }), [show]);
  const error = useCallback((message: string, options?: ToastOptions) => show(message, { ...options, variant: "error" }), [show]);
  const warning = useCallback((message: string, options?: ToastOptions) => show(message, { ...options, variant: "warning" }), [show]);
  const info = useCallback((message: string, options?: ToastOptions) => show(message, { ...options, variant: "info" }), [show]);
  const service = useMemo<ToastService>(() => ({
    toasts,
    show,
    success,
    error,
    warning,
    info,
    dismiss,
    dismissAll,
  }), [dismiss, dismissAll, error, info, show, success, toasts, warning]);

  return (
    <ToastContext.Provider value={service}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
