import { useEffect, type ReactNode, type RefObject } from "react";
import { ActionMenu, IconButton } from "./components";
import { SidebarTree } from "./sidebar-tree";
import type { SidebarCollapsedState } from "./sidebar-state";
import type { ActionMenuItem, SidebarAction, SidebarNode, WebAppRoute } from "./sidebar/types";

function isSidebarShortcutEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target.closest("[contenteditable=''], [contenteditable='true']")) {
    return true;
  }
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}

function Icon({ name }: { name: "settings" | "sidebar" | "plus" | "home" | "search" | "bolt" | "chat" | "code" | "refresh" }) {
  const common = { "aria-hidden": true, viewBox: "0 0 24 24", className: "wapp-svg" };
  if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1.82V22a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.82-.33H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1.82V2a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.33.34.64.6 1 .26.36.61.6 1 .6H22a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-2.51.4Z" /></svg>;
  if (name === "sidebar") return <svg {...common}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M10 5v14" /></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  if (name === "bolt") return <svg {...common}><path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" /></svg>;
  if (name === "chat") return <svg {...common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></svg>;
  if (name === "code") return <svg {...common}><path d="M8 8 4 12l4 4M16 8l4 4-4 4M14 4l-4 16" /></svg>;
  if (name === "refresh") return <svg {...common}><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5M3 12A9 9 0 0 1 18.5 5.7L21 8M21 3v5h-5" /></svg>;
  return <svg {...common}><path d="M4 10.5 12 4l8 6.5V20H5v-7h14" /></svg>;
}

function ActionIcon({ icon }: { icon?: ReactNode }) {
  if (icon === "+") return <Icon name="plus" />;
  if (icon === "↯") return <Icon name="bolt" />;
  if (icon === "chat") return <Icon name="chat" />;
  if (icon === "code") return <Icon name="code" />;
  if (!icon) return <Icon name="bolt" />;
  return <>{icon}</>;
}

export interface AppShellProps {
  appName: string;
  homeRoute: WebAppRoute;
  topActions: SidebarAction[];
  nodes: SidebarNode[];
  route: WebAppRoute;
  navigate: (route: WebAppRoute) => void;
  sidebarSearchEnabled: boolean;
  search: string;
  onSearchChange: (search: string) => void;
  sidebarSearchId: string;
  sidebarSearchInputRef: RefObject<HTMLInputElement | null>;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  collapsed: SidebarCollapsedState;
  toggleCollapsed: (id: string, isCollapsed: boolean) => void;
  searchActive: boolean;
  effectiveVersion: string;
  headerTitle: ReactNode;
  headerActionLabel: string;
  primaryHeaderActions?: ReactNode;
  headerActions: ActionMenuItem[];
  view: ReactNode;
}

export function AppShell({
  appName,
  homeRoute,
  topActions,
  nodes,
  route,
  navigate,
  sidebarSearchEnabled,
  search,
  onSearchChange,
  sidebarSearchId,
  sidebarSearchInputRef,
  sidebarOpen,
  setSidebarOpen,
  sidebarCollapsed,
  toggleSidebarCollapsed,
  collapsed,
  toggleCollapsed,
  searchActive,
  effectiveVersion,
  headerTitle,
  headerActionLabel,
  primaryHeaderActions,
  headerActions,
  view,
}: AppShellProps) {
  useEffect(() => {
    function handleSidebarShortcut(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== "b"
        || event.altKey
        || event.shiftKey
        || event.ctrlKey === event.metaKey
        || event.isComposing
        || event.repeat
        || isSidebarShortcutEditableTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      toggleSidebarCollapsed();
    }

    document.addEventListener("keydown", handleSidebarShortcut);
    return () => document.removeEventListener("keydown", handleSidebarShortcut);
  }, [toggleSidebarCollapsed]);

  const topSidebarActions = topActions.slice(0, 2);
  const sidebarToggleLabel = sidebarCollapsed ? "Show sidebar" : "Collapse sidebar";
  const closeSidebar = () => setSidebarOpen(false);
  const navigateFromSidebarHeader = (nextRoute: WebAppRoute) => {
    navigate(nextRoute);
    closeSidebar();
  };
  const runSidebarHeaderAction = (action: SidebarAction) => {
    if (action.onAction) {
      action.onAction();
    } else if (action.route) {
      navigate(action.route);
    }
    closeSidebar();
  };

  return (
    <main className={`wapp-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarOpen ? "sidebar-open" : ""}`}>
      <div
        className="wapp-mobile-backdrop"
        role="button"
        tabIndex={0}
        aria-label="Close sidebar"
        onClick={closeSidebar}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            closeSidebar();
          }
        }}
      />
      <aside id="wapp-sidebar" className="wapp-sidebar">
        <div className="wapp-sidebar-header">
          <button type="button" className="wapp-brand" onClick={() => navigateFromSidebarHeader(homeRoute)}>{appName}</button>
          <div className="wapp-sidebar-actions">
            {topSidebarActions.map((action) => <IconButton key={action.id} className="wapp-sidebar-top-button" title={action.title} aria-label={action.title} onClick={() => runSidebarHeaderAction(action)}><ActionIcon icon={action.icon} /></IconButton>)}
            <IconButton className="wapp-sidebar-top-button" title="Settings" aria-label="Open settings" active={route.view === "settings"} onClick={() => navigateFromSidebarHeader({ view: "settings" })}><Icon name="settings" /></IconButton>
            <IconButton className="wapp-sidebar-top-button" title={sidebarToggleLabel} aria-label={sidebarToggleLabel} aria-expanded={!sidebarCollapsed} aria-controls="wapp-sidebar" onClick={toggleSidebarCollapsed}><Icon name="sidebar" /></IconButton>
          </div>
        </div>
        <div className="wapp-sidebar-scroll">
          {sidebarSearchEnabled ? (
            <div className="wapp-search">
              <label className="sr-only" htmlFor={sidebarSearchId}>Search</label>
              <div className={`wapp-search-input-wrap${search.length > 0 ? " wapp-search-input-wrap--clearable" : ""}`}>
                <input id={sidebarSearchId} ref={sidebarSearchInputRef} value={search} onInput={(event) => onSearchChange(event.currentTarget.value)} placeholder="Search" />
                {search.length > 0 ? (
                  <button
                    type="button"
                    className="wapp-search-clear"
                    aria-label="Clear search"
                    onClick={() => {
                      onSearchChange("");
                      sidebarSearchInputRef.current?.focus();
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          <SidebarTree nodes={nodes} route={route} navigate={(next) => { navigate(next); setSidebarOpen(false); }} collapsed={collapsed} toggleCollapsed={toggleCollapsed} searchActive={searchActive} />
          <div className="wapp-sidebar-footer">v{effectiveVersion}<button type="button" aria-label="Reload" onClick={() => window.location.reload()}><Icon name="refresh" /></button></div>
        </div>
      </aside>
      <section className="wapp-main">
        <header className="wapp-main-header">
          <div className="wapp-main-header-title">
            {sidebarCollapsed ? <IconButton className="wapp-sidebar-top-button" aria-label={sidebarToggleLabel} title={sidebarToggleLabel} aria-expanded={!sidebarCollapsed} aria-controls="wapp-sidebar" onClick={toggleSidebarCollapsed}><Icon name="sidebar" /></IconButton> : <IconButton className="wapp-mobile-only wapp-sidebar-top-button" aria-label="Show sidebar" title="Show sidebar" aria-expanded={sidebarOpen} aria-controls="wapp-sidebar" onClick={() => setSidebarOpen(true)}><Icon name="sidebar" /></IconButton>}
            <h1>{headerTitle}</h1>
          </div>
          {primaryHeaderActions || headerActions.length ? (
            <div className="wapp-main-header-actions">
              {primaryHeaderActions}
              {headerActions.length ? <ActionMenu items={headerActions} ariaLabel={`Actions for ${headerActionLabel}`} /> : null}
            </div>
          ) : null}
        </header>
        <div className="wapp-main-content">{view}</div>
      </section>
    </main>
  );
}
