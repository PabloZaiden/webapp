import { useLayoutEffect } from "react";
import { themeStyleSchema, type ThemeStyle, type ThemeStyleTokens } from "../contracts";

function declarations(tokens: ThemeStyleTokens): string {
  return Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(";");
}

/** App-supplied visual tokens, independent of the saved Light/Dark/System mode. */
export function ThemeStyles({ theme }: { theme?: ThemeStyle }) {
  const parsed = theme === undefined ? undefined : themeStyleSchema.parse(theme);
  const themed = parsed !== undefined
    && (Object.keys(parsed.light).length > 0 || Object.keys(parsed.dark).length > 0);
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-wapp-themed", themed);
    return () => document.documentElement.removeAttribute("data-wapp-themed");
  }, [themed]);
  return parsed ? <style>{`:root:not(.dark){${declarations(parsed.light)}}:root.dark{${declarations(parsed.dark)}}`}</style> : null;
}
