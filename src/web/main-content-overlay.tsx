import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export function MainContentOverlay({ mainRef, children }: {
  mainRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [fullscreenLayer, setFullscreenLayer] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main || typeof HTMLElement.prototype.showPopover !== "function") return;

    // Native fullscreen popovers outrank every ordinary z-index.
    const refresh = (): void => {
      const mainBounds = main.getBoundingClientRect();
      const layers = Array.from(main.querySelectorAll<HTMLElement>(":popover-open"));
      const fullscreen = layers.filter((layer) => {
        const bounds = layer.getBoundingClientRect();
        return bounds.width >= mainBounds.width && bounds.height >= mainBounds.height;
      });
      setFullscreenLayer(fullscreen.at(-1) ?? null);
    };
    const observer = new MutationObserver(refresh);
    observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ["popover"] });
    main.addEventListener("toggle", refresh, true);
    window.addEventListener("resize", refresh);
    refresh();
    return () => {
      observer.disconnect();
      main.removeEventListener("toggle", refresh, true);
      window.removeEventListener("resize", refresh);
    };
  }, [mainRef]);

  const overlay = <div className="wapp-main-overlay">{children}</div>;
  return fullscreenLayer ? createPortal(overlay, fullscreenLayer) : overlay;
}
