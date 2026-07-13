import type { Root } from "react-dom/client";

declare global {
  var __pablozaidenCreateWebAppRoot: ((target: Element) => Root) | undefined;
}

export function configureWebAppRenderer(createRoot: (target: Element) => Root): void {
  globalThis.__pablozaidenCreateWebAppRoot = createRoot;
}

export function configuredWebAppRenderer(): ((target: Element) => Root) | undefined {
  return globalThis.__pablozaidenCreateWebAppRoot;
}
