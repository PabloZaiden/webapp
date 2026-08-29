import { createDeviceCredentialsStore } from "../../src/cli/device-auth";

const home = process.env["CLI_LOCK_HOLDER_HOME"];
const baseUrl = process.env["CLI_LOCK_HOLDER_BASE_URL"];
if (!home || !baseUrl) {
  throw new Error("CLI lock holder configuration is missing");
}

const store = createDeviceCredentialsStore({
  appDirectoryName: "credentials",
  home,
});

await store.withLock!(async () => {
  const response = await fetch(`${baseUrl}/holder-ready`);
  if (!response.ok) {
    throw new Error(`Lock holder coordination failed with status ${response.status}`);
  }
  await new Promise<void>(() => {});
});
