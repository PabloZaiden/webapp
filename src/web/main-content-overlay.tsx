import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export function MainContentOverlay({ mainRef, children }: {
  mainRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [fullscreenLayer, setFullscreenLayer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const main = mainRef.current;
    if (!main || typeof HTMLElement.prototype.showPopover !== "function") return;
    const activationOrder = new Set<HTMLElement>();
    let disposed = false;

    // Native fullscreen popovers outrank every ordinary z-index.
    const refresh = (): void => {
      if (disposed) return;
      const mainBounds = main.getBoundingClientRect();
      const layers = Array.from(main.querySelectorAll<HTMLElement>(":popover-open"));
      for (const layer of activationOrder) {
        if (!layers.includes(layer)) activationOrder.delete(layer);
      }
      const fullscreen = layers.filter((layer) => {
        const bounds = layer.getBoundingClientRect();
        return bounds.width >= mainBounds.width && bounds.height >= mainBounds.height;
      });
      const activated = Array.from(activationOrder).reverse().find((layer) => fullscreen.includes(layer));
      // Surfaces opened before tracking started need native paint order, not DOM order.
      const painted = !activated && fullscreen.length > 1
        ? main.ownerDocument.elementsFromPoint(
          mainBounds.left + mainBounds.width / 2,
          mainBounds.top + mainBounds.height / 2,
        ).find((element) => fullscreen.some((layer) => layer === element))
        : undefined;
      setFullscreenLayer(activated ?? (painted instanceof HTMLElement ? painted : null) ?? fullscreen.at(-1) ?? null);
    };
    const handleBeforeToggle = (event: Event): void => {
      if (!(event instanceof ToggleEvent) || !(event.target instanceof HTMLElement)) return;
      if (event.newState === "open") {
        activationOrder.delete(event.target);
        activationOrder.add(event.target);
      }
      // beforetoggle is synchronous; toggle can coalesce and arrive out of activation order.
      queueMicrotask(refresh);
    };
    const observer = new MutationObserver(refresh);
    observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ["popover"] });
    main.addEventListener("beforetoggle", handleBeforeToggle, true);
    main.addEventListener("toggle", refresh, true);
    window.addEventListener("resize", refresh);
    refresh();
    return () => {
      disposed = true;
      observer.disconnect();
      main.removeEventListener("beforetoggle", handleBeforeToggle, true);
      main.removeEventListener("toggle", refresh, true);
      window.removeEventListener("resize", refresh);
    };
  }, [mainRef]);

  const overlay = <div className="wapp-main-overlay">{children}</div>;
  return fullscreenLayer ? createPortal(overlay, fullscreenLayer) : overlay;
}
