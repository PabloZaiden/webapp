import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { WebAppDocumentConfig } from "../server/server-types";
import { assertUniquePublicAssetPaths } from "../server/public-asset-manifest";
import { generateWebAppDocumentAssets, generateWebAppHtml } from "../web-document";
import { WEB_APP_CLIENT_CONFIG_PATH, type WebAppClientBootstrap } from "../contracts/client-bootstrap";
import { buildWebAppBrowser, localBuildPath, type WebAppBrowserBuild, type WebAppBrowserBuildOptions, type WebAppBrowserAsset, type WebAppStaticAssetOptions } from "./build-browser";
import type { WebAppPublicAssetOptions } from "./public-assets";

export interface BuildWebAppClientOptions extends Omit<WebAppDocumentConfig, "entry" | "mode"> {
  entry: string | URL;
  outdir: string;
  appName: string;
  /** Public, nonsecret default. Users can choose another endpoint at runtime. */
  apiBaseUrl?: string;
  define?: Record<string, string>;
  build?: WebAppBrowserBuildOptions;
  publicAssets?: WebAppPublicAssetOptions[];
  assets?: WebAppStaticAssetOptions[];
}

/** Build a complete browser-only directory, relocatable without a base-path rebuild. */
export async function buildWebAppClient(options: BuildWebAppClientOptions): Promise<WebAppBrowserBuild> {
  const browser = await buildWebAppBrowser({
    ...options,
    entry: localBuildPath(options.entry),
  });
  const document = await generateWebAppDocumentAssets(options.appName, options, browser.packageRoot);
  const html = generateWebAppHtml({
    appName: options.appName,
    web: options,
    ...document,
    relativeAssets: true,
    scripts: browser.assets.filter((asset) => asset.role === "script")
      .sort((left, right) => (left.scriptOrder ?? 0) - (right.scriptOrder ?? 0))
      .map((asset) => asset.path),
    styles: browser.assets.filter((asset) => asset.role === "style").map((asset) => asset.path),
  });
  const bootstrap: WebAppClientBootstrap = {
    mode: "remote",
    ...(options.apiBaseUrl === undefined ? {} : { apiBaseUrl: options.apiBaseUrl }),
  };
  const assets: WebAppBrowserAsset[] = [
    ...browser.assets,
    ...document.artifacts.map((artifact) => ({ ...artifact, role: "asset" as const })),
    {
      path: WEB_APP_CLIENT_CONFIG_PATH, role: "asset", kind: "asset",
      contentType: "application/json; charset=utf-8",
      content: new TextEncoder().encode(JSON.stringify(bootstrap)),
    },
    {
      path: "/index.html", role: "asset", kind: "asset", contentType: "text/html; charset=utf-8",
      content: new TextEncoder().encode(html),
    },
  ];
  const artifacts = [...assets, ...browser.publicAssetBundles.flatMap((bundle) => bundle.artifacts)];
  assertUniquePublicAssetPaths(artifacts.map((asset) => asset.path), "static client output");
  const outdir = resolve(options.outdir);
  mkdirSync(outdir, { recursive: true });
  for (const artifact of artifacts) {
    await Bun.write(resolve(outdir, artifact.path.slice(1)), artifact.content);
  }
  return { ...browser, assets };
}
