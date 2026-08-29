import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { ToastProvider } from "./toast";

/**
 * Public lifecycle handle for a root managed by `renderWebApp`.
 *
 * The framework owns the container registry and root creation. Call `unmount`
 * on this handle when the caller disposes the mounted application so the
 * container can be safely rendered again.
 */
export type WebAppRootHandle = Pick<Root, "render" | "unmount">;

type WebAppRootRenderer = (target: Element) => Root;
type WebAppRootEntry = {
  root: Root;
  renderer: WebAppRootRenderer;
  handle: WebAppRootHandle;
};

declare global {
  var __pablozaidenWebAppRoots: WeakMap<Element, WebAppRootEntry> | undefined;
  var __pablozaidenCreateWebAppRoot: WebAppRootRenderer | undefined;
}

function roots(): WeakMap<Element, WebAppRootEntry> {
  globalThis.__pablozaidenWebAppRoots ??= new WeakMap<Element, WebAppRootEntry>();
  return globalThis.__pablozaidenWebAppRoots;
}

function WebAppRuntime({ element }: { element: ReactNode }) {
  return <ToastProvider>{element}</ToastProvider>;
}

function createRegistryEntry(
  registry: WeakMap<Element, WebAppRootEntry>,
  target: Element,
  root: Root,
  renderer: WebAppRootRenderer,
): WebAppRootEntry {
  const entry: WebAppRootEntry = {
    root,
    renderer,
    handle: {
      render: (children) => {
        root.render(children);
      },
      unmount: () => {
        if (registry.get(target) === entry) {
          registry.delete(target);
        }
        root.unmount();
      },
    },
  };
  return entry;
}

/**
 * Configure the factory used when `renderWebApp` needs to create a new root.
 *
 * Existing mounted entries retain the renderer that created them. A changed
 * factory takes effect for a container only after its current handle is
 * unmounted.
 */
export function configureWebAppRenderer(createRoot: WebAppRootRenderer): void {
  globalThis.__pablozaidenCreateWebAppRoot = createRoot;
}

/**
 * Render the framework runtime into a container and return its lifecycle handle.
 *
 * Calls for an already-mounted container reuse its entry. The returned handle
 * must be used to unmount the application before the container is remounted.
 */
export function renderWebApp(element: ReactNode, container: Element | string = "root"): WebAppRootHandle {
  const target = typeof container === "string" ? document.getElementById(container) : container;
  if (!target) {
    throw new Error(`Unable to find React root container: ${container}`);
  }
  const registry = roots();
  let entry = registry.get(target);
  if (!entry) {
    const createRoot = globalThis.__pablozaidenCreateWebAppRoot;
    if (!createRoot) {
      throw new Error("Web app renderer is not configured. Use the framework-generated document or call configureWebAppRenderer(createRoot).");
    }
    entry = createRegistryEntry(registry, target, createRoot(target), createRoot);
    registry.set(target, entry);
  }
  entry.root.render(<WebAppRuntime element={element} />);
  return entry.handle;
}
