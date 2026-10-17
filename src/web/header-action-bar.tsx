import { useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { ActionMenu, Button } from "./components";
import type { HeaderPrimaryStore } from "./header-actions";
import type { ActionMenuItem } from "./sidebar/types";

export function HeaderActionBar({ primary, overflow, headerRef, ariaLabel }: {
  primary: HeaderPrimaryStore;
  overflow: ActionMenuItem[];
  headerRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
}) {
  const actions = useSyncExternalStore(primary.subscribe, primary.getSnapshot, primary.getSnapshot);
  const primaryRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const restorePrimaryFocusRef = useRef<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(false);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const content = primaryRef.current;
    if (!header || !content) return;
    function measure() {
      if (!header || !content) return;
      const style = getComputedStyle(header);
      const width = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const menuWidth = overflow.length ? (menuRef.current?.getBoundingClientRect().width ?? 0) + 8 : 0;
      const collapse = content.getBoundingClientRect().width + menuWidth > width / 2;
      if (collapse && content.contains(document.activeElement)) restoreFocusRef.current = true;
      if (!collapse && collapsed) {
        const active = document.activeElement;
        const trigger = menuButtonRef.current;
        const menuId = trigger?.getAttribute("aria-controls");
        const menu = menuId ? document.getElementById(menuId) : null;
        const actionId = active?.getAttribute("data-action-id");
        const isPrimary = actionId && [...content.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.dataset["actionId"] === actionId);
        if (menu?.contains(active) && isPrimary) {
          restorePrimaryFocusRef.current = actionId;
        } else if (!overflow.length && active === trigger) {
          restorePrimaryFocusRef.current = "";
        }
      }
      setCollapsed(collapse);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, [actions, collapsed, headerRef, overflow.length]);
  useLayoutEffect(() => {
    if (collapsed && restoreFocusRef.current) {
      menuButtonRef.current?.focus();
      restoreFocusRef.current = false;
    }
    if (!collapsed && restorePrimaryFocusRef.current !== undefined) {
      const buttons = [...(primaryRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const target = buttons.find((button) => button.dataset["actionId"] === restorePrimaryFocusRef.current) ?? buttons[0] ?? primaryRef.current;
      target?.focus();
      restorePrimaryFocusRef.current = undefined;
    }
  }, [collapsed]);
  if (!actions.length && !overflow.length) return null;
  const menuActions = [
    ...(collapsed ? actions.map((action, index) => ({ ...action, id: action.id ?? `${action.label}:${index}`, disabled: action.disabled || action.loading })) : []),
    ...overflow,
  ];
  return <div className="wapp-main-header-actions wapp-route-fade">
    <div ref={primaryRef} tabIndex={-1} className={`wapp-header-primary${collapsed ? " wapp-header-primary-collapsed" : ""}`} aria-hidden={collapsed || undefined}>
      {actions.map((action, index) => <Button key={action.id ?? `${action.label}:${index}`} size="sm" variant="primary"
        tone={action.destructive ? "danger" : "neutral"}
        data-action-id={action.id ?? `${action.label}:${index}`}
        type={action.form !== undefined ? "submit" : "button"} form={action.form}
        loading={action.loading} disabled={action.disabled} onClick={action.onAction}>
        {action.icon}{action.label}
      </Button>)}
    </div>
    {menuActions.length ? <div ref={menuRef}><ActionMenu items={menuActions} ariaLabel={ariaLabel} buttonRef={menuButtonRef} /></div> : null}
  </div>;
}
