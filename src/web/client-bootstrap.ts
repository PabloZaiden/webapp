import { createElement } from "react";
import { WEB_APP_CLIENT_CONFIG_PATH, webAppClientBootstrapSchema, type WebAppClientBootstrap } from "../contracts/client-bootstrap";
import { configureWebAppClient, type WebAppClientOptions } from "./api-client";
import { ErrorState } from "./components";
import { renderWebApp } from "./render";
import { initializeWebAppTheme } from "./theme";

let bootstrap: WebAppClientBootstrap | undefined;
export function getWebAppClientBootstrap(): WebAppClientBootstrap | undefined { return bootstrap; }

/** Read deployment configuration before importing application-owned modules. */
export async function initializeWebAppClient(options?: WebAppClientOptions): Promise<WebAppClientBootstrap | undefined> {
  try {
    if (options) {
      configureWebAppClient(options);
      initializeWebAppTheme();
      return bootstrap;
    }
    const response = await fetch(new URL(`.${WEB_APP_CLIENT_CONFIG_PATH}`, document.baseURI), {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Client configuration returned HTTP ${response.status}.`);
    bootstrap = webAppClientBootstrapSchema.parse(await response.json());
    configureWebAppClient(bootstrap);
    initializeWebAppTheme();
    return bootstrap;
  } catch (error) {
    renderWebApp(createElement(ErrorState, {
      title: "Unable to start application",
      description: "Client configuration could not be loaded. Check the deployment and reload.",
    }));
    throw new Error("Unable to initialize the web client.", { cause: error });
  }
}
