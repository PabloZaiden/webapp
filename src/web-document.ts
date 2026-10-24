import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_THEME_PREFERENCE } from "./contracts";
import type { WebAppDocumentConfig, WebAppIconConfig, WebAppPwaConfig } from "./server/server-types";
import type { WebAppPublicAssetArtifact } from "./server/public-asset-manifest";
import { MOBILE_MEDIA_QUERY, MOBILE_STATE_ATTRIBUTE } from "./web/mobile";

const DEFAULT_THEME_COLOR = "#111827";
const DEFAULT_BACKGROUND_COLOR = "#ffffff";

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

export function resolveDocumentAsset(src: string | URL, packageRoot: string): string {
  if (src instanceof URL || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(src)) {
    const url = src instanceof URL ? src : new URL(src);
    if (url.protocol !== "file:") {
      throw new Error(`web.icons src must be a local file path or file: URL; received ${url.protocol} URL`);
    }
    return fileURLToPath(url);
  }
  return isAbsolute(src) ? src : resolve(packageRoot, src);
}

export function iconConfig(value: string | URL | WebAppIconConfig | undefined): WebAppIconConfig | undefined {
  if (!value) return undefined;
  return typeof value === "object" && !(value instanceof URL) && "src" in value ? value : { src: value };
}

export function pathExtension(path: string): string {
  const pathname = path.includes("://") ? new URL(path).pathname : path;
  const match = pathname.match(/\.([A-Za-z0-9]+)$/);
  return match ? `.${match[1]}` : "";
}

