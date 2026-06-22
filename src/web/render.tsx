import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

declare global {
  var __pablozaidenWebAppRoots: WeakMap<Element, Root> | undefined;
}

function roots(): WeakMap<Element, Root> {
  globalThis.__pablozaidenWebAppRoots ??= new WeakMap<Element, Root>();
  return globalThis.__pablozaidenWebAppRoots;
}

export function renderWebApp(element: ReactNode, container: Element | string = "root"): Root {
  const target = typeof container === "string" ? document.getElementById(container) : container;
  if (!target) {
    throw new Error(`Unable to find React root container: ${container}`);
  }
  const registry = roots();
  let root = registry.get(target);
  if (!root) {
    root = createRoot(target);
    registry.set(target, root);
  }
  root.render(element);
  return root;
}
