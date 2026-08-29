import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ActionMenu, IconButton } from "./components";
import { useInertElement, useOverlayLifecycle } from "./overlay";
import { SidebarTree } from "./sidebar-tree";
import type { SidebarCollapsedState } from "./sidebar-state";
import type { ActionMenuItem, SidebarAction, SidebarNode, SidebarTab, WebAppRoute } from "./sidebar/types";

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

function sidebarTabInitial(title: string): string {
  return Array.from(title.trim())[0]?.toUpperCase() ?? "?";
}

function normalizeAppIconSource(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof URL !== "undefined" && value instanceof URL) {
    return value.href;
  }
  return undefined;
}

export interface AppShellProps {
  appName: string;
  appIcon?: string | URL;
  homeRoute: WebAppRoute;
  topActions: SidebarAction[];
  nodes: SidebarNode[];
  route: WebAppRoute;
  navigate: (route: WebAppRoute) => void;
  sidebarSearchEnabled: boolean;
  sidebarTabs: SidebarTab[];
  activeSidebarTab?: string;
  onSidebarTabChange: (id: string) => void;
  search: string;
  onSearchChange: (search: string) => void;
  sidebarSearchId: string;
  sidebarSearchInputRef: RefObject<HTMLInputElement | null>;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  isMobile: boolean;
  collapsed: SidebarCollapsedState;
  toggleCollapsed: (id: string, isCollapsed: boolean) => void;
  searchActive: boolean;
  effectiveVersion: string;
  headerTitle: ReactNode;
  headerActionLabel: string;
  primaryHeaderActions?: ReactNode;
  headerActions: ActionMenuItem[];
  routeKey: string;
  nativeRouteTransitions?: boolean;
  view: ReactNode;
}

