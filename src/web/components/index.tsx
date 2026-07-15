import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type InputHTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import type { ActionMenuItem, BadgeVariant } from "../sidebar/types";

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

export function Badge({
  variant = "default",
  size = "sm",
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant; size?: BadgeSize; children: ReactNode }) {
  return <span {...props} className={`wapp-badge wapp-badge-${variant} wapp-badge-${size} ${className}`}>{children}</span>;
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
  return <div className={`wapp-data-list wapp-data-list-${variant}`}>{children ?? empty ?? null}</div>;
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

export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="wapp-form-section">
      <div>
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
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useDialogKeyboardShortcuts({
    dialogRef: modalRef,
    enabled: isOpen,
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
  }, [handleFocusTrap, isOpen]);

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div className="wapp-modal-layer">
      <div
        className="wapp-modal-overlay"
        onClick={closeOnOverlayClick ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={modalRef}
        tabIndex={-1}
        className={`wapp-modal wapp-modal-${size} ${className}`}
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
  className = "",
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogKeyboardShortcuts({ dialogRef, onCancel: onClose });

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
  if (!open) return null;
  return createPortal(
    <div className="wapp-dialog-backdrop" role="presentation">
      <Dialog
        title={title}
        onClose={onCancel}
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
  }, [open]);

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
      {open ? createPortal(
        <div ref={menuRef} className="wapp-action-menu" role="menu" aria-label={ariaLabel} style={style}>
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
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(position ? hiddenMenuStyle(position) : null);

  useLayoutEffect(() => {
    if (!position) {
      setMenuStyle(null);
      return;
    }

    let frameId: number | null = null;
    const updatePosition = () => {
      setMenuStyle(boundedMenuStyle(menuRef.current, position));
    };

    setMenuStyle(hiddenMenuStyle(position));
    updatePosition();
    frameId = window.requestAnimationFrame(updatePosition);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [items, position]);

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

  if (!position || !menuStyle) return null;

  function handleItemClick(item: ActionMenuItem) {
    if (item.disabled) return;
    onClose();
    item.onAction();
  }

  return createPortal(
    <div
      ref={menuRef}
      className="wapp-action-menu"
      role="menu"
      aria-label={ariaLabel}
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
