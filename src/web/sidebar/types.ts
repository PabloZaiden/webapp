import type { ReactNode } from "react";

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
  childrenCollapsed: boolean;
  hasChildren: boolean;
  searchActive: boolean;
  navigate: (route: WebAppRoute) => void;
  toggleCollapsed: () => void;
  actions: ActionMenuItem[];
};

export type SidebarItemRenderer = (context: SidebarItemRenderContext) => ReactNode;

export interface SidebarNode {
  type: "section" | "item";
  id: string;
  title: string;
  subtitle?: string;
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

export interface SidebarNodeSnapshot {
  nodes: SidebarNode[];
  ready: boolean;
}

export interface SidebarBuildContext {
  search: string;
  activeTab?: string;
}
