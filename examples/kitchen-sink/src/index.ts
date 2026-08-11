import { createWebAppCli } from "@pablozaiden/webapp/cli";
import { createRouteCatalog } from "@pablozaiden/webapp/server";
import {
  createKitchenSinkRuntime,
  kitchenSinkVersion,
} from "./app";

export { createKitchenSinkApp } from "./app";

export function createKitchenSinkCli() {
  let runtime: ReturnType<typeof createKitchenSinkRuntime> | undefined;
  const getRuntime = () => runtime ??= createKitchenSinkRuntime();
  return createWebAppCli({
    appName: "Kitchen Sink",
    commandName: "kitchen-sink",
    envPrefix: "KITCHEN_SINK",
    version: kitchenSinkVersion,
    realtimePath: "/api/ws",
    start: async () => {
      await getRuntime().app.start();
    },
    routeCatalog: () => createRouteCatalog(getRuntime().routes),
  });
}

if (import.meta.main) {
  process.exitCode = await createKitchenSinkCli().run();
}
