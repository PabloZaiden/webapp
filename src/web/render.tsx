import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { configuredWebAppRenderer } from "./renderer-config";
import { ToastProvider } from "./toast";

declare global {
  var __pablozaidenWebAppRoots: WeakMap<Element, Root> | undefined;
}

export { configureWebAppRenderer } from "./renderer-config";

function roots(): WeakMap<Element, Root> {
  globalThis.__pablozaidenWebAppRoots ??= new WeakMap<Element, Root>();
  return globalThis.__pablozaidenWebAppRoots;
}

function WebAppRuntime({ element }: { element: ReactNode }) {
  return <ToastProvider>{element}</ToastProvider>;
}

export function renderWebApp(element: ReactNode, container: Element | string = "root"): Root {
  const target = typeof container === "string" ? document.getElementById(container) : container;
  if (!target) {
    throw new Error(`Unable to find React root container: ${container}`);
  }
  const registry = roots();
  let root = registry.get(target);
  if (!root) {
    const createRoot = configuredWebAppRenderer();
    if (!createRoot) {
      throw new Error("Web app renderer is not configured. Use the framework-generated document or call configureWebAppRenderer(createRoot).");
    }
    root = createRoot(target);
    registry.set(target, root);
  }
  root.render(<WebAppRuntime element={element} />);
  return root;
}