export function AppShell({
  appName,
  appIcon,
  homeRoute,
  topActions,
  nodes,
  route,
  navigate,
  sidebarSearchEnabled,
  sidebarTabs,
  activeSidebarTab,
  onSidebarTabChange,
  search,
  onSearchChange,
  sidebarSearchId,
  sidebarSearchInputRef,
  sidebarOpen,
  setSidebarOpen,
  sidebarCollapsed,
  toggleSidebarCollapsed,
  isMobile,
  collapsed,
  toggleCollapsed,
  searchActive,
  effectiveVersion,
  headerTitle,
  headerActionLabel,
  primaryHeaderActions,
  headerActions,
  routeKey,
  nativeRouteTransitions = false,
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
      if (!isMobile) {
        toggleSidebarCollapsed();
      }
    }

    document.addEventListener("keydown", handleSidebarShortcut);
    return () => document.removeEventListener("keydown", handleSidebarShortcut);
  }, [isMobile, toggleSidebarCollapsed]);

  const topSidebarActions = topActions.slice(0, 2);
  const sidebarToggleLabel = sidebarCollapsed ? "Show sidebar" : "Collapse sidebar";
  const appIconSource = normalizeAppIconSource(appIcon);
  const hasAppIcon = Boolean(appIconSource);
  const sidebarTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const closeSidebar = () => setSidebarOpen(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const drawerLayerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const suppressNextContentClickRef = useRef(false);
  const drawerOpen = isMobile && sidebarOpen;
  useInertElement(sidebarRef, !drawerOpen && (isMobile || sidebarCollapsed));
  const drawerOverlay = useOverlayLifecycle({
    open: drawerOpen,
    surfaceRef: sidebarRef,
    layerRef: drawerLayerRef,
    onEscape: closeSidebar,
    onBackdrop: closeSidebar,
    inertTargets: [mainRef.current],
  });
  const drawerLayerZIndex = drawerOverlay.zIndex ?? 80;
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
  const handleSidebarTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
    const currentIndex = sidebarTabs.findIndex((tab) => tab.id === tabId);
    if (currentIndex < 0 || sidebarTabs.length < 2) {
      return;
    }

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % sidebarTabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + sidebarTabs.length) % sidebarTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = sidebarTabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = sidebarTabs[nextIndex];
    if (nextTab) {
      onSidebarTabChange(nextTab.id);
      sidebarTabRefs.current.get(nextTab.id)?.focus();
    }
  };

  return (
    <main
      className={`wapp-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarOpen ? "sidebar-open" : ""} ${nativeRouteTransitions ? "wapp-native-route-transitions" : ""}`.trim()}
      onPointerDownCapture={() => {
        if (suppressNextContentClickRef.current) {
          suppressNextContentClickRef.current = false;
        }
      }}
      onClickCapture={(event) => {
        if (!suppressNextContentClickRef.current) {
          return;
        }
        suppressNextContentClickRef.current = false;
        if (event.detail !== 0) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div
        className={`wapp-mobile-drawer-stack${drawerOverlay.mounted ? " wapp-mobile-drawer-stack-mounted" : ""}`}
        style={drawerOverlay.mounted ? { zIndex: drawerLayerZIndex } : undefined}
      >
        {drawerOverlay.mounted ? (
          <div
            ref={drawerLayerRef}
            className={`wapp-mobile-drawer-layer wapp-motion-${drawerOverlay.state}`}
            role="presentation"
            aria-hidden={drawerOpen ? undefined : true}
          >
            <button
              type="button"
              className="wapp-mobile-backdrop"
              tabIndex={drawerOverlay.state === "exit" ? -1 : 0}
              aria-label="Close sidebar"
              aria-hidden={drawerOverlay.state === "exit" ? true : undefined}
              onPointerDown={(event) => {
                suppressNextContentClickRef.current = true;
                drawerOverlay.onBackdropPointerDown(event);
              }}
              onClick={drawerOverlay.onBackdropClick}
            />
          </div>
        ) : null}
        <aside
          ref={sidebarRef}
          id="wapp-sidebar"
          className={`wapp-sidebar${sidebarTabs.length ? " wapp-sidebar-with-tabs" : ""}`}
        >
        <div className="wapp-sidebar-header">
          <button
            type="button"
            className={`wapp-brand${hasAppIcon ? " wapp-brand-with-icon" : ""}`}
            aria-label={hasAppIcon ? appName : undefined}
            title={hasAppIcon ? appName : undefined}
            onClick={() => navigateFromSidebarHeader(homeRoute)}
          >
            {hasAppIcon ? <img src={appIconSource} alt="" /> : appName}
          </button>
          <div className="wapp-sidebar-actions">
            {topSidebarActions.map((action) => <IconButton key={action.id} className="wapp-sidebar-top-button" title={action.title} aria-label={action.title} onClick={() => runSidebarHeaderAction(action)}><ActionIcon icon={action.icon} /></IconButton>)}
            <IconButton className="wapp-sidebar-top-button" title="Settings" aria-label="Open settings" active={route.view === "settings"} onClick={() => navigateFromSidebarHeader({ view: "settings" })}><Icon name="settings" /></IconButton>
            {!isMobile ? <IconButton className="wapp-sidebar-top-button" title={sidebarToggleLabel} aria-label={sidebarToggleLabel} aria-expanded={!sidebarCollapsed} aria-controls="wapp-sidebar" onClick={toggleSidebarCollapsed}><Icon name="sidebar" /></IconButton> : null}
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
        </div>
        <div className="wapp-sidebar-footer">v{effectiveVersion}<button type="button" aria-label="Reload" onClick={() => window.location.reload()}><Icon name="refresh" /></button></div>
        {sidebarTabs.length ? (
          <nav className="wapp-sidebar-tabs" aria-label="Sidebar sections">
            <div className={`wapp-sidebar-tabs-list${sidebarTabs.length > 5 ? " scrollable" : ""}`} role="tablist">
              {sidebarTabs.map((tab) => {
                const generatedIcon = tab.icon === undefined;
                const icon = generatedIcon ? sidebarTabInitial(tab.title) : tab.icon;
                const hasIcon = icon !== null && icon !== undefined && icon !== false && icon !== "";
                const visibleLabel = tab.label ?? (hasIcon ? undefined : tab.title);
                const isActive = activeSidebarTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-label={tab.title}
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    className={`wapp-sidebar-tab${isActive ? " active" : ""}`}
                    title={tab.title}
                    ref={(element) => {
                      if (element) {
                        sidebarTabRefs.current.set(tab.id, element);
                      } else {
                        sidebarTabRefs.current.delete(tab.id);
                      }
                    }}
                    onClick={() => onSidebarTabChange(tab.id)}
                    onKeyDown={(event) => handleSidebarTabKeyDown(event, tab.id)}
                  >
                    {hasIcon ? <span className={`wapp-sidebar-tab-icon${generatedIcon ? " initial" : ""}`} aria-hidden="true">{icon}</span> : null}
                    {visibleLabel ? <span className="wapp-sidebar-tab-label">{visibleLabel}</span> : null}
                  </button>
                );
              })}
            </div>
          </nav>
        ) : null}
        </aside>
      </div>
      <section ref={mainRef} className="wapp-main">
        <header className="wapp-main-header">
          <div className="wapp-main-header-title">
            {isMobile ? <IconButton className="wapp-sidebar-top-button" style={!drawerOpen && drawerOverlay.mounted ? { zIndex: drawerLayerZIndex } : undefined} aria-label="Show sidebar" title="Show sidebar" aria-expanded={sidebarOpen} aria-controls="wapp-sidebar" onClick={() => setSidebarOpen(true)}><Icon name="sidebar" /></IconButton> : sidebarCollapsed ? <IconButton className="wapp-sidebar-top-button" aria-label={sidebarToggleLabel} title={sidebarToggleLabel} aria-expanded={!sidebarCollapsed} aria-controls="wapp-sidebar" onClick={toggleSidebarCollapsed}><Icon name="sidebar" /></IconButton> : null}
            <h1 key={routeKey} className="wapp-route-fade">{headerTitle}</h1>
          </div>
          {primaryHeaderActions || headerActions.length ? (
            <div key={routeKey} className="wapp-main-header-actions wapp-route-fade">
              {primaryHeaderActions}
              {headerActions.length ? <ActionMenu items={headerActions} ariaLabel={`Actions for ${headerActionLabel}`} /> : null}
            </div>
          ) : null}
        </header>
        <div className="wapp-main-content">
          <div key={routeKey} className="wapp-route-view">
            {view}
          </div>
        </div>
      </section>
    </main>
  );
}
