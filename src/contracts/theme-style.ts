import { z } from "zod";

export const THEME_COLOR_TOKENS = [
  "--wapp-shell-bg", "--wapp-surface", "--wapp-surface-raised",
  "--wapp-surface-muted", "--wapp-surface-inset", "--wapp-border",
  "--wapp-border-soft", "--wapp-border-muted", "--wapp-text",
  "--wapp-muted", "--wapp-muted-2", "--wapp-surface-pill",
  "--wapp-pill-text", "--wapp-primary", "--wapp-action-bg",
  "--wapp-action-text", "--wapp-action-border", "--wapp-sidebar-bg",
  "--wapp-sidebar-text", "--wapp-sidebar-hover-bg", "--wapp-sidebar-section-hover-bg", "--wapp-sidebar-active-bg",
  "--wapp-sidebar-active-text", "--wapp-content-bg", "--wapp-header-bg",
] as const;
export const THEME_RADIUS_TOKENS = ["--wapp-panel-radius", "--wapp-control-radius"] as const;
export const THEME_BORDER_TOKENS = [
  "--wapp-panel-border-width", "--wapp-control-border-width", "--wapp-sidebar-border-width",
] as const;
export const THEME_STYLE_TOKENS = [...THEME_COLOR_TOKENS, ...THEME_RADIUS_TOKENS, ...THEME_BORDER_TOKENS] as const;
export type ThemeStyleToken = typeof THEME_STYLE_TOKENS[number];

const colors = new Set<string>(THEME_COLOR_TOKENS);
const radii = new Set<string>(THEME_RADIUS_TOKENS);
export const themeStyleTokensSchema = z.partialRecord(z.enum(THEME_STYLE_TOKENS), z.string()).superRefine((tokens, context) => {
  for (const [token, value] of Object.entries(tokens)) {
    let valid: boolean;
    if (colors.has(token)) {
      valid = /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|transparent)$/i.test(value);
    } else {
      const length = /^(0|(?:\d+(?:\.\d+)?|\.\d+)(px|rem))$/.exec(value);
      const maximum = radii.has(token) ? 24 : 2;
      valid = Boolean(length) && Number.parseFloat(value) * (length?.[2] === "rem" ? 16 : 1) <= maximum;
    }
    if (!valid) context.addIssue({ code: "custom", path: [token], message: `Invalid value for ${token}. Use a hex color, a radius up to 24px, or a border width up to 2px.` });
  }
});
export const themeStyleSchema = z.object({
  light: themeStyleTokensSchema,
  dark: themeStyleTokensSchema,
}).strict();
export type ThemeStyleTokens = z.infer<typeof themeStyleTokensSchema>;
export type ThemeStyle = z.infer<typeof themeStyleSchema>;
