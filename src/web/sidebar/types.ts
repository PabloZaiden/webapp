import type { ReactNode } from "react";

export type BadgeVariant = "default" | "success" | "warning" | "error" | "info" | "disabled";

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

export interface ActionMenuItem {
  id?: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onAction: () => void;
}

export interface SidebarNode {
  type: "section" | "item";
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: BadgeVariant;
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
}
