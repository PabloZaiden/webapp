import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import type { NativeToolbarLayout } from "./native-toolbar";
import { useToast } from "./toast";

type HeaderStyle = CSSProperties & {
  "--wapp-header-safe-area-top": string;
  "--wapp-header-safe-area-left": string;
  "--wapp-header-safe-area-right": string;
  "--wapp-header-min-height": string;
};
type SidebarStyle = CSSProperties & { "--wapp-sidebar-safe-area-top": string };
type LayoutStyles = { header?: HeaderStyle; sidebar?: SidebarStyle };

function validateLayout(value: NativeToolbarLayout): void {
  if (!value || typeof value !== "object" || !Number.isFinite(value.width) || value.width <= 0
    || !Number.isFinite(value.height) || value.height <= 0
    || !value.safeArea || !(["top", "right", "bottom", "left"] as const).every((edge) => {
      const inset = value.safeArea[edge];
      return Number.isFinite(inset) && inset >= 0;
    })
    || value.safeArea.top > value.height
    || value.safeArea.bottom > value.height
    || value.safeArea.left > value.width || value.safeArea.right > value.width
    || !Array.isArray(value.occlusions)
    || !value.occlusions.every((rect) => rect
      && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      && rect.width >= 0 && rect.height >= 0)) {
    throw new Error("The native host supplied an invalid layout.");
  }
}

function minimumHeaderWidth(header: HTMLElement, layout: NativeToolbarLayout): number {
  const title = header.querySelector<HTMLElement>(".wapp-main-header-title");
  if (!title) return Infinity;
  const spacing = (value: string) => Number.parseFloat(value) || 0;
  const css = getComputedStyle(header);
  const leftInset = header.style.getPropertyValue("--wapp-header-safe-area-left")
    || `${Math.max(0, layout.safeArea.left - header.getBoundingClientRect().left)}px`;
  const rightInset = header.style.getPropertyValue("--wapp-header-safe-area-right") || `${layout.safeArea.right}px`;
  const titleControls = Array.from(title.children).filter((child) => child.tagName !== "H1");
  const others = Array.from(header.children).filter((child) => child !== title && child.getBoundingClientRect().width > 0);
  const width = (children: Element[]) => children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
  return spacing(css.paddingLeft) + spacing(css.paddingRight)
    - spacing(leftInset) - spacing(rightInset)
    + width(titleControls) + spacing(getComputedStyle(title).columnGap) * titleControls.length
    + width(others) + spacing(css.columnGap) * others.length;
}

function layoutStyles(layout: NativeToolbarLayout, header: HTMLElement, sidebar: HTMLElement): LayoutStyles {
  if (layout.width !== window.innerWidth || layout.height !== window.innerHeight
    || (window.visualViewport?.scale ?? 1) !== 1 || layout.safeArea.top === 0) return {};
  const top = layout.safeArea.top;
  const regions = layout.occlusions.filter((rect) => rect.y < top && rect.y + rect.height > 0 && rect.width > 0 && rect.height > 0);
  if (!regions.length) return {};
  const box = header.getBoundingClientRect();
  if (box.top !== 0) return {};
  const overlaps = regions.filter((rect) => rect.x < box.right && rect.x + rect.width > box.left);
  let left = Math.max(box.left, layout.safeArea.left);
  let right = Math.min(box.right, layout.width - layout.safeArea.right);
  for (const rect of overlaps) {
    if (rect.x <= box.left) left = Math.max(left, rect.x + rect.width);
    if (rect.x + rect.width >= box.right) right = Math.min(right, rect.x);
  }
  // Only an edge-bounded clear span can replace the rectangular top inset.
  if (overlaps.some((rect) => rect.x < right && rect.x + rect.width > left)
    || right - left < minimumHeaderWidth(header, layout)) return {};
  const result: LayoutStyles = {
    header: {
      "--wapp-header-safe-area-top": "0px",
      "--wapp-header-safe-area-left": `${left - box.left}px`,
      "--wapp-header-safe-area-right": `${box.right - right}px`,
      "--wapp-header-min-height": `${top}px`,
    },
  };
  const sidebarLeft = sidebar.offsetLeft;
  if (!regions.some((rect) => rect.x < sidebarLeft + sidebar.offsetWidth && rect.x + rect.width > sidebarLeft)) {
    result.sidebar = { "--wapp-sidebar-safe-area-top": "0px" };
  }
  return result;
}

export function useNativeHeaderLayout(headerRef: RefObject<HTMLElement | null>, sidebarRef: RefObject<HTMLElement | null>): LayoutStyles {
  const host = typeof window === "undefined" ? undefined : window.webappNativeToolbar;
  const { error: notifyError } = useToast();
  const [styles, setStyles] = useState<LayoutStyles>({});
  useEffect(() => {
    const getLayout = host?.getLayout;
    if (!host || !getLayout) { setStyles({}); return; }
    let disposed = false;
    let generation = 0;
    let failed = false;
    const apply = (next: LayoutStyles) => setStyles((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    const refresh = () => {
      const request = ++generation;
      void Promise.resolve().then(() => getLayout.call(host)).then((layout) => {
        if (disposed || request !== generation) return;
        const header = headerRef.current;
        const sidebar = sidebarRef.current;
        if (layout !== null) validateLayout(layout);
        const next = layout && header && sidebar ? layoutStyles(layout, header, sidebar) : {};
        apply(next);
        failed = false;
      }).catch((error: unknown) => {
        if (disposed || request !== generation) return;
        apply({});
        if (!failed) notifyError(`Unable to adapt the native header: ${String(error)}`);
        failed = true;
      });
    };
    const unsubscribe = host.subscribe(refresh);
    const observer = new ResizeObserver(refresh);
    if (headerRef.current) {
      observer.observe(headerRef.current);
      const title = headerRef.current.querySelector(".wapp-main-header-title");
      if (title) observer.observe(title);
    }
    window.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("resize", refresh);
    refresh();
    return () => {
      disposed = true;
      unsubscribe();
      observer.disconnect();
      window.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("resize", refresh);
    };
  }, [host, headerRef, sidebarRef, notifyError]);
  return styles;
}
