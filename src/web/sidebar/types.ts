import type { MouseEventHandler, ReactNode } from "react";

export type BadgeVariant =
  | "default"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "disabled"
  | "idle"
  | "planning"
  | "running"
  | "completed"
  | "stopped"
  | "failed"
  | "merged"
  | "pushed"
  | "deleted"
  | "plan_ready";

export type BadgeAppearance = "pill" | "text";
export type SidebarBadgeAppearance = "dot" | "text";
export type SidebarItemLayout = "default" | "subtitle-above-title";
export type SidebarItemBelowTitleAlign = "left" | "right";

export interface WebAppRoute {
  view: string;
  [key: string]: string | number | boolean | undefined;
}

export interface SidebarAction {
  id: string;
  title: string;
  label?: string;
  icon?: ReactNode;
  route?: WebAppRoute;
  onAction?: () => void;
}

export interface SidebarTab {
  id: string;
  title: string;
  label?: string;
  icon?: ReactNode;
}

export interface ActionMenuItem {
  id?: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onAction: () => void;
}

export type SidebarItemRenderContext = {
  node: SidebarNode;
  active: boolean;
  collapsed: boolean;
  hasChildren: boolean;
  searchActive: boolean;
  navigate: (route: WebAppRoute) => void;
  toggleCollapsed: () => void;
  actions: ActionMenuItem[];
  itemProps: {
    type: "button";
    className: string;
    onClick: () => void;
    onContextMenu: MouseEventHandler<HTMLButtonElement>;
    "aria-current"?: "page";
  };
};

export type SidebarItemRenderer = (context: SidebarItemRenderContext) => ReactNode;

export interface SidebarNode {
  type: "section" | "item";
  id: string;
  title: string;
  subtitle?: string;
  belowTitle?: ReactNode;
  belowTitleAlign?: SidebarItemBelowTitleAlign;
  badge?: string;
  badgeVariant?: BadgeVariant;
  badgeAppearance?: SidebarBadgeAppearance;
  itemLayout?: SidebarItemLayout;
  render?: SidebarItemRenderer;
  route?: WebAppRoute;
  action?: SidebarAction;
  actions?: ActionMenuItem[];
  pinnable?: boolean;
  pinId?: string;
  defaultCollapsed?: boolean;
  children?: SidebarNode[];
}

export interface SidebarBuildContext {
  search: string;
  activeTab?: string;
}
