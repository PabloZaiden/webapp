import { createKitchenSinkApp } from "./app";

export { createKitchenSinkApp } from "./app";

export const app = createKitchenSinkApp();

if (import.meta.main) {
  await app.runFromCli();
}