function contentTypeForIcon(path: string, explicit?: string): string {
  if (explicit) return explicit;
  const ext = pathExtension(path).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

export function pwaEnabled(web: WebAppDocumentConfig): boolean {
  return typeof web.pwa === "object" ? web.pwa.enabled !== false : web.pwa !== false;
}

function pwaConfig(web: WebAppDocumentConfig): WebAppPwaConfig {
  return typeof web.pwa === "object" ? web.pwa : {};
}

export interface WebAppDocumentAssets {
  icon: string;
  manifest: string;
  faviconPath: string;
  appleTouchPath: string;
  artifacts: WebAppPublicAssetArtifact[];
}

export async function generateWebAppDocumentAssets(
  appName: string,
  web: WebAppDocumentConfig,
  packageRoot: string,
): Promise<WebAppDocumentAssets> {
  const words = appName.match(/[A-Za-z0-9]+/g) ?? [];
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "W";
  const themeColor = web.themeColor ?? DEFAULT_THEME_COLOR;
  const backgroundColor = web.backgroundColor ?? DEFAULT_BACKGROUND_COLOR;
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${escapeAttribute(appName)}">
  <rect width="512" height="512" rx="112" fill="${escapeAttribute(themeColor)}"/>
  <circle cx="256" cy="256" r="178" fill="${escapeAttribute(backgroundColor)}" opacity="0.14"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" fill="${escapeAttribute(backgroundColor)}" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="176" font-weight="800">${escapeHtml(initials)}</text>
</svg>
`;
  const artifacts: WebAppPublicAssetArtifact[] = [{
    path: "/webapp-icon.svg",
    contentType: "image/svg+xml; charset=utf-8",
    kind: "asset",
    content: new TextEncoder().encode(icon),
  }];
  const addIcon = async (config: WebAppIconConfig, name: string): Promise<string> => {
    const file = resolveDocumentAsset(config.src, packageRoot);
    const path = `/${name}${pathExtension(file) || ".png"}`;
    artifacts.push({
      path,
      kind: "asset",
      contentType: contentTypeForIcon(file, config.type),
      content: new Uint8Array(await Bun.file(file).arrayBuffer()),
    });
    return path;
  };
  const favicon = iconConfig(web.icons?.favicon);
  const appleTouch = iconConfig(web.icons?.appleTouch) ?? favicon;
  const faviconPath = favicon ? await addIcon(favicon, "webapp-favicon") : "/webapp-icon.svg";
  const appleTouchPath = appleTouch ? await addIcon(appleTouch, "webapp-apple-touch-icon") : faviconPath;
  const manifestIcons = [];
  for (const [index, config] of (web.icons?.manifest ?? []).entries()) {
    const path = await addIcon(config, `webapp-icon-${index + 1}`);
    manifestIcons.push({
      src: `.${path}`,
      sizes: config.sizes ?? "any",
      type: contentTypeForIcon(path, config.type),
      purpose: config.purpose ?? "any maskable",
    });
  }
  if (manifestIcons.length === 0) {
    manifestIcons.push({ src: "./webapp-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" });
  }
  const pwa = pwaConfig(web);
  const manifest = pwaEnabled(web) ? JSON.stringify({
    name: appName,
    short_name: web.shortName ?? appName,
    start_url: pwa.startUrl ?? "./",
    scope: pwa.scope ?? "./",
    display: pwa.display ?? "standalone",
    background_color: backgroundColor,
    ...(web.themeColor ? { theme_color: web.themeColor } : {}),
    icons: manifestIcons,
  }, null, 2) : "";
  if (manifest) {
    for (const path of ["/site.webmanifest", "/manifest.webmanifest"]) {
      artifacts.push({
        path,
        kind: "asset",
        contentType: "application/manifest+json; charset=utf-8",
        content: new TextEncoder().encode(manifest),
      });
    }
  }
  return { icon, manifest, faviconPath, appleTouchPath, artifacts };
}

function themeBootScript(themeColor: string | undefined): string {
  const themeColorUpdate = themeColor
    ? `
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor instanceof HTMLMetaElement) metaThemeColor.content = resolved === "dark" ? ${JSON.stringify(themeColor)} : ${JSON.stringify(DEFAULT_BACKGROUND_COLOR)};`
    : "";
  return `(() => {
  const key = "webapp.theme";
  const root = document.documentElement;
  let stored = null;
  try {
    const storage = window.localStorage;
    if (storage && typeof storage.getItem === "function") stored = storage.getItem(key);
  } catch {
    stored = null;
  }
  const preference = stored === "light" || stored === "dark" || stored === "system" ? stored : ${JSON.stringify(DEFAULT_THEME_PREFERENCE)};
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  root.dataset.theme = preference;
  root.dataset.resolvedTheme = resolved;
${themeColorUpdate}
})();`;
}

export interface GenerateWebAppHtmlOptions {
  appName: string;
  web: WebAppDocumentConfig;
  faviconPath: string;
  appleTouchPath: string;
  scripts: string[];
  styles?: string[];
  relativeAssets?: boolean;
  /** Keep Bun's HTML importer from relocating the manifest away from its icons. */
  nativeBundle?: boolean;
}

export function generateWebAppHtml(options: GenerateWebAppHtmlOptions): string {
  const { appName, web, faviconPath, appleTouchPath } = options;
  const assetUrl = (path: string): string => options.relativeAssets ? path.replace(/^\//, "./") : path;
  const styleTags = (options.styles ?? []).map((path) => `    <link rel="stylesheet" href="${escapeAttribute(assetUrl(path))}" />`).join("\n");
  const scriptTags = options.scripts.map((path) => `    <script type="module" src="${escapeAttribute(assetUrl(path))}"></script>`).join("\n");
  const themeMetaTag = web.themeColor ? `    <meta name="theme-color" content="${escapeAttribute(web.themeColor)}" />\n` : "";
  const manifestTags = pwaEnabled(web)
    ? `    <link rel="icon" href="${escapeAttribute(faviconPath.replace(/^\//, "./"))}" />
    <link rel="apple-touch-icon" href="${escapeAttribute(appleTouchPath.replace(/^\//, "./"))}" />
${options.nativeBundle ? `    <script>(() => {
      const manifest = document.createElement("link");
      manifest.rel = "manifest";
      manifest.href = "./site.webmanifest";
      document.head.appendChild(manifest);
    })();</script>` : `    <link rel="manifest" href="./site.webmanifest" />`}
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="${escapeAttribute(web.shortName ?? appName)}" />
`
    : "";
  return `<!doctype html>
<html lang="${escapeAttribute(web.lang ?? "en")}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
${themeMetaTag}${manifestTags}    <title>${escapeHtml(web.title ?? appName)}</title>
    <script>(() => {
  const root = document.documentElement;
  const query = window.matchMedia(${JSON.stringify(MOBILE_MEDIA_QUERY)});
  root.toggleAttribute(${JSON.stringify(MOBILE_STATE_ATTRIBUTE)}, query.matches);
})();</script>
    <script>${themeBootScript(web.themeColor)}</script>
${styleTags}
  </head>
  <body>
    <div id="root"></div>
${scriptTags}
  </body>
</html>
`;
}
