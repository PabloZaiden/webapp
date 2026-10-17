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
      setCollapsed(collapse);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, [actions, headerRef, overflow.length]);
  useLayoutEffect(() => {
    if (collapsed && restoreFocusRef.current) {
      menuButtonRef.current?.focus();
      restoreFocusRef.current = false;
    }
  }, [collapsed]);
  if (!actions.length && !overflow.length) return null;
  const menuActions = [
    ...(collapsed ? actions.map((action) => ({ ...action, disabled: action.disabled || action.loading })) : []),
    ...overflow,
  ];
  return <div className="wapp-main-header-actions wapp-route-fade">
    <div ref={primaryRef} className={`wapp-header-primary${collapsed ? " wapp-header-primary-collapsed" : ""}`} aria-hidden={collapsed || undefined}>
      {actions.map((action, index) => <Button key={action.id ?? `${action.label}:${index}`} size="sm" variant="primary"
        tone={action.destructive ? "danger" : "neutral"}
        type={action.form !== undefined ? "submit" : "button"} form={action.form}
        loading={action.loading} disabled={action.disabled} onClick={action.onAction}>
        {action.icon}{action.label}
      </Button>)}
    </div>
    {menuActions.length ? <div ref={menuRef}><ActionMenu items={menuActions} ariaLabel={ariaLabel} buttonRef={menuButtonRef} /></div> : null}
  </div>;
}
