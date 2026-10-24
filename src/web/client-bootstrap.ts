import { createElement } from "react";
import { WEB_APP_CLIENT_CONFIG_PATH, webAppClientBootstrapSchema } from "../contracts/client-bootstrap";
import { configureWebAppClient } from "./api-client";
import { ErrorState } from "./components";
import { renderWebApp } from "./render";

/** Read deployment configuration before importing application-owned modules. */
export async function initializeWebAppClient(): Promise<void> {
  try {
    const response = await fetch(new URL(`.${WEB_APP_CLIENT_CONFIG_PATH}`, document.baseURI), {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Client configuration returned HTTP ${response.status}.`);
    configureWebAppClient(webAppClientBootstrapSchema.parse(await response.json()));
  } catch (error) {
    renderWebApp(createElement(ErrorState, {
      title: "Unable to start application",
      description: "Client configuration could not be loaded. Check the deployment and reload.",
    }));
    throw new Error("Unable to initialize the web client.", { cause: error });
  }
}
