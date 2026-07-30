import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import type { ActionMenuItem, BadgeVariant } from "../sidebar/types";
import { AnimatedList, MOTION_FAST_MS, usePresence } from "../motion";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean }) {
  return (
    <button {...props} disabled={disabled || loading} className={`wapp-button wapp-button-${variant} wapp-button-${size} ${className}`}>
      {loading ? <span className="wapp-button-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  active = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return <button {...props} className={`wapp-icon-button ${active ? "active" : ""} ${className}`} />;
}

export type BadgeSize = "sm" | "md";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  children: ReactNode;
}

export function Badge({
  variant = "default",
  size = "sm",
  className = "",
  children,
  ...props
}: BadgeProps) {
  const sizeClass = size === "md" ? "wapp-badge-md" : "";
  return <span {...props} className={["wapp-badge", `wapp-badge-${variant}`, sizeClass, className].filter(Boolean).join(" ")}>{children}</span>;
}

export function StatusBadge({ className = "", ...props }: BadgeProps) {
  return <Badge {...props} className={["wapp-status-badge", className].filter(Boolean).join(" ")} />;
}

export type PageLayout = "padded" | "full";

export function Page({
  layout = "padded",
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode; layout?: PageLayout }) {
  return <div {...props} className={`wapp-page ${layout === "full" ? "wapp-page-full" : ""} ${className}`.trim()}>{children}</div>;
}

export type PanelVariant = "surface" | "muted" | "plain";
export type PanelPadding = "default" | "compact" | "none";

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  title?: string;
  description?: string;
  actions?: ReactNode;
  variant?: PanelVariant;
  padding?: PanelPadding;
  children?: ReactNode;
}

export function Panel({
  title,
  description,
  actions,
  children,
  variant = "muted",
  padding = "default",
  className = "",
  ...props
}: PanelProps) {
  const paddingClass = padding === "default" ? "" : `wapp-panel-padding-${padding}`;
  return (
    <section {...props} className={`wapp-panel wapp-panel-${variant} ${paddingClass} ${className}`.trim()}>
      {title || description || actions ? (
        <div className="wapp-panel-header">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="wapp-panel-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="wapp-empty-state" role="status" aria-label="Empty state">
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {action}
    </div>
  );
}

export function LoadingState({ title = "Loading", description }: { title?: string; description?: string }) {
  return (
    <div className="wapp-loading-state" role="status">
      <span className="wapp-spinner" aria-hidden="true" />
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", description, action }: { title?: string; description?: string; action?: ReactNode }) {
  return (
    <div className="wapp-error-state" role="alert">
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {action ? <div className="wapp-state-actions">{action}</div> : null}
    </div>
  );
}

export function EntityHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="wapp-entity-header">
      <div>
        {eyebrow ? <span className="wapp-eyebrow">{eyebrow}</span> : null}
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="wapp-entity-header-actions">{actions}</div> : null}
    </div>
  );
}

export type DataListVariant = "divided" | "cards";

export function DataList({
  children,
  empty,
  variant = "cards",
}: {
  children?: ReactNode;
  empty?: ReactNode;
  variant?: DataListVariant;
}) {
  return <AnimatedList className={`wapp-data-list wapp-data-list-${variant}`}>{children ?? empty ?? null}</AnimatedList>;
}

export function DataListRow({
  title,
  description,
  descriptionClassName = "",
  meta,
  metaPlacement = "side",
  badge,
  actions,
  onClick,
  disabled = false,
  variant = "card",
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  descriptionClassName?: string;
  meta?: ReactNode;
  metaPlacement?: "side" | "below";
  badge?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "card";
  className?: string;
}) {
  const rowClassName = [
    "wapp-data-list-row",
    variant === "card" ? "wapp-data-list-row-card" : "",
    onClick && !disabled ? "interactive" : "",
    disabled ? "disabled" : "",
    className,
  ].filter(Boolean).join(" ");
  const content = (
    <>
      <span className="wapp-data-list-row-main">
        <strong>{title}</strong>
        {description ? <small className={descriptionClassName}>{description}</small> : null}
        {meta && metaPlacement === "below" ? <small className="wapp-data-list-row-meta-below">{meta}</small> : null}
      </span>
      {meta && metaPlacement === "side" ? <span className="wapp-data-list-row-meta">{meta}</span> : null}
      {badge ? <span className="wapp-data-list-row-badge">{badge}</span> : null}
      {actions ? <span className="wapp-data-list-row-actions">{actions}</span> : null}
    </>
  );
  return onClick && !disabled ? (
    <button type="button" className={rowClassName} onClick={onClick}>{content}</button>
  ) : (
    <div className={rowClassName}>{content}</div>
  );
}

