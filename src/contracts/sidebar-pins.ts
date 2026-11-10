import { z } from "zod";

export const sidebarPinSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  subtitle: z.string().optional(),
  badge: z.string().optional(),
  badgeVariant: z.enum([
    "default", "success", "warning", "error", "info", "disabled", "idle",
    "planning", "running", "completed", "stopped", "failed", "merged",
    "pushed", "deleted", "plan_ready",
  ]).optional(),
  badgeAppearance: z.enum(["dot", "text"]).optional(),
  itemLayout: z.enum(["default", "subtitle-above-title"]).optional(),
  route: z.object({ view: z.string() }).catchall(z.string().optional()),
});

export type SidebarPin = z.infer<typeof sidebarPinSchema>;
