import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { Badge, ContextMenu, formatStatusLabel, type ContextMenuPosition } from "./components";
import { AnimatedList, Collapsible } from "./motion";
import type { SidebarCollapsedState } from "./sidebar-state";
import type { ActionMenuItem, SidebarNode, WebAppRoute } from "./sidebar/types";

type SidebarTreeParentKind = "root" | "section" | "item";

export type SidebarTreeProps = {
  nodes: SidebarNode[];
  route: WebAppRoute;
  navigate: (route: WebAppRoute) => void;
  collapsed: SidebarCollapsedState;
  toggleCollapsed: (id: string, isCollapsed: boolean) => void;
  searchActive: boolean;
  level?: number;
  parentKind?: SidebarTreeParentKind;
};

function sidebarIndentStyle(level: number, parentKind: SidebarTreeParentKind): { marginLeft?: string } | undefined {
  if (level <= 0) {
    return undefined;
  }
  const baseIndentRem = level * 0.375;
  const nestedSectionIndentRem = parentKind === "section" && level > 1 ? 0.875 : 0;
  return { marginLeft: `${baseIndentRem + nestedSectionIndentRem}rem` };
}

export function SidebarTree({ nodes, route, navigate, collapsed, toggleCollapsed, searchActive, level = 0, parentKind = "root" }: SidebarTreeProps) {
  const [contextMenu, setContextMenu] = useState<{ position: ContextMenuPosition; items: ActionMenuItem[]; title: string } | null>(null);
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
                {node.action ? <button type="button" className="wapp-sidebar-action" title={node.action.title} aria-label={node.action.title} onClick={node.action.onAction ?? (() => node.action?.route && navigate(node.action.route))}>{node.action.label ?? "New"}</button> : null}
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
        const active = node.route?.view === route.view && Object.entries(node.route).every(([key, value]) => key === "view" || route[key] === value);
        const badgeLabel = node.badge ? formatStatusLabel(node.badge) : "";
        const isTextBadge = node.badgeAppearance === "text";
        const itemClassName = [
          "wapp-sidebar-item",
          active ? "active" : "",
          node.itemLayout === "subtitle-above-title" ? "wapp-sidebar-item-subtitle-above-title" : "",
        ].filter(Boolean).join(" ");
        const activate = () => {
          if (node.route) {
            navigate(node.route);
          }
        };
        const handleContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
          if (!node.actions?.length) {
            return;
          }
          event.preventDefault();
          setContextMenu({ position: { x: event.clientX, y: event.clientY }, items: node.actions, title: node.title });
        };
        const itemProps = {
          type: "button" as const,
          className: itemClassName,
          onClick: activate,
          onContextMenu: handleContextMenu,
          ...(active ? { "aria-current": "page" as const } : {}),
        };
        const customContent = node.render?.({
          node,
          active,
          collapsed: isCollapsed,
          hasChildren,
          searchActive,
          navigate,
          toggleCollapsed: toggleNodeCollapsed,
          actions: node.actions ?? [],
        });
        return (
          <div className={`wapp-sidebar-item-wrap ${hasChildren ? "has-toggle" : ""}`} key={node.id} style={sidebarIndentStyle(level, parentKind)}>
            {hasChildren ? <button type="button" className="wapp-tree-toggle" aria-expanded={!isCollapsed} aria-label={toggleAriaLabel} disabled={searchActive} onClick={toggleNodeCollapsed}>{isCollapsed ? "▶" : "▼"}</button> : null}
            <button {...itemProps}>
              {node.render ? customContent : (
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
              )}
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
      <ContextMenu items={contextMenu?.items ?? []} position={contextMenu?.position ?? null} ariaLabel={contextMenu ? `Actions for ${contextMenu.title}` : "Actions"} onClose={() => setContextMenu(null)} />
    </>
  );
}