export function TextField({ label, hint, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return (
    <label className="wapp-field">
      <span>{label}</span>
      <input {...props} />
      {hint ? <small>{hint}</small> : null}
      {error ? <small className="error">{error}</small> : null}
    </label>
  );
}

export function TextAreaField({ label, hint, error, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string; error?: string }) {
  return (
    <label className="wapp-field">
      <span>{label}</span>
      <textarea {...props} />
      {hint ? <small>{hint}</small> : null}
      {error ? <small className="error">{error}</small> : null}
    </label>
  );
}

export function SelectField({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  return (
    <label className="wapp-field">
      <span>{label}</span>
      <select {...props}>{children}</select>
    </label>
  );
}

export function CheckboxField({ label, hint, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string; hint?: string }) {
  return (
    <label className="wapp-checkbox-field">
      <input {...props} type="checkbox" />
      <span>
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

export function SegmentedControl<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label: string }) {
  return (
    <div className="wapp-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button type="button" className={value === option.value ? "active" : ""} key={option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface TabOption {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}

export function Tabs({
  tabs,
  value,
  onChange,
  ariaLabel = "Tabs",
  panelIdPrefix = "wapp-tab-panel",
  className = "",
}: {
  tabs: TabOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  panelIdPrefix?: string;
  className?: string;
}) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
    const enabledTabs = tabs.filter((tab) => !tab.disabled);
    const currentIndex = enabledTabs.findIndex((tab) => tab.id === tabId);
    if (currentIndex < 0 || enabledTabs.length < 2) {
      return;
    }

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % enabledTabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = enabledTabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = enabledTabs[nextIndex];
    if (nextTab) {
      onChange(nextTab.id);
      const nextElement = tabRefs.current.get(nextTab.id);
      if (nextElement) {
        nextElement.focus();
      }
    }
  };

  return (
    <div className={`wapp-tabs ${className}`.trim()} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          className={`wapp-tab ${value === tab.id ? "active" : ""}`}
          role="tab"
          aria-selected={value === tab.id}
          aria-controls={`${panelIdPrefix}-${tab.id}`}
          tabIndex={value === tab.id ? 0 : -1}
          disabled={tab.disabled}
          ref={(element) => {
            if (element) {
              tabRefs.current.set(tab.id, element);
            } else {
              tabRefs.current.delete(tab.id);
            }
          }}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => handleKeyDown(event, tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanels({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`wapp-tab-panels ${className}`.trim()}>{children}</div>;
}

export function TabPanel({
  id,
  active,
  labelledBy,
  children,
  keepMounted = false,
  duration = MOTION_FAST_MS,
  className = "",
}: {
  id: string;
  active: boolean;
  labelledBy?: string;
  children: ReactNode;
  keepMounted?: boolean;
  duration?: number;
  className?: string;
}) {
  const presence = usePresence(active, { duration });
  const [keepMountedHidden, setKeepMountedHidden] = useState(!active);

  useEffect(() => {
    if (!keepMounted || active) {
      if (active) {
        setKeepMountedHidden(false);
      }
      return;
    }

    if (presence.reducedMotion || duration <= 0) {
      setKeepMountedHidden(true);
      return;
    }

    const timer = setTimeout(() => setKeepMountedHidden(true), duration);
    return () => clearTimeout(timer);
  }, [active, duration, keepMounted, presence.reducedMotion]);

  if (!keepMounted && !presence.mounted) {
    return null;
  }

  return (
    <div
      id={id}
      className={`wapp-tab-panel wapp-motion-${presence.state} ${className}`.trim()}
      role="tabpanel"
      aria-labelledby={labelledBy}
      aria-hidden={active ? undefined : true}
      hidden={keepMounted && keepMountedHidden && !active}
    >
      {children}
    </div>
  );
}

export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="wapp-form-section">
      <div className={description ? "wapp-form-section-heading wapp-form-section-heading-with-description" : "wapp-form-section-heading"}>
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="wapp-form-section-body">{children}</div>
    </section>
  );
}

export function FormGroup({ title, description, children, actions }: { title?: string; description?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="wapp-form-group">
      {title || description || actions ? (
        <div className="wapp-form-group-header">
          <div>
            {title ? <strong>{title}</strong> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="wapp-form-group-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="wapp-form-group-body">{children}</div>
    </div>
  );
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="wapp-form-actions">{children}</div>;
}

export function DangerZone({ title, description, actions }: { title: string; description?: string; actions: ReactNode }) {
  return (
    <section className="wapp-danger-zone">
      <div>
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="wapp-danger-zone-actions">{actions}</div>
    </section>
  );
}

export function CodeValue({ value, label, copyLabel = "Copy" }: { value: string; label?: string; copyLabel?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <div className="wapp-code-value">
      {label ? <span>{label}</span> : null}
      <code>{value}</code>
      <Button type="button" onClick={() => void copy()}>{copied ? "Copied" : copyLabel}</Button>
    </div>
  );
}

function isTopmostDialog(dialog: HTMLElement): boolean {
  const openDialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']"));
  return openDialogs[openDialogs.length - 1] === dialog;
}

function isNativeEnterTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return true;
  }
  return false;
}

function findDefaultDialogAction(dialog: HTMLElement): HTMLElement | null {
  const explicit = dialog.querySelector<HTMLElement>("[data-dialog-default-action]:not(:disabled)");
  if (explicit) {
    return explicit;
  }

  const submit = dialog.querySelector<HTMLElement>("button[type='submit']:not(:disabled), input[type='submit']:not(:disabled)");
  if (submit) {
    return submit;
  }

  const actionContainers = Array.from(dialog.querySelectorAll<HTMLElement>("[data-dialog-actions], .wapp-dialog-actions"));
  const actionContainer = actionContainers[actionContainers.length - 1];
  if (!actionContainer) {
    return null;
  }

  const buttons = Array.from(actionContainer.querySelectorAll<HTMLElement>("button:not(:disabled), [role='button']:not([aria-disabled='true'])"));
  return buttons[buttons.length - 1] ?? null;
}

export function useDialogKeyboardShortcuts({
  dialogRef,
  enabled = true,
  onCancel,
  onAccept,
  acceptDisabled = false,
}: {
  dialogRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  onCancel?: () => void;
  onAccept?: () => void;
  acceptDisabled?: boolean;
}) {
  const onCancelRef = useRef(onCancel);
  const onAcceptRef = useRef(onAccept);
  onCancelRef.current = onCancel;
  onAcceptRef.current = onAccept;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog || !isTopmostDialog(dialog)) {
        return;
      }

      if (event.key === "Escape") {
        if (onCancelRef.current) {
          event.preventDefault();
          event.stopPropagation();
          onCancelRef.current();
        }
        return;
      }

      if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
        return;
      }

      if (isNativeEnterTarget(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (onAcceptRef.current) {
        if (!acceptDisabled) {
          onAcceptRef.current();
        }
        return;
      }

      if (!acceptDisabled) {
        findDefaultDialogAction(dialog)?.click();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [acceptDisabled, dialogRef, enabled]);
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const MODAL_SCROLL_LOCK_COUNT_KEY = "__webappModalScrollLockCount";
const MODAL_SCROLL_LOCK_OVERFLOW_KEY = "__webappModalScrollLockOverflow";

type ScrollLockedBody = HTMLElement & {
  [MODAL_SCROLL_LOCK_COUNT_KEY]?: number;
  [MODAL_SCROLL_LOCK_OVERFLOW_KEY]?: string;
};

function lockBodyScroll(): () => void {
  const body = document.body as ScrollLockedBody;
  const lockCount = body[MODAL_SCROLL_LOCK_COUNT_KEY] ?? 0;
  if (lockCount === 0) {
    body[MODAL_SCROLL_LOCK_OVERFLOW_KEY] = body.style.overflow;
    body.style.overflow = "hidden";
  }
  body[MODAL_SCROLL_LOCK_COUNT_KEY] = lockCount + 1;

  return () => {
    const nextLockCount = Math.max((body[MODAL_SCROLL_LOCK_COUNT_KEY] ?? 1) - 1, 0);
    if (nextLockCount > 0) {
      body[MODAL_SCROLL_LOCK_COUNT_KEY] = nextLockCount;
      return;
    }

    body.style.overflow = body[MODAL_SCROLL_LOCK_OVERFLOW_KEY] ?? "";
    delete body[MODAL_SCROLL_LOCK_COUNT_KEY];
    delete body[MODAL_SCROLL_LOCK_OVERFLOW_KEY];
  };
}

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  showCloseButton?: boolean;
  closeOnOverlayClick?: boolean;
  className?: string;
}

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  showCloseButton = true,
  closeOnOverlayClick = true,
  className = "",
}: ModalProps) {
  const presence = usePresence(isOpen);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useDialogKeyboardShortcuts({
    dialogRef: modalRef,
    enabled: isOpen && presence.mounted,
    onCancel: () => onCloseRef.current(),
  });

  const handleFocusTrap = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Tab") {
      return;
    }

    const currentModal = modalRef.current;
    const openModals = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']"));
    const topmostModal = openModals[openModals.length - 1];
    if (!currentModal || currentModal !== topmostModal) {
      return;
    }

    const focusable = currentModal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    previousFocusRef.current = document.activeElement;
    document.addEventListener("keydown", handleFocusTrap);
    const unlockBodyScroll = lockBodyScroll();
    modalRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", handleFocusTrap);
      unlockBodyScroll();
      if (previousFocusRef.current instanceof HTMLElement) {
        previousFocusRef.current.focus();
      }
    };
  }, [handleFocusTrap, isOpen, presence.mounted]);

  if (!presence.mounted) {
    return null;
  }

  return createPortal(
    <div className={`wapp-modal-layer wapp-motion-${presence.state}`} aria-hidden={isOpen ? undefined : true}>
      <div
        className="wapp-modal-overlay"
        onClick={closeOnOverlayClick ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={modalRef}
        tabIndex={-1}
        className={`wapp-modal wapp-modal-${size} wapp-motion-${presence.state} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="wapp-modal-header">
          <div className="wapp-modal-title-block">
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          {showCloseButton ? (
            <button type="button" className="wapp-modal-close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          ) : null}
        </div>
        <div className="wapp-modal-body">
          {children}
        </div>
        {footer ? (
          <div className="wapp-modal-footer" data-dialog-actions>
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  variant?: "danger" | "primary";
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  loading = false,
  variant = "danger",
}: ConfirmModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={(
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button type="button" variant={variant} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <p>{message}</p>
      {children}
    </Modal>
  );
}

export function Dialog({
  title,
  description,
  children,
  actions,
  onClose,
  keyboardShortcutsEnabled = true,
  className = "",
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  keyboardShortcutsEnabled?: boolean;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogKeyboardShortcuts({ dialogRef, enabled: keyboardShortcutsEnabled, onCancel: onClose });

  return (
    <div ref={dialogRef} className={`wapp-dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="wapp-dialog-title">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {onClose ? <button type="button" className="wapp-dialog-close" aria-label="Close dialog" onClick={onClose}>×</button> : null}
      </div>
      <div className="wapp-dialog-body">
        {children}
      </div>
      <div className="wapp-dialog-actions" data-dialog-actions>
        {actions}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const presence = usePresence(open);
  if (!presence.mounted) return null;
  return createPortal(
    <div className={`wapp-dialog-backdrop wapp-motion-${presence.state}`} role="presentation" aria-hidden={open ? undefined : true}>
      <Dialog
        title={title}
        onClose={onCancel}
        keyboardShortcutsEnabled={open && presence.mounted}
        className={`wapp-motion-${presence.state}`}
        actions={(
          <>
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="button" variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
          </>
        )}
      >
        <p>{message}</p>
      </Dialog>
    </div>,
    document.body,
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="wapp-toolbar">{children}</div>;
}

export interface ContextMenuPosition {
  x: number;
  y: number;
}

interface ViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function getViewportBounds(): ViewportBounds {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

export type FloatingPanelPlacement = "top-start" | "top-end" | "bottom-start" | "bottom-end";

export interface FloatingPanelProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  ariaLabel?: string;
  role?: "dialog" | "group" | "menu" | "region";
  id?: string;
  placement?: FloatingPanelPlacement;
  offset?: number;
  className?: string;
  style?: CSSProperties;
  focusSelector?: string;
  restoreFocusOnClose?: boolean;
}

function floatingPanelStyle(
  panel: HTMLDivElement,
  anchor: HTMLElement,
  placement: FloatingPanelPlacement,
  offset: number,
): CSSProperties {
  const margin = 8;
  const viewport = getViewportBounds();
  const panelRect = panel.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const panelWidth = panelRect.width;
  const panelHeight = panelRect.height;
  const maxHeight = Math.max(80, viewport.height - margin * 2);
  const canPlaceTop = anchorRect.top - panelHeight - offset >= viewport.top + margin;
  const canPlaceBottom = anchorRect.bottom + panelHeight + offset <= viewport.bottom - margin;
  const prefersTop = placement.startsWith("top");
  const placeTop = prefersTop ? (canPlaceTop || !canPlaceBottom) : (!canPlaceBottom && canPlaceTop);
  const preferredLeft = placement.endsWith("start")
    ? anchorRect.left
    : anchorRect.right - panelWidth;
  const left = Math.max(viewport.left + margin, Math.min(preferredLeft, viewport.right - panelWidth - margin));
  const preferredTop = placeTop
    ? anchorRect.top - panelHeight - offset
    : anchorRect.bottom + offset;
  const top = Math.max(viewport.top + margin, Math.min(preferredTop, viewport.bottom - panelHeight - margin));

  return {
    position: "fixed",
    left,
    top,
    maxHeight,
    overflowY: "auto",
    visibility: "visible",
  };
}

export function FloatingPanel({
  open,
  anchorRef,
  onClose,
  children,
  ariaLabel = "Floating panel",
  role = "dialog",
  id,
  placement = "bottom-start",
  offset = 8,
  className = "",
  style,
  focusSelector,
  restoreFocusOnClose = false,
}: FloatingPanelProps) {
  const presence = usePresence(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const positionFrameRef = useRef<number | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const wasOpenRef = useRef(open);

  const updatePosition = useCallback(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor) {
      return;
    }
    setPanelStyle(floatingPanelStyle(panel, anchor, placement, offset));
  }, [anchorRef, offset, placement]);

  const schedulePositionUpdate = useCallback(() => {
    if (positionFrameRef.current !== null) {
      return;
    }
    positionFrameRef.current = window.requestAnimationFrame(() => {
      positionFrameRef.current = null;
      updatePosition();
    });
  }, [updatePosition]);

  useLayoutEffect(() => {
    if (!open || !presence.mounted) {
      return;
    }

    updatePosition();
    schedulePositionUpdate();
    return () => {
      if (positionFrameRef.current !== null) {
        window.cancelAnimationFrame(positionFrameRef.current);
        positionFrameRef.current = null;
      }
    };
  }, [open, presence.mounted, schedulePositionUpdate, updatePosition]);

  useEffect(() => {
    if (!presence.mounted) {
      setPanelStyle(null);
    }
  }, [presence.mounted]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      const anchor = anchorRef.current;
      const path = event.composedPath();
      if ((panel && path.includes(panel)) || (anchor && path.includes(anchor))) {
        return;
      }
      onClose();
    };
    const handleViewportChange = () => schedulePositionUpdate();

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
    };
  }, [anchorRef, onClose, open, schedulePositionUpdate]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = false;
    if (!restoreFocusOnClose) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => anchorRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [anchorRef, open, restoreFocusOnClose]);

  useEffect(() => {
    if (!open || !presence.mounted || !focusSelector) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>(focusSelector)?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [focusSelector, open, presence.mounted]);

  if (!presence.mounted) {
    return null;
  }

  const resolvedPanelStyle = panelStyle ?? {
    position: "fixed" as const,
    top: -9999,
    left: -9999,
    visibility: "hidden" as const,
  };

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      className={`wapp-floating-panel wapp-motion-${presence.state} ${className}`.trim()}
      role={role}
      aria-label={ariaLabel}
      aria-hidden={open ? undefined : true}
      style={{ ...resolvedPanelStyle, ...style }}
    >
      {children}
    </div>,
    document.body,
  );
}

function MenuIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="wapp-svg">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function boundedMenuStyle(menu: HTMLDivElement | null, position: ContextMenuPosition): CSSProperties {
  const margin = 8;
  const viewport = getViewportBounds();
  const rect = menu?.getBoundingClientRect();
  const width = rect?.width ?? 180;
  const height = rect?.height ?? 0;
  const maxHeight = Math.max(80, viewport.height - margin * 2);
  const boundedHeight = Math.min(height || maxHeight, maxHeight);
  const left = Math.max(viewport.left + margin, Math.min(position.x, viewport.right - width - margin));
  const top = Math.max(viewport.top + margin, Math.min(position.y, viewport.bottom - boundedHeight - margin));
  return {
    position: "fixed",
    left,
    top,
    maxHeight,
    overflowY: "auto",
  };
}

function hiddenMenuStyle(position: ContextMenuPosition): CSSProperties {
  return {
    position: "fixed",
    left: position.x,
    top: position.y,
    visibility: "hidden",
  };
}

function isDestructiveActionMenuItem(item: ActionMenuItem): boolean {
  return item.destructive === true || item.id?.toLowerCase().includes("delete") === true || item.label.toLowerCase().includes("delete");
}

function ActionMenuItems({ items, onItemClick }: { items: ActionMenuItem[]; onItemClick: (item: ActionMenuItem) => void }) {
  const orderedItems = [
    ...items.filter((item) => !isDestructiveActionMenuItem(item)),
    ...items.filter(isDestructiveActionMenuItem),
  ];
  return (
    <div className="wapp-action-menu-items">
      {orderedItems.map((item, index) => (
        <button
          type="button"
          role="menuitem"
          key={item.id ?? `${item.label}:${index}`}
          disabled={item.disabled}
          className={`wapp-action-menu-item ${isDestructiveActionMenuItem(item) ? "danger" : ""}`}
          onClick={() => onItemClick(item)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function ActionMenu({
  items,
  ariaLabel = "Actions",
  disabled = false,
  trigger,
  triggerVariant = "default",
  triggerSize = "default",
}: {
  items: ActionMenuItem[];
  ariaLabel?: string;
  disabled?: boolean;
  trigger?: ReactNode;
  triggerVariant?: "default" | "ghost";
  triggerSize?: "default" | "compact";
}) {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: -9999, left: -9999 });
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    function handleMouseDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        close();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [close, open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    setStyle({
      ...boundedMenuStyle(menuRef.current, {
        x: triggerRect.right - menuRef.current.getBoundingClientRect().width,
        y: triggerRect.bottom + 4,
      }),
    });
  }, [open, presence.mounted]);

  function handleItemClick(item: ActionMenuItem) {
    if (item.disabled) return;
    close();
    item.onAction();
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={[
          "wapp-action-menu-trigger",
          triggerVariant === "ghost" ? "wapp-action-menu-trigger-ghost" : "",
          triggerSize === "compact" ? "wapp-action-menu-trigger-compact" : "",
        ].filter(Boolean).join(" ")}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || items.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger ?? <MenuIcon />}
      </button>
      {presence.mounted ? createPortal(
        <div ref={menuRef} className={`wapp-action-menu wapp-motion-${presence.state}`} role="menu" aria-label={ariaLabel} aria-hidden={open ? undefined : true} style={style}>
          <ActionMenuItems items={items} onItemClick={handleItemClick} />
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export function ContextMenu({
  items,
  position,
  onClose,
  ariaLabel = "Context menu",
}: {
  items: ActionMenuItem[];
  position: ContextMenuPosition | null;
  onClose: () => void;
  ariaLabel?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const presence = usePresence(Boolean(position));
  const [renderPosition, setRenderPosition] = useState(position);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(position ? hiddenMenuStyle(position) : null);

  useEffect(() => {
    if (position) {
      setRenderPosition(position);
    }
  }, [position]);

  useLayoutEffect(() => {
    if (!renderPosition) {
      setMenuStyle(null);
      return;
    }

    let frameId: number | null = null;
    const updatePosition = () => {
      setMenuStyle(boundedMenuStyle(menuRef.current, renderPosition));
    };

    setMenuStyle(hiddenMenuStyle(renderPosition));
    updatePosition();
    frameId = window.requestAnimationFrame(updatePosition);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [items, renderPosition]);

  useEffect(() => {
    if (!position) return;
    const currentPosition = position;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function handleMouseDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }
    function handleScroll() {
      onClose();
    }
    function handleResize() {
      setMenuStyle(boundedMenuStyle(menuRef.current, currentPosition));
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
    };
  }, [onClose, position]);

  if (!presence.mounted || !renderPosition || !menuStyle) return null;

  function handleItemClick(item: ActionMenuItem) {
    if (item.disabled) return;
    onClose();
    item.onAction();
  }

  return createPortal(
    <div
      ref={menuRef}
      className={`wapp-action-menu wapp-motion-${presence.state}`}
      role="menu"
      aria-label={ariaLabel}
      aria-hidden={position ? undefined : true}
      style={menuStyle}
      onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <ActionMenuItems items={items} onItemClick={handleItemClick} />
    </div>,
    document.body,
  );
}
