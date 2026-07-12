import { createDeviceCredentialsStore, refreshDeviceCredentials } from "../../src/cli/device-auth";

const home = process.env["CLI_LOCK_TEST_HOME"];
const baseUrl = process.env["CLI_LOCK_TEST_BASE_URL"];
if (!home || !baseUrl) {
  throw new Error("CLI lock worker configuration is missing");
}

const store = createDeviceCredentialsStore({
  appDirectoryName: "credentials",
  home,
});
await fetch(`${baseUrl}/worker-started`);
const current = await store.read();
if (!current) {
  throw new Error("CLI lock worker could not read credentials");
}

const refreshed = await refreshDeviceCredentials({
  credentials: current,
  store,
});
if (!refreshed || refreshed.refreshToken !== "new-refresh") {
  throw new Error("CLI lock worker did not use refreshed credentials");
}

process.stdout.write("ok\n");
