import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { Badge, ContextMenu, formatStatusLabel, type ContextMenuPosition } from "./components";
import { AnimatedList, Collapsible } from "./motion";
import type { SidebarCollapsedState } from "./sidebar-state";
import type { SidebarNode, WebAppRoute } from "./sidebar/types";

type SidebarTreeParentKind = "root" | "section" | "item";

export type SidebarTreeProps = {
  nodes: SidebarNode[];
  route: WebAppRoute;
  navigate: (route: WebAppRoute) => boolean;
  collapsed: SidebarCollapsedState;
  toggleCollapsed: (id: string, isCollapsed: boolean) => void;
  searchActive: boolean;
  level?: number;
  parentKind?: SidebarTreeParentKind;
};

function isNodeActive(node: SidebarNode, route: WebAppRoute): boolean {
  return node.route?.view === route.view && Object.entries(node.route).every(([key, value]) => key === "view" || route[key] === value);
}

function sidebarIndentStyle(level: number, parentKind: SidebarTreeParentKind): { marginLeft?: string } | undefined {
  if (level <= 0) {
    return undefined;
  }
  const baseIndentRem = level * 0.375;
  const nestedSectionIndentRem = parentKind === "section" && level > 1 ? 0.875 : 0;
  return { marginLeft: `${baseIndentRem + nestedSectionIndentRem}rem` };
}

export function SidebarTree({ nodes, route, navigate, collapsed, toggleCollapsed, searchActive, level = 0, parentKind = "root" }: SidebarTreeProps) {
  const [contextMenu, setContextMenu] = useState<{ position: ContextMenuPosition; nodeId: string } | null>(null);
  const contextNode = contextMenu ? nodes.find((node) => node.id === contextMenu.nodeId) : undefined;
  const contextActions = contextNode?.contextActions ?? contextNode?.actions ?? [];
  const contextMenuReady = contextNode && (!contextNode.route || isNodeActive(contextNode, route)) && contextActions.length > 0;
  return (
    <>
      <AnimatedList className={`wapp-sidebar-tree-level wapp-sidebar-tree-level-${level}`}>
        {nodes.map((node) => {
        const hasChildren = Boolean(node.children?.length);
        const storedIsCollapsed = collapsed[node.id] ?? node.defaultCollapsed ?? false;
        const isCollapsed = searchActive && hasChildren ? false : storedIsCollapsed;
        const toggleAriaLabel = searchActive ? `Toggling unavailable during search for ${node.title}` : `${isCollapsed ? "Expand" : "Collapse"} ${node.title}`;
        const toggleNodeCollapsed = () => {
          if (!searchActive) {
            toggleCollapsed(node.id, storedIsCollapsed);
          }
        };
        if (node.type === "section") {
          return (
            <section className={`wapp-sidebar-section ${level === 0 ? "top" : "nested"}`} key={node.id}>
              <div className="wapp-sidebar-section-title" style={sidebarIndentStyle(level, parentKind)}>
                {hasChildren ? (
                  <button type="button" aria-expanded={!isCollapsed} aria-label={toggleAriaLabel} disabled={searchActive} onClick={toggleNodeCollapsed}>
                    <span>{isCollapsed ? "▶" : "▼"}</span>{node.title}
                  </button>
                ) : (
                  <div className="wapp-sidebar-section-label">{node.title}</div>
                )}
                {node.action ? (
                  <button
                    type="button"
                    className={`wapp-sidebar-action${node.action.active ? " active" : ""}`}
                    title={node.action.title}
                    aria-label={node.action.title}
                    disabled={node.action.disabled || node.action.busy}
                    aria-pressed={node.action.active}
                    aria-busy={node.action.busy || undefined}
                    onClick={node.action.onAction ?? (() => node.action?.route && navigate(node.action.route))}
                  >
                    {node.action.label ?? "New"}
                  </button>
                ) : null}
              </div>
              {hasChildren ? (
                <Collapsible open={!isCollapsed} className="wapp-sidebar-collapsible">
                  <SidebarTree nodes={node.children ?? []} route={route} navigate={navigate} collapsed={collapsed} toggleCollapsed={toggleCollapsed} searchActive={searchActive} level={level + 1} parentKind="section" />
                </Collapsible>
              ) : null}
              {!isCollapsed && !hasChildren && level === 0 ? <div className="wapp-sidebar-empty">No items.</div> : null}
            </section>
          );
        }
        const active = isNodeActive(node, route);
        const actions = node.contextActions ?? node.actions ?? [];
        const badgeLabel = node.badge ? formatStatusLabel(node.badge) : "";
        const isTextBadge = node.badgeAppearance === "text";
        const itemClassName = [
          "wapp-sidebar-item",
          active ? "active" : "",
          node.itemLayout === "subtitle-above-title" ? "wapp-sidebar-item-subtitle-above-title" : "",
        ].filter(Boolean).join(" ");
        const activate = () => {
          if (node.onActivate?.() === false) {
            return false;
          }
          if (node.route && !navigate(node.route) && !active) {
            return false;
          }
          return true;
        };
        const handleContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          if (!activate()) {
            setContextMenu(null);
            return;
          }
          setContextMenu({ position: { x: event.clientX, y: event.clientY }, nodeId: node.id });
        };
        const itemProps = {
          type: "button" as const,
          className: itemClassName,
          onClick: activate,
          onContextMenu: handleContextMenu,
          ...(active ? { "aria-current": "page" as const } : {}),
        };
        const standardContent = (
          <>
            <span>
              <strong>{node.title}</strong>
              {node.subtitle ? <small>{node.subtitle}</small> : null}
            </span>
            {node.badge ? (
              <Badge
                variant={node.badgeVariant}
                appearance={isTextBadge ? "text" : "pill"}
                className={[
                  "wapp-sidebar-badge",
                  isTextBadge ? "wapp-sidebar-badge-text" : "",
                ].filter(Boolean).join(" ")}
                title={badgeLabel}
                aria-label={badgeLabel}
              >
                {isTextBadge ? badgeLabel : " "}
              </Badge>
            ) : null}
          </>
        );
        const customContent = node.render?.({
          node,
          active,
          childrenCollapsed: isCollapsed,
          hasChildren,
          searchActive,
          navigate,
          toggleCollapsed: toggleNodeCollapsed,
          actions,
        });
        const itemContent = customContent ?? standardContent;
        return (
          <div className={`wapp-sidebar-item-wrap ${hasChildren ? "has-toggle" : ""}`} key={node.id} style={sidebarIndentStyle(level, parentKind)}>
            {hasChildren ? <button type="button" className="wapp-tree-toggle" aria-expanded={!isCollapsed} aria-label={toggleAriaLabel} disabled={searchActive} onClick={toggleNodeCollapsed}>{isCollapsed ? "▶" : "▼"}</button> : null}
            <button {...itemProps}>
              {itemContent}
            </button>
            {node.children ? (
              <Collapsible open={!isCollapsed} className="wapp-sidebar-children">
                <SidebarTree nodes={node.children} route={route} navigate={navigate} collapsed={collapsed} toggleCollapsed={toggleCollapsed} searchActive={searchActive} level={level + 1} parentKind="item" />
              </Collapsible>
            ) : null}
          </div>
        );
        })}
      </AnimatedList>
      <ContextMenu items={contextActions} position={contextMenuReady ? contextMenu?.position ?? null : null} ariaLabel={contextNode ? `Actions for ${contextNode.title}` : "Actions"} onClose={() => setContextMenu(null)} />
    </>
  );
}
