import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import type { ActionMenuItem, BadgeVariant } from "../sidebar/types";

export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost" }) {
  return <button {...props} className={`wapp-button wapp-button-${variant} ${className}`} />;
}

export function IconButton({
  active = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return <button {...props} className={`wapp-icon-button ${active ? "active" : ""} ${className}`} />;
}

export function Badge({ variant = "default", children }: { variant?: BadgeVariant; children: ReactNode }) {
  return <span className={`wapp-badge wapp-badge-${variant}`}>{children}</span>;
}

export function Panel({ title, description, actions, children, className = "" }: { title?: string; description?: string; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={`wapp-panel ${className}`}>
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
    <div className="wapp-empty-state">
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

export function DataList({ children, empty }: { children?: ReactNode; empty?: ReactNode }) {
  return <div className="wapp-data-list">{children ?? empty ?? null}</div>;
}

export function DataListRow({
  title,
  description,
  meta,
  badge,
  actions,
  onClick,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="wapp-data-list-row-main">
        <strong>{title}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      {meta ? <span className="wapp-data-list-row-meta">{meta}</span> : null}
      {badge ? <span className="wapp-data-list-row-badge">{badge}</span> : null}
      {actions ? <span className="wapp-data-list-row-actions">{actions}</span> : null}
    </>
  );
  return onClick ? (
    <button type="button" className="wapp-data-list-row interactive" onClick={onClick}>{content}</button>
  ) : (
    <div className="wapp-data-list-row">{content}</div>
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
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, open]);

  if (!open) return null;
  return createPortal(
    <div className="wapp-dialog-backdrop" role="presentation">
      <div className="wapp-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="wapp-dialog-title">
          <h2>{title}</h2>
          <button type="button" className="wapp-dialog-close" aria-label="Close dialog" onClick={onCancel}>×</button>
        </div>
        <div className="wapp-dialog-body">
          <p>{message}</p>
        </div>
        <div className="wapp-dialog-actions">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="button" variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
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

function MenuIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="wapp-svg">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function boundedMenuPosition(menu: HTMLDivElement | null, position: ContextMenuPosition): ContextMenuPosition {
  if (!menu) return position;
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  return {
    x: Math.max(margin, Math.min(position.x, window.innerWidth - rect.width - margin)),
    y: Math.max(margin, Math.min(position.y, window.innerHeight - rect.height - margin)),
  };
}

function ActionMenuItems({ items, onItemClick }: { items: ActionMenuItem[]; onItemClick: (item: ActionMenuItem) => void }) {
  return (
    <div className="wapp-action-menu-items">
      {items.map((item, index) => (
        <button
          type="button"
          role="menuitem"
          key={item.id ?? `${item.label}:${index}`}
          disabled={item.disabled}
          className={`wapp-action-menu-item ${item.destructive ? "danger" : ""}`}
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
}: {
  items: ActionMenuItem[];
  ariaLabel?: string;
  disabled?: boolean;
  trigger?: ReactNode;
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
    const menuRect = menuRef.current.getBoundingClientRect();
    const margin = 8;
    setStyle({
      position: "fixed",
      top: Math.max(margin, Math.min(triggerRect.bottom + 4, window.innerHeight - menuRect.height - margin)),
      left: Math.max(margin, Math.min(triggerRect.right - menuRect.width, window.innerWidth - menuRect.width - margin)),
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
        className="wapp-action-menu-trigger"
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
  const [resolvedPosition, setResolvedPosition] = useState<ContextMenuPosition | null>(position);

  useLayoutEffect(() => {
    setResolvedPosition(position ? boundedMenuPosition(menuRef.current, position) : null);
  }, [position]);

  useEffect(() => {
    if (!position) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function handleMouseDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }
    function handleScroll() {
      onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose, position]);

  if (!position || !resolvedPosition) return null;

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
      style={{ position: "fixed", left: resolvedPosition.x, top: resolvedPosition.y }}
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
